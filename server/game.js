/* =========================================================
   Game server — presence, matchmaking, challenges, duels
   The server is authoritative: choices stay hidden until both
   players have locked in, and all scoring happens here.
   ========================================================= */
import crypto from 'node:crypto';
import { db, transaction } from './db.js';

export const CHOICES = ['rock', 'paper', 'scissors'];
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

const WINS_NEEDED = 2;          // best of 3 (draws replay)
const MAX_ROUNDS = 7;           // hard cap so a match can't go forever
const ROUND_MS = 15_000;        // time to pick each round
const REVEAL_MS = 2_600;        // pause after a round reveal
const RECONNECT_GRACE_MS = 20_000;
const INVITE_TTL_MS = 30_000;
const ELO_K = 32;

const updateUserStats = db.prepare(`
  UPDATE users SET rating = rating + ?, wins = wins + ?, losses = losses + ?, draws = draws + ?
  WHERE id = ?
`);
const insertMatch = db.prepare(`
  INSERT INTO matches (p1_id, p2_id, winner_id, p1_score, p2_score, p1_delta, p2_delta, rounds, end_reason, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectRating = db.prepare('SELECT rating FROM users WHERE id = ?');

function judge(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return BEATS[a] === b ? 1 : -1;
}

function eloDelta(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  return Math.round(ELO_K * (scoreA - expectedA));
}

export class GameServer {
  constructor(io) {
    this.io = io;
    /** userId -> { user, sockets:Set<string>, status:'idle'|'queue'|'match', matchId } */
    this.players = new Map();
    /** array of userIds waiting for a quick match */
    this.queue = [];
    /** inviteId -> { id, fromId, toId, timer } */
    this.invites = new Map();
    /** matchId -> Match */
    this.matches = new Map();
    this.lobbyDirty = false;
  }

  // ---------- Helpers ----------
  room(userId) { return `user:${userId}`; }
  emitTo(userId, event, payload) { this.io.to(this.room(userId)).emit(event, payload); }

  lobbySnapshot() {
    return [...this.players.values()].map(p => ({
      id: p.user.id,
      username: p.user.username,
      rating: p.user.rating,
      status: p.status
    })).sort((a, b) => b.rating - a.rating);
  }

  // Coalesce many lobby changes in one tick into a single broadcast.
  broadcastLobby() {
    if (this.lobbyDirty) return;
    this.lobbyDirty = true;
    setImmediate(() => {
      this.lobbyDirty = false;
      this.io.emit('lobby:players', this.lobbySnapshot());
    });
  }

  setStatus(userId, status, matchId = null) {
    const p = this.players.get(userId);
    if (!p) return;
    p.status = status;
    p.matchId = matchId;
    this.emitTo(userId, 'me:status', { status });
    this.broadcastLobby();
  }

  // ---------- Connection lifecycle ----------
  onConnect(socket) {
    const user = socket.data.user;
    socket.join(this.room(user.id));

    let p = this.players.get(user.id);
    if (!p) {
      p = { user, sockets: new Set(), status: 'idle', matchId: null };
      this.players.set(user.id, p);
    }
    p.sockets.add(socket.id);

    socket.emit('me:status', { status: p.status });
    socket.emit('lobby:players', this.lobbySnapshot());
    this.broadcastLobby();

    // Re-send any pending invites addressed to / sent by this user.
    for (const inv of this.invites.values()) {
      if (inv.toId === user.id) socket.emit('challenge:incoming', this.inviteView(inv));
      if (inv.fromId === user.id) socket.emit('challenge:sent', this.inviteView(inv));
    }

    // Rejoin an in-progress match.
    if (p.matchId && this.matches.has(p.matchId)) {
      this.matches.get(p.matchId).onReconnect(user.id);
    }

    socket.on('queue:join', () => this.joinQueue(user.id));
    socket.on('queue:leave', () => this.leaveQueue(user.id));
    socket.on('challenge:send', (data) => this.sendChallenge(user.id, data));
    socket.on('challenge:respond', (data) => this.respondChallenge(user.id, data));
    socket.on('challenge:cancel', (data) => this.cancelChallenge(user.id, data));
    socket.on('match:choose', (data) => this.withMatch(user.id, m => m.choose(user.id, data?.choice)));
    socket.on('match:forfeit', () => this.withMatch(user.id, m => m.forfeit(user.id)));
    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  onDisconnect(socket) {
    const userId = socket.data.user.id;
    const p = this.players.get(userId);
    if (!p) return;
    p.sockets.delete(socket.id);
    if (p.sockets.size > 0) return; // still connected in another tab

    this.leaveQueue(userId, true);
    for (const inv of [...this.invites.values()]) {
      if (inv.fromId === userId || inv.toId === userId) this.closeInvite(inv.id, 'offline');
    }

    if (p.matchId && this.matches.has(p.matchId)) {
      // Keep the player record so they can reconnect within the grace period.
      this.matches.get(p.matchId).onDisconnect(userId);
    } else {
      this.players.delete(userId);
    }
    this.broadcastLobby();
  }

  withMatch(userId, fn) {
    const p = this.players.get(userId);
    const m = p?.matchId && this.matches.get(p.matchId);
    if (m) fn(m);
  }

  // ---------- Quick match queue ----------
  joinQueue(userId) {
    const p = this.players.get(userId);
    if (!p || p.status !== 'idle') return;
    this.queue.push(userId);
    this.setStatus(userId, 'queue');
    this.tryMatchmake();
  }

  leaveQueue(userId, silent = false) {
    const i = this.queue.indexOf(userId);
    if (i < 0) return;
    this.queue.splice(i, 1);
    if (!silent) this.setStatus(userId, 'idle');
  }

  tryMatchmake() {
    // Pair players with the closest rating; anyone waiting is better off matched than not.
    while (this.queue.length >= 2) {
      const a = this.queue.shift();
      const ra = this.players.get(a).user.rating;
      let bestIdx = 0;
      let bestGap = Infinity;
      this.queue.forEach((id, idx) => {
        const gap = Math.abs(this.players.get(id).user.rating - ra);
        if (gap < bestGap) { bestGap = gap; bestIdx = idx; }
      });
      const [b] = this.queue.splice(bestIdx, 1);
      this.startMatch(a, b);
    }
  }

  // ---------- Challenges ----------
  inviteView(inv) {
    const from = this.players.get(inv.fromId)?.user;
    const to = this.players.get(inv.toId)?.user;
    return {
      id: inv.id,
      from: from && { username: from.username, rating: from.rating },
      to: to && { username: to.username, rating: to.rating },
      expiresAt: inv.expiresAt
    };
  }

  sendChallenge(fromId, data) {
    const username = typeof data?.username === 'string' ? data.username : '';
    const from = this.players.get(fromId);
    const target = [...this.players.values()].find(p => p.user.username.toLowerCase() === username.toLowerCase());

    const fail = (msg) => this.emitTo(fromId, 'toast', { type: 'error', message: msg });
    if (!from || from.status !== 'idle') return fail('Finish what you are doing first.');
    if (!target || target.sockets.size === 0) return fail(`${username || 'That player'} is not online.`);
    if (target.user.id === fromId) return fail("You can't challenge yourself.");
    if (target.status !== 'idle') return fail(`${target.user.username} is busy right now.`);
    for (const inv of this.invites.values()) {
      if (inv.fromId === fromId && inv.toId === target.user.id) return fail('Challenge already sent.');
    }

    const inv = {
      id: crypto.randomUUID(),
      fromId,
      toId: target.user.id,
      expiresAt: Date.now() + INVITE_TTL_MS
    };
    inv.timer = setTimeout(() => this.closeInvite(inv.id, 'expired'), INVITE_TTL_MS);
    this.invites.set(inv.id, inv);

    const view = this.inviteView(inv);
    this.emitTo(fromId, 'challenge:sent', view);
    this.emitTo(target.user.id, 'challenge:incoming', view);
  }

  respondChallenge(userId, data) {
    const inv = this.invites.get(data?.id);
    if (!inv || inv.toId !== userId) return;
    if (!data.accept) return this.closeInvite(inv.id, 'declined');

    const a = this.players.get(inv.fromId);
    const b = this.players.get(inv.toId);
    if (!a || !b || a.sockets.size === 0 || a.status !== 'idle' || b.status !== 'idle') {
      this.closeInvite(inv.id, 'unavailable');
      return;
    }
    this.closeInvite(inv.id, 'accepted');
    this.startMatch(inv.fromId, inv.toId);
  }

  cancelChallenge(userId, data) {
    const inv = this.invites.get(data?.id);
    if (inv && inv.fromId === userId) this.closeInvite(inv.id, 'cancelled');
  }

  closeInvite(id, reason) {
    const inv = this.invites.get(id);
    if (!inv) return;
    clearTimeout(inv.timer);
    this.invites.delete(id);
    const payload = { id, reason };
    this.emitTo(inv.fromId, 'challenge:closed', payload);
    this.emitTo(inv.toId, 'challenge:closed', payload);
  }

  // ---------- Matches ----------
  startMatch(aId, bId) {
    // A player entering a match can't keep other invites open.
    for (const inv of [...this.invites.values()]) {
      if ([aId, bId].includes(inv.fromId) || [aId, bId].includes(inv.toId)) this.closeInvite(inv.id, 'unavailable');
    }
    this.leaveQueue(aId, true);
    this.leaveQueue(bId, true);

    const match = new Match(this, this.players.get(aId).user, this.players.get(bId).user);
    this.matches.set(match.id, match);
    this.setStatus(aId, 'match', match.id);
    this.setStatus(bId, 'match', match.id);
    match.start();
  }

  finishMatch(match) {
    this.matches.delete(match.id);
    for (const pl of match.players) {
      const p = this.players.get(pl.user.id);
      if (!p) continue;
      p.user.rating = pl.newRating ?? p.user.rating;
      if (p.sockets.size === 0) {
        this.players.delete(pl.user.id);
      } else {
        this.setStatus(pl.user.id, 'idle');
      }
    }
    this.broadcastLobby();
  }
}

class Match {
  constructor(server, userA, userB) {
    this.server = server;
    this.id = crypto.randomUUID();
    this.players = [userA, userB].map(user => ({
      user: { id: user.id, username: user.username, rating: user.rating },
      score: 0,
      choice: null,
      connected: true,
      graceTimer: null,
      newRating: null
    }));
    this.round = 0;
    this.history = [];      // [{ choices: [a, b], winner: 0|1|null }]
    this.phase = 'pick';    // 'pick' | 'reveal' | 'over'
    this.deadline = 0;
    this.timer = null;
  }

  idx(userId) { return this.players.findIndex(p => p.user.id === userId); }

  /** Match state from one player's point of view. */
  viewFor(i) {
    const me = this.players[i];
    const opp = this.players[1 - i];
    return {
      id: this.id,
      round: this.round,
      phase: this.phase,
      remainingMs: this.phase === 'pick' ? Math.max(0, this.deadline - Date.now()) : 0,
      winsNeeded: WINS_NEEDED,
      maxRounds: MAX_ROUNDS,
      roundMs: ROUND_MS,
      you: { username: me.user.username, rating: me.user.rating, score: me.score, locked: me.choice !== null, choice: me.choice },
      opp: { username: opp.user.username, rating: opp.user.rating, score: opp.score, locked: opp.choice !== null, connected: opp.connected },
      history: this.history.map(h => ({
        you: h.choices[i],
        opp: h.choices[1 - i],
        outcome: h.winner === null ? 'draw' : (h.winner === i ? 'win' : 'lose')
      }))
    };
  }

  sendState() {
    this.players.forEach((p, i) => this.server.emitTo(p.user.id, 'match:state', this.viewFor(i)));
  }

  start() {
    this.players.forEach((p, i) => this.server.emitTo(p.user.id, 'match:start', this.viewFor(i)));
    this.nextRound();
  }

  nextRound() {
    if (this.phase === 'over') return;
    this.round++;
    this.phase = 'pick';
    this.players.forEach(p => { p.choice = null; });
    this.deadline = Date.now() + ROUND_MS;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.resolveRound(), ROUND_MS);
    this.sendState();
  }

  choose(userId, choice) {
    const i = this.idx(userId);
    if (i < 0 || this.phase !== 'pick' || !CHOICES.includes(choice)) return;
    if (this.players[i].choice !== null) return; // locked in
    this.players[i].choice = choice;
    if (this.players.every(p => p.choice !== null)) {
      this.resolveRound();
    } else {
      this.sendState();
    }
  }

  resolveRound() {
    if (this.phase !== 'pick') return;
    clearTimeout(this.timer);
    this.phase = 'reveal';

    const [a, b] = this.players;
    const r = judge(a.choice, b.choice);
    const winner = r === 0 ? null : (r > 0 ? 0 : 1);
    if (winner !== null) this.players[winner].score++;
    this.history.push({ choices: [a.choice, b.choice], winner });

    this.players.forEach((p, i) => {
      const last = this.viewFor(i).history.at(-1);
      this.server.emitTo(p.user.id, 'match:round', { ...last, round: this.round, timedOut: { you: p.choice === null, opp: this.players[1 - i].choice === null } });
    });
    this.sendState();

    const decided = this.players.some(p => p.score >= WINS_NEEDED);
    if (decided || this.round >= MAX_ROUNDS) {
      this.timer = setTimeout(() => {
        if (a.score === b.score) this.end(null, 'rounds');
        else this.end(a.score > b.score ? 0 : 1, 'score');
      }, REVEAL_MS);
    } else {
      this.timer = setTimeout(() => this.nextRound(), REVEAL_MS);
    }
  }

  forfeit(userId) {
    const i = this.idx(userId);
    if (i < 0 || this.phase === 'over') return;
    this.end(1 - i, 'forfeit');
  }

  onDisconnect(userId) {
    const i = this.idx(userId);
    if (i < 0 || this.phase === 'over') return;
    const p = this.players[i];
    p.connected = false;
    clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => this.end(1 - i, 'disconnect'), RECONNECT_GRACE_MS);
    this.server.emitTo(this.players[1 - i].user.id, 'toast', {
      type: 'warn',
      message: `${p.user.username} disconnected — they have ${RECONNECT_GRACE_MS / 1000}s to return.`
    });
    this.sendState();
  }

  onReconnect(userId) {
    const i = this.idx(userId);
    if (i < 0) return;
    const p = this.players[i];
    clearTimeout(p.graceTimer);
    if (!p.connected) {
      p.connected = true;
      this.server.emitTo(this.players[1 - i].user.id, 'toast', { type: 'info', message: `${p.user.username} is back.` });
    }
    this.server.emitTo(userId, 'match:start', this.viewFor(i));
    this.sendState();
  }

  end(winnerIdx, reason) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    clearTimeout(this.timer);
    this.players.forEach(p => clearTimeout(p.graceTimer));

    const [a, b] = this.players;
    // Use the freshest ratings from the DB in case they changed elsewhere.
    const ra = selectRating.get(a.user.id).rating;
    const rb = selectRating.get(b.user.id).rating;
    const scoreA = winnerIdx === null ? 0.5 : (winnerIdx === 0 ? 1 : 0);
    const deltaA = eloDelta(ra, rb, scoreA);
    const deltaB = eloDelta(rb, ra, 1 - scoreA);

    transaction(() => {
      updateUserStats.run(deltaA, scoreA === 1 ? 1 : 0, scoreA === 0 ? 1 : 0, scoreA === 0.5 ? 1 : 0, a.user.id);
      updateUserStats.run(deltaB, scoreA === 0 ? 1 : 0, scoreA === 1 ? 1 : 0, scoreA === 0.5 ? 1 : 0, b.user.id);
      insertMatch.run(
        a.user.id, b.user.id,
        winnerIdx === null ? null : this.players[winnerIdx].user.id,
        a.score, b.score, deltaA, deltaB,
        JSON.stringify(this.history.map(h => h.choices)),
        reason, Date.now()
      );
    });

    a.newRating = ra + deltaA;
    b.newRating = rb + deltaB;
    const deltas = [deltaA, deltaB];

    this.players.forEach((p, i) => {
      this.server.emitTo(p.user.id, 'match:end', {
        id: this.id,
        result: winnerIdx === null ? 'draw' : (winnerIdx === i ? 'win' : 'lose'),
        reason,
        score: { you: p.score, opp: this.players[1 - i].score },
        opponent: this.players[1 - i].user.username,
        ratingBefore: i === 0 ? ra : rb,
        ratingDelta: deltas[i],
        rating: p.newRating
      });
    });

    this.server.finishMatch(this);
  }
}
