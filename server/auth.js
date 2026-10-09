/* =========================================================
   Authentication — scrypt password hashing + cookie sessions
   ========================================================= */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, publicUser } from './db.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'dojo_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;

// ---------- Passwords ----------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- Sessions ----------
// Only a SHA-256 of the token is stored, so a leaked DB can't be used to hijack sessions.
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
const selectSessionUser = db.prepare(`
  SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires_at > ?
`);
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  insertSession.run(sha256(token), userId, Date.now() + SESSION_TTL_MS);
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  return publicUser(selectSessionUser.get(sha256(token), Date.now()));
}

export function destroySession(token) {
  if (token) deleteSession.run(sha256(token));
}

export function sessionCookieOptions(secure) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_TTL_MS,
    path: '/'
  };
}

// ---------- Cookie parsing (avoids an extra dependency) ----------
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
  }
  return out;
}

export function tokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

/** Express middleware: attaches req.user (or null). */
export function attachUser(req, _res, next) {
  req.user = userFromToken(tokenFromRequest(req));
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// ---------- Simple in-memory rate limiter for auth endpoints ----------
const attempts = new Map(); // ip -> { count, resetAt }
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;

export function authRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count > MAX_ATTEMPTS) {
    const retry = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', String(retry));
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  next();
}

// Periodically drop stale rate-limit entries.
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of attempts) if (e.resetAt < now) attempts.delete(ip);
}, WINDOW_MS).unref();
