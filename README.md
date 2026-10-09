# Dojo Duel — Online Rock Paper Scissors

Real-time multiplayer rock · paper · scissors with accounts, matchmaking and Elo ratings.

## Features

- **Accounts** — register / sign in (scrypt-hashed passwords, httpOnly cookie sessions)
- **Lobby** — see who's online, search players, send direct challenges
- **Quick match** — queue pairs you with the closest rating
- **Ranked duels** — best of 3, 15s per round, server-authoritative (choices stay hidden until both lock in)
- **Reconnect grace** — 20s to come back after a disconnect before forfeiting
- **Elo ladder** — tiers (Bronze → Diamond), leaderboard with podium, player profiles with match history and throw stats
- **Practice mode** — offline vs AI
- Dark / light theme, sounds, confetti, mobile layout

## Stack

Node.js 22.13+ · Express · Socket.IO · SQLite (built-in `node:sqlite`, no native build step)

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Use `PORT=xxxx` to change the port.

Testing alone? Start a bot opponent that joins the queue and accepts challenges:

```bash
npm run bot                       # targets http://localhost:3000
node scripts/bot.js http://localhost:3000 MyBot
```

## Project layout

```
server/
  index.js   HTTP API + Socket.IO bootstrap
  auth.js    password hashing, sessions, rate limiting
  db.js      SQLite schema
  game.js    presence, queue, challenges, match engine, Elo
public/
  index.html, css/style.css, js/app.js, js/fx.js
scripts/bot.js   test opponent
```

The database is created at `data/dojo.db` (git-ignored). In production set `NODE_ENV=production` so session cookies are marked `Secure` (requires HTTPS).
