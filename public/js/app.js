/* =========================================================
   Dojo Duel — client
   ========================================================= */
import { play, confetti } from './fx.js';

// ---------- Small helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
const CHOICES = ['rock', 'paper', 'scissors'];
const KEYMAP = { r: 'rock', p: 'paper', s: 'scissors', 1: 'rock', 2: 'paper', 3: 'scissors' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const VERB = { rock: 'crushes', paper: 'covers', scissors: 'cut' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const TIERS = [
  { name: 'Bronze', min: 0 },
  { name: 'Silver', min: 950 },
  { name: 'Gold', min: 1100 },
  { name: 'Platinum', min: 1250 },
  { name: 'Diamond', min: 1400 }
];
function tierOf(rating) {
  let i = TIERS.length - 1;
  while (i > 0 && rating < TIERS[i].min) i--;
  return { ...TIERS[i], cls: TIERS[i].name.toLowerCase(), next: TIERS[i + 1] || null };
}
const tierBadge = (rating) => { const t = tierOf(rating); return `<span class="tier tier--${t.cls}">${t.name}</span>`; };

function hue(name) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatar(name, size = '', status = '') {
  return `<span class="avatar ${size ? 'avatar--' + size : ''}" style="--h:${hue(name)}">${esc(name[0] || '?')}${status ? `<i class="status ${status}"></i>` : ''}</span>`;
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}
const deltaPill = (d) => `<span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : 'flat'}">${d > 0 ? '+' : ''}${d}</span>`;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3600);
}

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
};

