# Soccer · Multiplayer

Two-player online soccer with **a goal at each end**. Pick a room code, share it
with a friend, and when you both enter the same code the match kicks off. It's a
networked, server-authoritative port of the single-player 3D soccer game — same
swipe-to-kick feel, now competitive: take turns shooting from midfield at your
goal, with timed halves, a side swap at halftime, a kick clock, and a winner.

It's a single self-contained Node app with **zero runtime dependencies**: one
process serves the game's static files, runs the match simulation, and streams it
to both players over WebSocket. There's nothing to `npm install`.

## How it plays

- One person taps **Play** first — they become the host (Player 1, red) and get
  sliders for kick power, kick clock, half length, and ball bounce.
- The other enters the same code and joins as Player 2 (blue).
- Players **alternate turns**. On your turn the ball sits at midfield; swipe up
  through it toward the goal in front of you — longer, faster swipes hit harder.
  Loft it and place it inside the 7.3 m goal ~27 m away. That distance + a narrow
  target is the skill, just like shooting hoops from the court.
- Whichever goal the ball crosses into scores for whoever is attacking that goal,
  so a wild shot into your own net hands the point to your opponent.
- At halftime the ends switch (the banner behind each goal is coloured for the
  player attacking it, so you always know which way you're shooting). Most goals
  at full time wins.

## Architecture (short version)

This is the same design as the basketball multiplayer app, applied to soccer.

- **Server-authoritative.** The Node server runs one 3D physics simulation per
  match (`game.js`) on the server's tick and streams the ball position + game
  events to *both* players. Each client is a pure renderer: it draws what the
  server sends and forwards only the player's kick vector (`{t:'kick',vx,vy,vz}`),
  which the server validates (right turn, ball at rest, speed clamped) before
  applying. Both players see the same latency, nobody's phone can drag the other,
  and a player backgrounding their screen doesn't freeze the game.
- **Two goals, one physics engine.** The pitch plays down its long (x) axis with a
  goal at each end facing inward. Posts, crossbar, nets, wall bounces, and
  goal-line detection are all computed on the server in world coordinates,
  parameterised by which end. The client scene mirrors the exact geometry.
- **Leave & come back (seamless).** The reconnect token is saved in `localStorage`,
  so a player can close the tab and reopen it within a 2-minute grace window and
  drop straight back into the live match. A drop does **not** pause the match and
  the opponent is **not** notified — if it becomes the absent player's turn, the
  clocks simply hold until they return and resync. Only if they never come back
  within the grace window does the match end. **Leave/Exit** quit deliberately.
- **Fixed world (meters).** Everything is computed in a shared world frame
  (field `x∈[-30,30]`, `z∈[-20,20]`, goals at `x=±27`) so a phone and a laptop
  see the same match, and the client renders it with Three.js.

### Files

| File               | Purpose                                                           |
|--------------------|-------------------------------------------------------------------|
| `server.js`        | HTTP static server + WebSocket upgrade + heartbeat + physics tick |
| `ws-lite.js`       | Minimal dependency-free WebSocket server (handshake + framing)    |
| `rooms.js`         | Matchmaking, presence, reconnect/resume, match lifecycle          |
| `game.js`          | Server-side match: 3D ball physics, two goals, scoring, clocks    |
| `public/index.html`| The whole game client (HTML + CSS + Three.js JS, all inline)      |
| `test-server.js`   | End-to-end test of the HTTP + WebSocket protocol (scores a goal)  |

## Run it locally

```bash
cd apps/soccer
node server.js
# open http://localhost:3200 in two tabs and use the same code
```

Set a different port with `PORT`:

```bash
PORT=4000 node server.js
```

Run the test suite (boots the server in-process, drives the full WebSocket
protocol including a scored goal + reconnect, then exits):

```bash
node test-server.js
```

## Simplest deploy: link straight to the port (no nginx)

Run it under pm2 on its port and open that port on the firewall, then link to
`http://your-domain:3200/` from your site:

```bash
pm2 start ecosystem.config.js && pm2 save
sudo ufw allow 3200/tcp
```

The reverse proxy below is the tidier option if your site is served over HTTPS
(it keeps everything same-origin `https`/`wss`).

## Deploy on the VPS (nginx + pm2)

Built to live inside your existing site at `apps/soccer/` (or wherever you keep
the bots) and be reverse-proxied under `/multiplayer/soccer/` on your domain.
Because the page and the socket share an origin, an `https://` page automatically
gets a `wss://` socket — no mixed-content issues.

**1. Start it under pm2:**

```bash
cd /path/to/your-site/apps/soccer
pm2 start ecosystem.config.js   # port is set to 3200 in ecosystem.config.js
pm2 save
```

**2. Add this location block inside your site's `server { ... }` in nginx:**

```nginx
location /multiplayer/soccer/ {
    proxy_pass http://127.0.0.1:3200/;   # trailing slash strips the path prefix
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;            # don't cut idle WebSockets
}
```

The trailing slash on both `location` and `proxy_pass` means Node sees clean
paths (`/`, `/ws`, `/health`). The `Upgrade`/`Connection` headers are what let the
WebSocket through — without them the game loads but never connects.

**3. Reload nginx:**

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Then visit `https://your-domain/multiplayer/soccer/`.
`GET /health` returns `{"ok":true,...}` for uptime checks / your watchdog.

## Link it from your site

```html
<a href="/multiplayer/soccer/">⚽ Soccer · Multiplayer</a>
```

## Notes / scope

- **Kick power** scales how hard swipes hit; if the goal feels too far, nudge it up.
- **Rematch:** either player can trigger a rematch from the final screen.
- The host's settings are locked once the match begins.
- This is turn-based (a shootout-style duel), matching the basketball app's model.
  It is **not** the real-time free-roam design — that's a separate project.
