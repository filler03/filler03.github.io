# Multiplayer Apps (`apps/`)

Two real-time multiplayer game servers, each a self-contained Node.js application with **zero npm dependencies**.

## Shared Architecture

Both apps follow the same pattern:

- **Server-authoritative** — the Node server runs physics at 60 Hz and streams state to both clients over WebSocket. Clients are pure renderers that only send input events.
- **Custom WebSocket** — `ws-lite.js` is a hand-rolled, dependency-free WebSocket server (handshake + framing). Shared between both apps.
- **Reconnect support** — players can disconnect and rejoin within a 2-minute grace window using a token stored in `localStorage`. The match continues during the disconnect.
- **Room-code matchmaking** — `rooms.js` handles room creation, joining, presence, and match lifecycle.
- **pm2 managed** — each app has an `ecosystem.config.js` for pm2 process management.

---

## Basketball (`apps/basketball/`) — Port 3100

Two game modes:
- **Duel** — turn-based: players alternate shots with a shot clock and timed halves
- **Frenzy** — simultaneous: both players shoot at once over a shared pool of balls (2–10), with bonus time for scoring

### Files

| File | Purpose |
|------|---------|
| `server.js` | HTTP static server + WebSocket upgrade + heartbeat + physics tick |
| `ws-lite.js` | Dependency-free WebSocket server |
| `rooms.js` | Matchmaking, presence, reconnect/resume, match lifecycle |
| `game.js` | Server-side match: physics, scoring, clocks, broadcasts |
| `public/index.html` | The entire game client (HTML + CSS + JS, all inline) |
| `public/manifest.webmanifest` | PWA manifest |
| `test-server.js` | End-to-end test of HTTP + WebSocket protocol |
| `ecosystem.config.js` | pm2 configuration (port 3100) |
| `_relay-backup/` | Previous browser-authoritative version + `REVERT.md` |
| `README.md` | Full architecture and deployment docs |

### Fixed Virtual Court
Everything computed in a **960×540** virtual court, scaled and letterboxed to each device.

---

## Soccer (`apps/soccer/`) — Port 3200

Free-play mode: one shared ball, either player can kick at any time, goals at each end, ball resets to centre only after a goal.

### Files

| File | Purpose |
|------|---------|
| `server.js` | HTTP static server + WebSocket upgrade + heartbeat + physics tick |
| `ws-lite.js` | Dependency-free WebSocket server |
| `rooms.js` | Matchmaking, presence, reconnect/resume, match lifecycle |
| `game.js` | Server-side 3D ball physics, two goals, scoring, clocks |
| `public/index.html` | The entire game client (HTML + CSS + Three.js, all inline) |
| `public/gameover-patch.js` | Drop-in patch for game-over / rematch flow (see `PATCH_NOTES.md`) |
| `public/manifest.webmanifest` | PWA manifest |
| `test-server.js` | End-to-end test (exercises scoring a goal + reconnect) |
| `ecosystem.config.js` | pm2 configuration (port 3200) |
| `README.md` | Full architecture and deployment docs |

### Fixed World Frame
Physics computed in meters: field `x ∈ [-30, 30]`, `z ∈ [-20, 20]`, goals at `x = ±27`. Client renders with **Three.js**.

---

## Key Globals (Client-Side)

Both clients expose these globals (referenced by `gameover-patch.js` and useful for debugging):
- `net` — WebSocket connection state
- `send` — function to send messages to the server
- `connect` — function to (re)open the WebSocket
- `clearSession` — clears saved reconnect token
- `G` — game state object

## Patch Notes

See [`PATCH_NOTES.md`](../PATCH_NOTES.md) in the repo root for the multiplayer game-over bug fix changelog.