// ---------- State ----------
const S = {
  me: null,
  socket: null,
  status: 'idle',
  queueSince: 0,
  players: [],
  invitesIn: new Map(),
  invitesOut: new Map(),
  match: null,
  matchEnd: null,
  reveal: null,
  arenaKey: '',
  clockDeadline: 0,
  lastTick: -1,
  route: { name: 'lobby' },
  practice: { you: 0, cpu: 0, draw: 0, busy: false }
};

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  storage.set('dojo-theme', theme);
}
applyTheme(storage.get('dojo-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// =========================================================
// AUTH
// =========================================================
let authMode = 'login';
const authForm = $('#authForm');

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('[data-auth-tab]').forEach(t => {
    const on = t.dataset.authTab === mode;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('.tabs').dataset.active = mode;
  const reg = mode === 'register';
  $('#authHeading').textContent = reg ? 'Join the dojo' : 'Welcome back';
  $('#authSub').textContent = reg ? 'Create an account and start climbing.' : 'Step back into the dojo.';
  $('#authSubmit span').textContent = reg ? 'Create account' : 'Sign in';
  $('#confirmField').hidden = !reg;
  authForm.password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
}
document.querySelectorAll('[data-auth-tab]').forEach(t => t.addEventListener('click', () => setAuthMode(t.dataset.authTab)));

$('#togglePass').addEventListener('click', () => {
  const show = authForm.password.type === 'password';
  authForm.password.type = show ? 'text' : 'password';
  authForm.confirm.type = show ? 'text' : 'password';
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = authForm.username.value.trim();
  const password = authForm.password.value;
  const err = $('#authError');
  err.textContent = '';

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) { err.textContent = 'Username must be 3–20 letters, numbers or underscores.'; return; }
  if (password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
  if (authMode === 'register' && password !== authForm.confirm.value) { err.textContent = "Passwords don't match."; return; }

  const btn = $('#authSubmit');
  btn.disabled = true;
  try {
    const { user } = await api(authMode === 'register' ? '/api/register' : '/api/login', { username, password });
    authForm.reset();
    enterApp(user);
    if (authMode === 'register') toast(`Welcome to the dojo, ${user.username}!`, 'success');
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

function showAuth() {
  $('#appView').hidden = true;
  $('#authView').hidden = false;
  $('#invites').innerHTML = '';
  setAuthMode(authMode);
  setTimeout(() => authForm.username.focus(), 50);
}

// =========================================================
// APP SHELL
// =========================================================
function enterApp(user) {
  S.me = user;
  $('#authView').hidden = true;
  $('#appView').hidden = false;
  renderUserChip();
  connectSocket();
  if (!location.hash || location.hash === '#/') location.hash = '#/lobby';
  route();
}

function renderUserChip() {
  const me = S.me;
  $('#userChip').innerHTML = `${avatar(me.username, 'sm')}
    <span class="user-chip-text"><span class="user-chip-name">${esc(me.username)}</span><span class="user-chip-rating">${me.rating} · ${tierOf(me.rating).name}</span></span>`;
  $('#menuProfile').href = `#/profile/${encodeURIComponent(me.username)}`;
}

const userMenu = $('#userMenu');
$('#userChip').addEventListener('click', (e) => {
  e.stopPropagation();
  userMenu.hidden = !userMenu.hidden;
  $('#userChip').setAttribute('aria-expanded', String(!userMenu.hidden));
});
document.addEventListener('click', () => { userMenu.hidden = true; });
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  S.socket?.disconnect();
  Object.assign(S, { me: null, socket: null, match: null, matchEnd: null, status: 'idle' });
  S.invitesIn.clear(); S.invitesOut.clear();
  $('#overlay')?.remove();
  history.replaceState(null, '', '#/');
  showAuth();
});

// ---------- Routing ----------
window.addEventListener('hashchange', route);

function route() {
  if (!S.me) return;
  const [, name = 'lobby', arg] = location.hash.split('/');
  S.route = { name, arg: arg && decodeURIComponent(arg) };

  if (name === 'match' && !S.match) { location.hash = '#/lobby'; return; }

  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('is-active', a.dataset.route === name));
  updateBanner();

  const view = $('#view');
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
  stopClock();

  switch (name) {
    case 'leaderboard': return renderLeaderboard();
    case 'profile': return renderProfile(S.route.arg || S.me.username);
    case 'practice': return renderPractice();
    case 'match': return renderMatch();
    default: return renderLobby();
  }
}

function updateBanner() {
  $('#matchBanner').hidden = !(S.match && !S.matchEnd && S.route.name !== 'match');
}

// =========================================================
// SOCKET
// =========================================================
function connectSocket() {
  if (S.socket) S.socket.disconnect();
  const socket = io({ transports: ['websocket', 'polling'] });
  S.socket = socket;
  const dot = $('#connDot');

  socket.on('connect', () => { dot.className = 'conn is-on'; dot.title = 'Connected'; });
  socket.on('disconnect', () => { dot.className = 'conn is-off'; dot.title = 'Reconnecting…'; });
  socket.on('connect_error', (err) => {
    dot.className = 'conn is-off';
    if (err.message === 'unauthorized') { socket.disconnect(); S.me = null; toast('Your session expired — please sign in again.', 'warn'); showAuth(); }
  });

  socket.on('toast', ({ message, type }) => toast(message, type));

  socket.on('lobby:players', (players) => {
    S.players = players;
    const meRow = players.find(p => p.id === S.me.id);
    if (meRow && meRow.rating !== S.me.rating) { S.me.rating = meRow.rating; renderUserChip(); }
    if (S.route.name === 'lobby') renderPlayers();
  });

  socket.on('me:status', ({ status }) => {
    if (status === 'queue' && S.status !== 'queue') S.queueSince = Date.now();
    S.status = status;
    if (S.route.name === 'lobby') { renderPlayCard(); renderPlayers(); }
  });

  socket.on('challenge:incoming', (inv) => { S.invitesIn.set(inv.id, inv); play('invite'); renderInvites(); });
  socket.on('challenge:sent', (inv) => { S.invitesOut.set(inv.id, inv); renderInvites(); if (S.route.name === 'lobby') renderPlayers(); });
  socket.on('challenge:closed', ({ id, reason }) => {
    const out = S.invitesOut.get(id);
    if (out) {
      const who = out.to?.username || 'Opponent';
      if (reason === 'declined') toast(`${who} declined your challenge.`, 'warn');
      else if (reason === 'expired') toast(`${who} didn't answer in time.`);
      else if (reason === 'unavailable' || reason === 'offline') toast(`${who} is no longer available.`);
    }
    S.invitesIn.delete(id);
    S.invitesOut.delete(id);
    renderInvites();
    if (S.route.name === 'lobby') renderPlayers();
  });

  socket.on('match:start', (m) => {
    const fresh = !S.match || S.match.id !== m.id;
    S.match = m;
    S.matchEnd = null;
    if (fresh) { S.reveal = null; S.arenaKey = ''; play('found'); }
    $('#overlay')?.remove();
    if (location.hash !== '#/match') location.hash = '#/match';
    else renderMatch();
  });

  socket.on('match:state', (m) => {
    if (!S.match || S.match.id !== m.id) return;
    S.match = m;
    if (m.phase === 'pick') S.clockDeadline = performance.now() + m.remainingMs;
    if (S.route.name === 'match') updateMatch();
  });

  socket.on('match:round', (r) => {
    S.reveal = r;
    play(r.outcome);
    if (r.outcome === 'win') confetti(40);
  });

  socket.on('match:end', (end) => {
    S.matchEnd = end;
    S.me.rating = end.rating;
    if (end.result === 'win') S.me.wins++; else if (end.result === 'lose') S.me.losses++; else S.me.draws++;
    renderUserChip();
    updateBanner();
    setTimeout(() => {
      if (S.matchEnd !== end) return;
      if (S.route.name !== 'match') location.hash = '#/match';
      showResult(end);
    }, 300);
  });
}

// =========================================================
// INVITES
// =========================================================
function renderInvites() {
  const box = $('#invites');
  const now = Date.now();
  const incoming = [...S.invitesIn.values()].map(inv => `
    <div class="invite glass" data-id="${esc(inv.id)}">
      <div class="invite-head">
        ${avatar(inv.from.username)}
        <div><b>${esc(inv.from.username)} challenges you!</b><small>${inv.from.rating} · ${tierOf(inv.from.rating).name} · Best of 3</small></div>
      </div>
      <div class="invite-actions">
        <button class="btn btn-success" data-accept>${icon('check')} Accept</button>
        <button class="btn btn-ghost" data-decline>Decline</button>
      </div>
      <span class="invite-timer" style="animation-duration:${Math.max(0, inv.expiresAt - now)}ms"></span>
    </div>`).join('');
  const outgoing = [...S.invitesOut.values()].map(inv => `
    <div class="invite outgoing glass" data-id="${esc(inv.id)}">
      <div class="invite-head">
        ${icon('swords')}
        <div><b>Challenge sent to ${esc(inv.to?.username)}</b><small>Waiting for them to accept…</small></div>
      </div>
      <div class="invite-actions"><button class="btn btn-ghost btn-sm" data-cancel>Cancel</button></div>
      <span class="invite-timer" style="animation-duration:${Math.max(0, inv.expiresAt - now)}ms"></span>
    </div>`).join('');
  box.innerHTML = incoming + outgoing;
}

$('#invites').addEventListener('click', (e) => {
  const card = e.target.closest('.invite');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('[data-accept]')) S.socket.emit('challenge:respond', { id, accept: true });
  else if (e.target.closest('[data-decline]')) S.socket.emit('challenge:respond', { id, accept: false });
  else if (e.target.closest('[data-cancel]')) S.socket.emit('challenge:cancel', { id });
});

function challenge(username) {
  S.socket.emit('challenge:send', { username });
}

// =========================================================
// LOBBY
// =========================================================
let queueTimer = null;

function renderLobby() {
  $('#view').innerHTML = `
    <div class="page-head">
      <div>
        <span class="eyebrow">Lobby</span>
        <h1>Welcome back, <span class="gradient-text">${esc(S.me.username)}</span></h1>
        <p>Pick an opponent from the list, or let the dojo find one for you.</p>
      </div>
    </div>
    <div class="lobby">
      <section class="play-card glass" id="playCard"></section>
      <section class="stats-card card glass" id="statsCard"></section>
      <section class="players-card card glass">
        <div class="card-title"><h3>Online now</h3><span class="count-pill" id="onlineCount">0</span></div>
        <label class="search">${icon('search')}<input id="playerSearch" placeholder="Search players…" autocomplete="off"></label>
        <ul class="player-list" id="playerList"></ul>
      </section>
    </div>`;
  $('#playerSearch').addEventListener('input', renderPlayers);
  $('#playerList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-challenge]');
    if (btn) return challenge(btn.dataset.challenge);
    const row = e.target.closest('[data-user]');
    if (row) location.hash = `#/profile/${encodeURIComponent(row.dataset.user)}`;
  });
  renderPlayCard();
  renderStats();
  renderPlayers();

  // Refresh my stats from the server.
  api(`/api/users/${encodeURIComponent(S.me.username)}`).then(d => {
    Object.assign(S.me, d.user);
    S.me.rank = d.rank;
    renderUserChip();
    if (S.route.name === 'lobby') renderStats();
  }).catch(() => {});
}

