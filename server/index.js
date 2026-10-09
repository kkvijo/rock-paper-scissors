/* =========================================================
   Dojo Duel — HTTP + WebSocket server
   ========================================================= */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

import { db, publicUser } from './db.js';
import {
  SESSION_COOKIE, USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX,
  hashPassword, verifyPassword, createSession, destroySession, userFromToken,
  sessionCookieOptions, parseCookies, tokenFromRequest, attachUser, requireUser, authRateLimit
} from './auth.js';
import { GameServer } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const SECURE_COOKIES = process.env.NODE_ENV === 'production';
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
// Behind a hosting proxy (Render, Railway…) set TRUST_PROXY=1 so req.ip is the real client IP.
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : 'loopback');
app.use(express.json({ limit: '10kb' }));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  next();
});
app.use(attachUser);

// ---------- Auth API ----------
const findUserByName = db.prepare('SELECT * FROM users WHERE username = ?');
const insertUser = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');

function validateCredentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!USERNAME_RE.test(username)) return { error: 'Username must be 3–20 characters: letters, numbers or _' };
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { error: `Password must be at least ${PASSWORD_MIN} characters` };
  }
  return { username, password };
}

function startSession(res, userId) {
  const token = createSession(userId);
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(SECURE_COOKIES));
}

app.post('/api/register', authRateLimit, async (req, res) => {
  const v = validateCredentials(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (findUserByName.get(v.username)) return res.status(409).json({ error: 'That username is taken' });

  const hash = await hashPassword(v.password);
  try {
    const { lastInsertRowid } = insertUser.run(v.username, hash, Date.now());
    startSession(res, Number(lastInsertRowid));
    res.status(201).json({ user: publicUser(findUserByName.get(v.username)) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That username is taken' });
    throw err;
  }
});

app.post('/api/login', authRateLimit, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const row = username && findUserByName.get(username);
  // Always run a hash comparison so response time doesn't reveal whether the user exists.
  const ok = row
    ? await verifyPassword(password, row.password_hash)
    : (await verifyPassword(password, '00'.repeat(16) + ':' + '00'.repeat(64)), false);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
  startSession(res, row.id);
  res.json({ user: publicUser(row) });
});

app.post('/api/logout', (req, res) => {
  destroySession(tokenFromRequest(req));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.user });
});

// ---------- Stats API ----------
const leaderboard = db.prepare(`
  SELECT id, username, rating, wins, losses, draws, created_at FROM users
  WHERE wins + losses + draws > 0
  ORDER BY rating DESC, wins DESC LIMIT 50
`);
const recentMatches = db.prepare(`
  SELECT m.*, u1.username AS p1_name, u2.username AS p2_name
  FROM matches m
  JOIN users u1 ON u1.id = m.p1_id
  JOIN users u2 ON u2.id = m.p2_id
  WHERE m.p1_id = ? OR m.p2_id = ?
  ORDER BY m.created_at DESC LIMIT 20
`);
const rankOf = db.prepare('SELECT COUNT(*) + 1 AS rank FROM users WHERE rating > ? AND wins + losses + draws > 0');

app.get('/api/leaderboard', requireUser, (_req, res) => {
  res.json({ players: leaderboard.all().map(publicUser) });
});

app.get('/api/users/:username', requireUser, (req, res) => {
  const row = findUserByName.get(String(req.params.username));
  if (!row) return res.status(404).json({ error: 'Player not found' });
  const user = publicUser(row);
  const played = user.wins + user.losses + user.draws;
  const matches = recentMatches.all(row.id, row.id).map(m => {
    const isP1 = m.p1_id === row.id;
    return {
      id: m.id,
      opponent: isP1 ? m.p2_name : m.p1_name,
      result: m.winner_id === null ? 'draw' : (m.winner_id === row.id ? 'win' : 'lose'),
      score: isP1 ? [m.p1_score, m.p2_score] : [m.p2_score, m.p1_score],
      delta: isP1 ? m.p1_delta : m.p2_delta,
      reason: m.end_reason,
      rounds: JSON.parse(m.rounds).map(r => (isP1 ? r : [r[1], r[0]])),
      createdAt: m.created_at
    };
  });
  // Favourite throw across recorded rounds.
  const counts = { rock: 0, paper: 0, scissors: 0 };
  for (const m of matches) for (const [mine] of m.rounds) if (mine) counts[mine]++;
  res.json({
    user,
    rank: played > 0 ? rankOf.get(row.rating).rank : null,
    throws: counts,
    matches
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Static client ----------
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// ---------- Realtime ----------
const server = http.createServer(app);
const io = new Server(server, { serveClient: true });

io.use((socket, next) => {
  const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
  const user = userFromToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

const game = new GameServer(io);
io.on('connection', (socket) => game.onConnect(socket));

server.listen(PORT, () => {
  console.log(`Dojo Duel running at http://localhost:${PORT}`);
});
