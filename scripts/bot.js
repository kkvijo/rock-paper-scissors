/* =========================================================
   Practice bot — registers a throwaway account, then joins the
   quick-match queue and accepts any challenge. Handy for testing
   multiplayer alone.

   Usage:  node scripts/bot.js [baseUrl] [botName]
   e.g.    node scripts/bot.js http://localhost:3000
   ========================================================= */
import crypto from 'node:crypto';
import { io } from 'socket.io-client';

const base = process.argv[2] || 'http://localhost:3000';
const name = process.argv[3] || `bot_${crypto.randomBytes(3).toString('hex')}`;
const password = crypto.randomBytes(12).toString('hex');
const CHOICES = ['rock', 'paper', 'scissors'];

const res = await fetch(`${base}/api/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: name, password })
});
if (!res.ok) {
  console.error('Register failed:', (await res.json()).error);
  process.exit(1);
}
const cookie = res.headers.get('set-cookie').split(';')[0];
console.log(`[${name}] registered`);

const socket = io(base, { extraHeaders: { cookie }, transports: ['websocket'] });
let lastRound = 0;

socket.on('connect', () => {
  console.log(`[${name}] connected — joining queue`);
  socket.emit('queue:join');
});
socket.on('connect_error', (e) => console.error('connect error', e.message));
socket.on('challenge:incoming', (inv) => {
  console.log(`[${name}] accepting challenge from ${inv.from.username}`);
  socket.emit('challenge:respond', { id: inv.id, accept: true });
});
socket.on('match:start', (m) => console.log(`[${name}] match vs ${m.opp.username}`));
socket.on('match:state', (m) => {
  if (m.phase === 'pick' && !m.you.locked && m.round !== lastRound) {
    lastRound = m.round;
    const pick = CHOICES[Math.floor(Math.random() * 3)];
    setTimeout(() => socket.emit('match:choose', { choice: pick }), 800 + Math.random() * 2500);
  }
});
socket.on('match:end', (e) => {
  console.log(`[${name}] ${e.result.toUpperCase()} ${e.score.you}-${e.score.opp} (${e.ratingDelta >= 0 ? '+' : ''}${e.ratingDelta})`);
  lastRound = 0;
  setTimeout(() => socket.emit('queue:join'), 1500);
});