function renderPlayCard() {
  const card = $('#playCard');
  if (!card) return;
  clearInterval(queueTimer);

  if (S.status === 'queue') {
    card.innerHTML = `
      <div>
        <span class="eyebrow">Ranked · Best of 3</span>
        <h2>Searching for<br>an opponent…</h2>
        <p>We pair you with the closest rating available. Keep this tab open.</p>
      </div>
      <div class="play-actions">
        <div class="searching">
          <div class="radar"></div>
          <div class="searching-text"><strong>In queue</strong><span id="queueTime">0:00</span></div>
        </div>
        <button class="btn btn-ghost" id="leaveQueue">${icon('x')} Cancel</button>
      </div>
      ${orbit()}`;
    $('#leaveQueue').addEventListener('click', () => S.socket.emit('queue:leave'));
    const tick = () => {
      const s = Math.floor((Date.now() - S.queueSince) / 1000);
      const el = $('#queueTime');
      if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    queueTimer = setInterval(tick, 1000);
  } else if (S.status === 'match' && S.match) {
    card.innerHTML = `
      <div>
        <span class="eyebrow">Live</span>
        <h2>Your duel<br>is underway.</h2>
        <p>You're mid-match against ${esc(S.match.opp.username)}.</p>
      </div>
      <div class="play-actions"><a class="btn btn-primary btn-lg" href="#/match">${icon('swords')} Return to arena</a></div>
      ${orbit()}`;
  } else {
    card.innerHTML = `
      <div>
        <span class="eyebrow">Ranked · Best of 3</span>
        <h2>Ready for<br>your next duel?</h2>
        <p>First to two round wins takes the match. Wins raise your rating, losses cost you — choose wisely.</p>
      </div>
      <div class="play-actions">
        <button class="btn btn-primary btn-lg" id="quickBtn">${icon('bolt')} Find a match</button>
        <a class="btn btn-ghost btn-lg" href="#/practice">${icon('cpu')} Practice vs AI</a>
      </div>
      ${orbit()}`;
    $('#quickBtn').addEventListener('click', () => S.socket.emit('queue:join'));
  }
}

const orbit = () => `
  <div class="play-orbit" aria-hidden="true">
    <div class="ring"></div><div class="ring"></div>
    <div class="o-seal rock">${icon('rock')}</div>
    <div class="o-seal paper">${icon('paper')}</div>
    <div class="o-seal scissors">${icon('scissors')}</div>
  </div>`;

function renderStats() {
  const card = $('#statsCard');
  if (!card) return;
  const me = S.me;
  const t = tierOf(me.rating);
  const played = me.wins + me.losses + me.draws;
  const wr = played ? Math.round((me.wins / played) * 100) : 0;
  const pct = t.next ? Math.min(100, Math.max(4, ((me.rating - t.min) / (t.next.min - t.min)) * 100)) : 100;
  card.innerHTML = `
    <div class="card-title"><h3>Your record</h3>${me.rank ? `<span class="muted" style="font-weight:700;font-size:13px">Rank #${me.rank}</span>` : ''}</div>
    <div class="rating-row">
      <div class="rating-big">${me.rating}</div>
      <div class="rating-meta">${tierBadge(me.rating)}<span class="muted" style="font-size:12.5px;font-weight:600">Elo rating</span></div>
    </div>
    <div class="tier-progress">
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      <div class="labels"><span>${t.name}</span><span>${t.next ? `${t.next.min - me.rating} to ${t.next.name}` : 'Top tier'}</span></div>
    </div>
    <div class="stat-grid">
      <div class="stat win"><b>${me.wins}</b><span>Wins</span></div>
      <div class="stat lose"><b>${me.losses}</b><span>Losses</span></div>
      <div class="stat draw"><b>${me.draws}</b><span>Draws</span></div>
      <div class="stat"><b>${wr}%</b><span>Win rate</span></div>
    </div>`;
}

function renderPlayers() {
  const list = $('#playerList');
  if (!list) return;
  const q = ($('#playerSearch')?.value || '').trim().toLowerCase();
  const pendingTo = new Set([...S.invitesOut.values()].map(i => i.to?.username));
  const players = S.players.filter(p => !q || p.username.toLowerCase().includes(q));
  $('#onlineCount').textContent = S.players.length;

  if (S.players.length <= 1 && !q) {
    list.innerHTML = `<li class="empty">${icon('user')}<div><b>It's quiet in here.</b><br>You're the only one online. Open another browser window and register a second account to test a duel.</div></li>`;
  } else if (!players.length) {
    list.innerHTML = `<li class="empty">${icon('search')}No players match “${esc(q)}”.</li>`;
  } else {
    list.innerHTML = players.map((p, i) => {
      const self = p.id === S.me.id;
      const statusText = p.status === 'match' ? 'In a match' : p.status === 'queue' ? 'Searching' : 'Available';
      let action = '';
      if (!self) {
        if (pendingTo.has(p.username)) action = `<button class="btn btn-ghost" disabled>Sent</button>`;
        else action = `<button class="btn btn-ghost" data-challenge="${esc(p.username)}" ${p.status !== 'idle' || S.status !== 'idle' ? 'disabled' : ''}>${icon('swords')} Duel</button>`;
      }
      return `
        <li class="player" data-user="${esc(p.username)}" style="animation-delay:${Math.min(i, 10) * 30}ms; cursor:pointer">
          ${avatar(p.username, '', p.status === 'idle' ? 'idle' : p.status)}
          <div class="player-info">
            <div class="player-name">${esc(p.username)}${self ? '<span class="you-tag">YOU</span>' : ''}</div>
            <div class="player-sub">${p.rating}<i class="dot"></i>${tierOf(p.rating).name}<i class="dot"></i><span class="status-text ${p.status}">${statusText}</span></div>
          </div>
          ${action}
        </li>`;
    }).join('');
  }
}

// =========================================================
// MATCH
// =========================================================
const CIRC = 2 * Math.PI * 44;

function renderMatch() {
  if (!S.match) return;
  S.arenaKey = '';
  $('#view').innerHTML = `
    <div class="match">
      <section class="versus glass">
        <div class="fighter left" id="fYou"></div>
        <div class="clock" id="clock">
          <svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44" fill="none" stroke-width="6"/><circle class="prog" id="clockProg" cx="50" cy="50" r="44" fill="none" stroke-width="6" stroke-dasharray="${CIRC}" stroke-dashoffset="0"/></svg>
          <div class="clock-inner"><span class="clock-num" id="clockNum">–</span><span class="clock-label" id="clockLabel">Round</span></div>
        </div>
        <div class="fighter right" id="fOpp"></div>
      </section>
      <section class="arena glass" id="arena"></section>
      <section class="history glass">
        <div class="history-list" id="history"></div>
        <button class="btn btn-danger btn-sm" id="forfeitBtn">${icon('flag')} Forfeit</button>
      </section>
    </div>`;

  $('#forfeitBtn').addEventListener('click', () => {
    if (S.matchEnd) return;
    if (confirm('Forfeit this match? It counts as a loss.')) S.socket.emit('match:forfeit');
  });
  $('#arena').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-choice]');
    if (btn) choose(btn.dataset.choice);
  });

  if (S.match.phase === 'pick') S.clockDeadline = performance.now() + S.match.remainingMs;
  updateMatch();
  startClock();
  if (S.matchEnd) showResult(S.matchEnd, true);
}

function fighterHTML(p, side) {
  const m = S.match;
  const pips = Array.from({ length: m.winsNeeded }, (_, i) => `<span class="pip ${i < p.score ? 'on' : ''}"></span>`).join('');
  let lock = '';
  if (m.phase === 'pick') {
    if (side === 'opp' && !p.connected) lock = `<span class="lock-state off">Disconnected</span>`;
    else if (p.locked) lock = `<span class="lock-state on">${icon('check')} Locked in</span>`;
    else lock = `<span class="lock-state">${icon('clock')} Choosing…</span>`;
  } else {
    lock = `<span class="lock-state">&nbsp;</span>`;
  }
  return `
    ${avatar(p.username, 'lg')}
    <div class="fighter-info">
      <span class="fighter-name">${esc(p.username)}${side === 'you' ? ' <span class="muted" style="font-size:12px">(you)</span>' : ''}</span>
      <span class="fighter-rating">${p.rating} · ${tierOf(p.rating).name}</span>
      <div class="pips">${pips}</div>
      ${lock}
    </div>`;
}

function updateMatch() {
  const m = S.match;
  if (!m || !$('#arena')) return;
  $('#fYou').innerHTML = fighterHTML(m.you, 'you');
  $('#fOpp').innerHTML = fighterHTML(m.opp, 'opp');

  // History chips
  const mini = (c) => c ? `<svg class="mini ${c}"><use href="#i-${c}"/></svg>` : `<span class="mini">—</span>`;
  $('#history').innerHTML = m.history.length
    ? m.history.map((h, i) => `<span class="h-chip ${h.outcome}"><span class="r">R${i + 1}</span>${mini(h.you)}<span class="sep">VS</span>${mini(h.opp)}</span>`).join('')
    : `<span class="history-empty">Round history will appear here.</span>`;

  // Arena only re-renders when something visible changes (keeps animations from restarting).
  const key = `${m.round}|${m.phase === 'over' ? 'reveal' : m.phase}|${m.you.locked}|${m.opp.locked}|${m.opp.connected}`;
  if (key !== S.arenaKey) {
    S.arenaKey = key;
    $('#arena').innerHTML = m.phase === 'pick' ? pickHTML(m) : revealHTML(S.reveal || lastHistoryReveal(m));
  }
  if (m.phase !== 'pick') { $('#clockNum').textContent = m.round; $('#clockLabel').textContent = 'Round'; setClockFrac(1, false); }
  $('#forfeitBtn').disabled = m.phase === 'over' || !!S.matchEnd;
}

function lastHistoryReveal(m) {
  const h = m.history.at(-1);
  return h ? { ...h, round: m.history.length, timedOut: { you: !h.you, opp: !h.opp } } : null;
}

function choiceCards({ locked, picked }) {
  return `<div class="choices ${locked ? 'locked' : ''}">${CHOICES.map((c, i) => `
    <button class="choice ${c} ${picked === c ? 'picked' : ''}" data-choice="${c}" ${locked ? 'disabled' : ''} aria-label="${cap(c)}">
      ${picked === c ? `<span class="check">${icon('check')}</span>` : ''}
      <span class="choice-icon">${icon(c)}</span>
      <span class="choice-name">${cap(c)}</span>
      <kbd>${c[0].toUpperCase()} · ${i + 1}</kbd>
    </button>`).join('')}</div>`;
}

function pickHTML(m) {
  let prompt;
  if (m.you.locked) {
    prompt = m.opp.locked
      ? `Both locked in<small>Revealing…</small>`
      : `Locked in<small>Waiting for ${esc(m.opp.username)} to choose…</small>`;
  } else {
    prompt = `Round ${m.round}<small>${m.opp.locked ? `${esc(m.opp.username)} has chosen — your move!` : 'Choose your throw'}</small>`;
  }
  return `<div class="arena-prompt">${prompt}</div>${choiceCards({ locked: m.you.locked, picked: m.you.choice })}`;
}

function revealHTML(r, labels = { you: 'You', opp: S.match?.opp.username || 'Opponent' }) {
  if (!r) return `<div class="arena-prompt">Get ready…</div>`;
  const seal = (c, state) => c
    ? `<div class="big-seal ${c} ${state}">${icon(c)}</div>`
    : `<div class="big-seal none ${state}">?</div>`;
  const youState = r.outcome === 'win' ? 'winner' : r.outcome === 'lose' ? 'loser' : '';
  const oppState = r.outcome === 'lose' ? 'winner' : r.outcome === 'win' ? 'loser' : '';

  let title, sub;
  if (r.outcome === 'draw') {
    title = 'Draw';
    sub = r.you ? `Both threw ${cap(r.you)}` : 'Nobody chose in time';
  } else {
    const winnerChoice = r.outcome === 'win' ? r.you : r.opp;
    const loserChoice = r.outcome === 'win' ? r.opp : r.you;
    title = r.outcome === 'win' ? 'You take the round' : 'Round lost';
    sub = !loserChoice ? `${r.outcome === 'win' ? labels.opp : 'You'} ran out of time`
      : `${cap(winnerChoice)} ${VERB[winnerChoice]} ${cap(loserChoice)}`;
  }

  return `
    <div class="reveal">
      <div class="reveal-side left"><span class="reveal-tag">${esc(labels.you)}</span>${seal(r.you, youState)}</div>
      <div class="vs">VS</div>
      <div class="reveal-side right"><span class="reveal-tag">${esc(labels.opp)}</span>${seal(r.opp, oppState)}</div>
    </div>
    <div class="round-result ${r.outcome}">${title}<small>${esc(sub)}</small></div>`;
}

function choose(choice) {
  const m = S.match;
  if (!m || m.phase !== 'pick' || m.you.locked || !CHOICES.includes(choice)) return;
  S.socket.emit('match:choose', { choice });
  // Optimistic: show it locked right away; the server echoes the same state.
  m.you.locked = true;
  m.you.choice = choice;
  play('lock');
  updateMatch();
}

// ---------- Round clock ----------
let clockRaf = 0;
function setClockFrac(frac, urgent) {
  const prog = $('#clockProg');
  if (!prog) return;
  prog.style.strokeDashoffset = String(CIRC * (1 - frac));
  $('#clock').classList.toggle('urgent', urgent);
}
function startClock() {
  stopClock();
  const loop = () => {
    clockRaf = requestAnimationFrame(loop);
    const m = S.match;
    if (!m || m.phase !== 'pick' || !$('#clock')) return;
    const left = Math.max(0, S.clockDeadline - performance.now());
    const secs = Math.ceil(left / 1000);
    $('#clockNum').textContent = secs;
    $('#clockLabel').textContent = 'Seconds';
    setClockFrac(left / m.roundMs, secs <= 5);
    if (secs <= 3 && secs > 0 && secs !== S.lastTick && !m.you.locked) { S.lastTick = secs; play('tick'); }
  };
  loop();
}
function stopClock() { cancelAnimationFrame(clockRaf); S.lastTick = -1; }

// ---------- Result overlay ----------
function showResult(end, instant = false) {
  $('#overlay')?.remove();
  const titles = { win: 'Victory', lose: 'Defeat', draw: 'Draw' };
  const badges = { win: 'trophy', lose: 'flag', draw: 'swords' };
  const reasons = {
    forfeit: end.result === 'win' ? `${end.opponent} forfeited` : 'You forfeited',
    disconnect: end.result === 'win' ? `${end.opponent} left the dojo` : 'You were disconnected',
    rounds: 'Round limit reached',
    score: ''
  };
  const sub = [`vs ${end.opponent}`, reasons[end.reason]].filter(Boolean).join(' · ');

  const el = document.createElement('div');
  el.className = 'overlay';
  el.id = 'overlay';
  el.innerHTML = `
    <div class="result-card glass ${end.result}" role="dialog" aria-modal="true" aria-labelledby="resTitle">
      <div class="result-badge">${icon(badges[end.result])}</div>
      <div class="result-title" id="resTitle">${titles[end.result]}</div>
      <p class="result-sub">${esc(sub)}</p>
      <div class="result-score">${end.score.you}<span class="sep">:</span>${end.score.opp}</div>
      <div class="rating-change">
        ${tierBadge(end.rating)}
        <span class="num" id="ratingNum">${instant ? end.rating : end.ratingBefore}</span>
        ${deltaPill(end.ratingDelta)}
      </div>
      <div class="result-actions">
        <button class="btn btn-primary" id="rematchBtn">${icon('swords')} Rematch</button>
        <button class="btn btn-ghost" id="lobbyBtn">Back to lobby</button>
      </div>
    </div>`;
  document.body.append(el);

  const leave = () => {
    el.remove();
    S.match = null; S.matchEnd = null; S.reveal = null;
    updateBanner();
    location.hash = '#/lobby';
  };
  $('#lobbyBtn', el).addEventListener('click', leave);
  $('#rematchBtn', el).addEventListener('click', () => { const opp = end.opponent; leave(); setTimeout(() => challenge(opp), 150); });
  $('#rematchBtn', el).focus();

  if (instant) return;
  play(end.result === 'win' ? 'victory' : end.result === 'lose' ? 'defeat' : 'draw');
  if (end.result === 'win') { confetti(160); setTimeout(() => confetti(100), 450); }

  // Count the rating up/down.
  const from = end.ratingBefore, to = end.rating, t0 = performance.now(), dur = 1100;
  const step = (t) => {
    const k = Math.min(1, (t - t0 - 350) / dur);
    const e = k < 0 ? 0 : 1 - Math.pow(1 - k, 3);
    const n = $('#ratingNum', el);
    if (!n) return;
    n.textContent = Math.round(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// =========================================================
// LEADERBOARD
// =========================================================
async function renderLeaderboard() {
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Leaderboard</span><h1>Hall of Champions</h1><p>Top 50 ranked fighters by Elo rating.</p></div></div>
    <div id="lb"><div class="card glass empty">Loading…</div></div>`;
  let players;
  try { ({ players } = await api('/api/leaderboard')); }
  catch (e) { $('#lb').innerHTML = `<div class="card glass empty">${esc(e.message)}</div>`; return; }
  if (S.route.name !== 'leaderboard') return;

  if (!players.length) {
    $('#lb').innerHTML = `<div class="card glass empty" style="min-height:280px">${icon('trophy')}<div><b>No ranked matches yet.</b><br>Play the first duel to claim the throne.</div><a class="btn btn-primary" href="#/lobby">Go to lobby</a></div>`;
    return;
  }

  const wl = (p) => `${p.wins}W · ${p.losses}L${p.draws ? ` · ${p.draws}D` : ''}`;
  const top = players.slice(0, 3);
  const order = [top[1], top[0], top[2]];
  const podium = order.map((p, i) => {
    if (!p) return '<div></div>';
    const place = [2, 1, 3][i];
    return `
      <div class="podium-spot glass p${place}" data-user="${esc(p.username)}">
        <span class="place">${place}</span>
        ${avatar(p.username, place === 1 ? 'xl' : 'lg')}
        <span class="podium-name">${esc(p.username)}</span>
        <span class="podium-rating">${p.rating}</span>
        ${tierBadge(p.rating)}
        <span class="podium-wl">${wl(p)}</span>
      </div>`;
  }).join('');

  const rows = players.map((p, i) => {
    const played = p.wins + p.losses + p.draws;
    const wr = played ? Math.round((p.wins / played) * 100) : 0;
    return `
      <tr data-user="${esc(p.username)}" class="${p.id === S.me.id ? 'me' : ''}">
        <td class="rank-n">${i + 1}</td>
        <td><div class="who">${avatar(p.username, 'sm')}<b>${esc(p.username)}</b><span class="hide-sm">${tierBadge(p.rating)}</span></div></td>
        <td class="num rating-cell">${p.rating}</td>
        <td class="num hide-sm">${wl(p)}</td>
        <td class="num"><div class="winrate"><span class="bar hide-sm"><i style="width:${wr}%"></i></span>${wr}%</div></td>
      </tr>`;
  }).join('');

  $('#lb').innerHTML = `
    <div class="podium">${podium}</div>
    <div class="table-card glass">
      <table class="rank-table">
        <thead><tr><th>#</th><th>Player</th><th class="num">Rating</th><th class="num hide-sm">Record</th><th class="num">Win rate</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  $('#lb').addEventListener('click', (e) => {
    const u = e.target.closest('[data-user]');
    if (u) location.hash = `#/profile/${encodeURIComponent(u.dataset.user)}`;
  });
}

