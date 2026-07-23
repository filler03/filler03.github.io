# Multiplayer game-over patch — README

## What this fixes

Two related bugs across the **soccer** and **basketball** multiplayer apps:

1. **"Same code lands me back in the old game."** After the match ended, the
   client's WebSocket stayed open (only marked `net.ended`) and the Rematch
   button reused that orphaned socket to send `{type:'join', code}`. If the
   other player had already re-opened a room with the same code, the join
   dropped the rematching player straight into that partner's fresh room —
   the "same code re-enters" bug you saw, which had nothing to do with the
   finished room on the server (the server already deleted that).
2. **"Game-ended screen didn't say who won."** The `t:'phase' ph:'gameover'`
   payload only carried raw scores (`s1`, `s2`) — no names, no explicit
   winner. The client derived the winner from possibly-stale local state,
   and if a state update was lost the final display could be wrong.

## What changed

### Server (soccer + basketball)

- `Match.gameOver()` in both `game.js` files now includes `p1`, `p2`,
  `winner` (0 = draw, else seat 1 or 2), and `winnerName` on the phase
  broadcast — so the ended screen is authoritative even if a state update
  was missed.
- `Rooms._finishRoom()` in both `rooms.js` files now emits
  `{type:'session-ended'}` to each seat before deletion. The socket stays
  open (so the client can finish rendering the final state), but the client
  is told to invalidate its saved reconnect token and treat any subsequent
  `join` as a fresh session.
- The existing `test-server.js` regressions ("room closed at game over",
  "reusing the code creates a brand-new room") still pass — these changes
  are additive.

### Basketball client — `apps/basketball/public/index.html`

Fully patched inline. Replace the file. Key edits:
- New `.final-score` CSS class + `<div class="final-score" id="finalScoreLine"></div>`
  in the `#gameover` overlay so the ended screen has a big "N – N" line
  colored by the winner.
- `handleControl()` new `case 'session-ended': onSessionEnded(); break;`
- New `onSessionEnded()` function: close socket, wipe token, clearSession.
- `applyPhase('gameover')` now reads names/scores/winner from the payload
  onto `G._winner` / `G._winnerName`.
- `showGameOver()` renders "🏆 {name} wins" + the big "N – N" line using
  those authoritative fields.
- Rematch handler rewritten: **always closes the current socket and opens
  a new WebSocket** before sending `join`. Never reuses `net.ws`.
- Same treatment for the Back-to-menu (`exitBtn`) path.

### Soccer client — `apps/soccer/public/gameover-patch.js` (drop-in)

The soccer client's structure is nearly identical to basketball, but rather
than replace the whole 1000+ line file I've provided a small drop-in
companion script. Add one line to the existing `apps/soccer/public/index.html`
right before `</body>`:

```html
    </script>
    <script src="./gameover-patch.js"></script>
  </body>
```

The script:
- Wraps `WebSocket.onmessage` non-destructively (all existing handlers still run).
- Intercepts `{type:'session-ended'}` → close socket, wipe token.
- Repaints the "Full Time" overlay from `p1/p2/winner/winnerName` on the
  server's game-over message (creates the `#finalScoreLine` element if it
  doesn't exist yet).
- Adds a capture-phase click on `#rematchBtn` that `stopImmediatePropagation()`s
  the original handler, closes the socket, opens a new one via `connect()`,
  and sends `join`.

Assumes the soccer client exposes globals `net`, `send`, `connect`,
`clearSession`, and `G`. If you renamed any of those, adjust the accessors
at the top of `gameover-patch.js` (only place they're referenced).

If you'd rather have the soccer client inline-patched the same way as
basketball, tell me and I'll produce that version — the drop-in is offered
as the lower-risk option since your soccer client works today.

## Install & verify

```
apps/soccer/game.js                              (replace)
apps/soccer/rooms.js                             (replace)
apps/soccer/public/gameover-patch.js             (new; add <script> tag)
apps/basketball/game.js                          (replace)
apps/basketball/rooms.js                         (replace)
apps/basketball/public/index.html                (replace)
```

Then:

```bash
pm2 restart soccer-mp     --update-env
pm2 restart basketball-mp --update-env

# Existing regression suites still pass:
cd apps/soccer     && node test-server.js
cd apps/basketball && node test-server.js
```

Manual smoke test:

1. Open two tabs, play a match to the buzzer.
2. Ended screen shows a **name + score** — e.g. "🏆 Alice wins" plus a
   large centered "3 – 1".
3. On BOTH tabs, click **Rematch**. Both should re-enter the lobby under
   the same code with a fresh ready-up prompt — not drop into whichever
   the other tab did first.
4. Stress test: click Rematch on tab A only and have tab A ready up alone
   in the new lobby. Tab B on the ended screen clicking Rematch should
   also open a fresh session and land in the same fresh room A is now
   hosting.
