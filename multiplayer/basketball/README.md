# Basketball · Multiplayer

Two-player online basketball. Pick a room code, share it with a friend, and when
you both enter the same code the match starts. It's a networked port of the
single-player basketball game — same swipe-to-shoot feel, scoring (1/2/3),
shot clock, timed halves with a side swap at halftime, and a winner.

It's a single self-contained Node app with **zero runtime dependencies**: one
process serves the game's static files *and* relays the WebSocket traffic between
the two players. There's nothing to `npm install`.

## How it plays

- One person taps **Play** first — they become the host (Player 1, red) and get
  sliders to set game speed, shot clock, half length, and ball bounce.
- The other enters the same code and joins as Player 2 (blue).
- Players alternate turns. Swipe on the court to aim and shoot; the longer the
  swipe, the more power. The ball stays where it lands, so your next shot starts
  from wherever it came to rest — same as the original.

## Architecture (short version)

- **Host-authoritative.** The host (role 1) runs the single physics simulation
  for *both* players' shots on a fixed 60 Hz timestep, and streams the ball
  position + game events to the joiner. The joiner renders what it receives and
  sends only its swipe vector; the host validates it and applies it. This keeps
  the two screens in agreement without lockstep.
- **Fixed logical court.** Everything is computed in a 540×960 virtual court and
  then scaled + letterboxed to each device, so a phone and a laptop see the same
  game. (This differs slightly from a "fit to the host's screen" approach — it's
  cleaner and removes device-size drift.)
- **Generic relay.** `rooms.js` knows nothing about basketball; it only does
  matchmaking, presence, a 45-second reconnect grace window, and relaying
  messages between the two peers. You can drop a different game client on top of
  the same server.

### Files

| File               | Purpose                                                        |
|--------------------|----------------------------------------------------------------|
| `server.js`        | HTTP static server + WebSocket upgrade + heartbeat             |
| `ws-lite.js`       | Minimal dependency-free WebSocket server (handshake + framing) |
| `rooms.js`         | Matchmaking, presence, reconnect grace, message relay          |
| `public/index.html`| The whole game client (HTML + CSS + JS, all inline)            |
| `test-server.js`   | End-to-end test of the HTTP + WebSocket protocol               |

## Run it locally

```bash
cd multiplayer/basketball
node server.js
# then open http://localhost:3100 in two tabs and use the same code
```

Set a different port with `PORT`:

```bash
PORT=4000 node server.js
```

Run the test suite (spawns the server on a test port, exercises HTTP + the full
WebSocket protocol, then exits):

```bash
node test-server.js
```

## Simplest deploy: link straight to the port (no nginx)

You don't strictly need nginx. Run the app under pm2 on its port and open that port
on the firewall, then link to `http://your-domain:3100/` from your site:

```bash
pm2 start ecosystem.config.js && pm2 save
sudo ufw allow 3100/tcp
```

The reverse proxy below is the tidier option if your site is served over HTTPS (it
keeps everything same-origin `https`/`wss`). See `DEPLOY.md` for the tradeoffs.

## Deploy on the VPS (nginx + pm2, optional)

This is built to live inside your existing site at `multiplayer/basketball/` and
be reverse-proxied under `/multiplayer/basketball/` on your domain. Because the
page and the socket share an origin, an `https://` page automatically gets a
`wss://` socket — no mixed-content issues.

**1. Start it under pm2:**

```bash
cd /path/to/your-site/multiplayer/basketball
pm2 start ecosystem.config.js   # port is set to 3100 in ecosystem.config.js
pm2 save
```

(Pick any free port; match it in the nginx block below.)

**2. Add this location block inside your site's `server { ... }` in nginx:**

```nginx
location /multiplayer/basketball/ {
    proxy_pass http://127.0.0.1:3100/;   # trailing slash strips the path prefix
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;            # don't cut idle WebSockets
}
```

The trailing slash on both `location` and `proxy_pass` means Node sees clean
paths (`/`, `/ws`, `/health`). The `Upgrade`/`Connection` headers are what let
the WebSocket through — without them the game will load but never connect.

**3. Reload nginx:**

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Then visit `https://your-domain/multiplayer/basketball/`.

`GET /health` returns `{"ok":true,...}` for uptime checks / your watchdog.

## Link it from your site

Add a link on your site's index, e.g.:

```html
<a href="/multiplayer/basketball/">🏀 Basketball · Multiplayer</a>
```

## Notes / scope

- **Reconnect:** if a socket drops mid-game (brief network blip, phone sleep),
  the other player pauses and both auto-reconnect within a 45-second window, then
  resume where they left off. A full browser *reload* returns you to the menu
  (re-enter the code to rejoin if the window hasn't expired).
- **Rematch:** either player can trigger a rematch from the final screen.
- Ports/settings are the host's; they're locked once the match begins.