// =========================================================
// PROFILE
// =========================================================
async function renderProfile(username) {
  const view = $('#view');
  view.innerHTML = `<div class="card glass empty" style="min-height:300px">Loading…</div>`;
  let d;
  try { d = await api(`/api/users/${encodeURIComponent(username)}`); }
  catch (e) { view.innerHTML = `<div class="card glass empty" style="min-height:300px">${icon('user')}<b>${esc(e.message)}</b><a class="btn btn-ghost" href="#/lobby">Back to lobby</a></div>`; return; }
  if (S.route.name !== 'profile') return;

  const u = d.user;
  const isMe = u.id === S.me.id;
  if (isMe) { Object.assign(S.me, u); renderUserChip(); }
  const played = u.wins + u.losses + u.draws;
  const wr = played ? Math.round((u.wins / played) * 100) : 0;
  const online = S.players.find(p => p.id === u.id);
  const totalThrows = CHOICES.reduce((s, c) => s + d.throws[c], 0);
  const canDuel = !isMe && online && online.status === 'idle' && S.status === 'idle';

  view.innerHTML = `
    <section class="profile-head glass">
      ${avatar(u.username, 'xl', online ? (online.status === 'idle' ? 'idle' : online.status) : '')}
      <div class="who">
        <span class="eyebrow" style="margin:0">${isMe ? 'Your profile' : online ? 'Online now' : 'Offline'}</span>
        <h1>${esc(u.username)}</h1>
        <div class="meta">${tierBadge(u.rating)}${d.rank ? `<span>Rank #${d.rank}</span>` : '<span>Unranked</span>'}<span>Joined ${new Date(u.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span></div>
      </div>
      <div class="profile-rating"><div class="rating-big">${u.rating}</div><span>Elo rating</span></div>
      ${!isMe ? `<button class="btn btn-primary" id="profileDuel" ${canDuel ? '' : 'disabled'}>${icon('swords')} ${online ? 'Challenge' : 'Offline'}</button>` : ''}
    </section>

    <div class="profile-grid">
      <section class="card glass">
        <div class="card-title"><h3>Record</h3></div>
        <div class="stat-grid">
          <div class="stat win"><b>${u.wins}</b><span>Wins</span></div>
          <div class="stat lose"><b>${u.losses}</b><span>Losses</span></div>
          <div class="stat draw"><b>${u.draws}</b><span>Draws</span></div>
          <div class="stat"><b>${wr}%</b><span>Win rate</span></div>
        </div>
        <div class="card-title" style="margin:28px 0 0"><h3>Throw style</h3><span class="muted" style="font-size:12.5px;font-weight:600">last ${d.matches.length} matches</span></div>
        <div class="throw-bars">
          ${CHOICES.map(c => {
            const pct = totalThrows ? Math.round((d.throws[c] / totalThrows) * 100) : 0;
            return `<div class="throw"><span class="ic ${c}">${icon(c)}</span><span class="bar"><i class="${c}" style="width:${pct}%"></i></span><span class="pct">${pct}%</span></div>`;
          }).join('')}
        </div>
      </section>

      <section class="card glass">
        <div class="card-title"><h3>Recent matches</h3></div>
        ${d.matches.length ? `<ul class="match-list">${d.matches.map(m => `
          <li class="m-row ${m.result}">
            <span class="stripe"></span>
            <a class="m-opp" href="#/profile/${encodeURIComponent(m.opponent)}">${avatar(m.opponent, 'sm')}<span><b>${m.result === 'win' ? 'Won' : m.result === 'lose' ? 'Lost' : 'Drew'} vs ${esc(m.opponent)}</b><small>${timeAgo(m.createdAt)}${m.reason === 'forfeit' ? ' · forfeit' : m.reason === 'disconnect' ? ' · disconnect' : ''}</small></span></a>
            <span class="m-score">${m.score[0]}–${m.score[1]}</span>
            ${deltaPill(m.delta)}
          </li>`).join('')}</ul>`
        : `<div class="empty">${icon('swords')}No matches played yet.</div>`}
      </section>
    </div>`;

  $('#profileDuel')?.addEventListener('click', () => { challenge(u.username); location.hash = '#/lobby'; });
}

// =========================================================
// PRACTICE (offline, vs AI)
// =========================================================
function renderPractice() {
  const p = S.practice;
  $('#view').innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Practice</span><h1>Train against the Dojo AI</h1><p>Unranked — sharpen your instincts. Keys: R · P · S</p></div></div>
    <div class="match">
      <div class="practice-score">
        <div class="stat win"><b id="pYou">${p.you}</b><span>You</span></div>
        <div class="stat draw"><b id="pDraw">${p.draw}</b><span>Draws</span></div>
        <div class="stat lose"><b id="pCpu">${p.cpu}</b><span>Dojo AI</span></div>
      </div>
      <section class="arena glass" id="pArena"></section>
    </div>`;
  showPracticePick();
  $('#pArena').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-choice]');
    if (btn) practiceChoose(btn.dataset.choice);
  });
}

