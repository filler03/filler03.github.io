# Development Workflow

## Static Site (`public/`)

### No Build Process

There is **no build system, no bundler, no package.json, and no dependencies** for the static site. Files are edited directly and pushed to GitHub Pages.

### How to Work on Static Files

1. Edit the HTML file directly — most are self-contained with inline `<style>` and `<script>` tags. Some are split into multiple files (see Growing Trees under `games/growing_trees/`), loaded with classic `<script src>` tags (no ES modules).
2. Open in a browser via `file://` or a local HTTP server to test
3. Use browser dev tools device emulation for mobile testing
4. Push to GitHub to deploy

### Coding Conventions

- **No build system** — files are edited directly and pushed. Small games/tools stay single-file HTML; multi-file games use classic `<script src>` tags (no ES modules, so pages still open over `file://`) with all referenced files committed in the same folder
- **Canvas API** for game rendering (2D context)
- **`requestAnimationFrame`** for game loops
- **CSS Custom Properties** for theming (see `tools/multiStepCalculator.html` for an example)
- **Touch + mouse** input support in all games
- **Dark themes** with gradients and glassmorphism as the default visual style

## Multiplayer Servers (`apps/`)

### No External Dependencies

Both apps use **zero npm packages**. The WebSocket server is hand-rolled (`ws-lite.js`). Do not add dependencies.

### Local Development

```bash
# Basketball
cd apps/basketball
node server.js
# → http://localhost:3100 — open two tabs with the same room code

# Soccer
cd apps/soccer
node server.js
# → http://localhost:3200 — open two tabs with the same room code
```

Override the port:

```bash
PORT=4000 node server.js
```

### Testing

Each app has a `test-server.js` that exercises the full HTTP + WebSocket protocol:

```bash
cd apps/basketball && node test-server.js
cd apps/soccer && node test-server.js
```

These tests:
- Spawn the server on a test port
- Drive the full WebSocket handshake and game protocol
- Verify room creation, joining, scoring, reconnect, and cleanup
- Exit with pass/fail

**Always run these before deploying multiplayer changes.**

### After Code Changes (on VPS)

```bash
pm2 restart basketball-mp --update-env
pm2 restart soccer-mp --update-env
```

### Manual Smoke Test (Multiplayer)

1. Open two browser tabs, enter the same room code
2. Play a match to completion
3. Verify the game-over screen shows correct winner and scores
4. Test **Rematch** from both tabs — both should enter a fresh lobby
5. Test disconnect/reconnect by closing and reopening a tab mid-match

## Reverting Basketball to Relay Mode

The previous browser-authoritative (relay) version of basketball is preserved in `apps/basketball/_relay-backup/`. See `_relay-backup/REVERT.md` for instructions — copy the three files back, remove `game.js`, and restart.