function showPracticePick() {
  const a = $('#pArena');
  if (a) a.innerHTML = `<div class="arena-prompt">Make your move<small>The AI picks at random — or does it?</small></div>${choiceCards({ locked: false })}`;
}

function practiceChoose(choice) {
  const p = S.practice;
  if (p.busy || S.route.name !== 'practice') return;
  p.busy = true;
  const cpu = CHOICES[Math.floor(Math.random() * 3)];
  const outcome = choice === cpu ? 'draw' : BEATS[choice] === cpu ? 'win' : 'lose';
  if (outcome === 'win') p.you++; else if (outcome === 'lose') p.cpu++; else p.draw++;
  $('#pArena').innerHTML = revealHTML({ you: choice, opp: cpu, outcome }, { you: 'You', opp: 'Dojo AI' });
  $('#pYou').textContent = p.you; $('#pCpu').textContent = p.cpu; $('#pDraw').textContent = p.draw;
  play(outcome);
  if (outcome === 'win') confetti(50);
  setTimeout(() => { p.busy = false; if (S.route.name === 'practice') showPracticePick(); }, 1700);
}

// =========================================================
// KEYBOARD
// =========================================================
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea')) return;
  if (e.key === 'Escape') { userMenu.hidden = true; return; }
  const choice = KEYMAP[e.key.toLowerCase()];
  if (!choice || !S.me) return;
  if (S.route.name === 'match') choose(choice);
  else if (S.route.name === 'practice') practiceChoose(choice);
});

// =========================================================
// BOOT
// =========================================================
(async function boot() {
  try {
    const { user } = await api('/api/me');
    enterApp(user);
  } catch {
    showAuth();
  }
  const splash = $('#splash');
  splash.classList.add('is-gone');
  setTimeout(() => splash.remove(), 450);
})();
