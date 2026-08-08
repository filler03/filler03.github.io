# Public Site (`public/`)

The `public/` directory is the GitHub Pages web root. Everything here is served as static files — no server-side processing.

## Landing Page

- **`index.html`** — Game index / homepage with a two-column grid layout
  - Links to multiplayer games, single-player games, test builds, sandbox experiments, and tools
  - Time-based rotating gradient background (red → white → blue, completes one revolution per minute)
  - Orange-accented links for multiplayer entries

## Games (`public/games/`)

Self-contained single-file HTML games using the Canvas API:

| Path | Game | Notes |
|------|------|-------|
| `games/baseball/baseball.html` | Baseball | Single-player |
| `games/basketball/basketball.html` | Basketball | Single-player (the original, pre-multiplayer version) |
| `games/soccer/soccer.html` | Soccer | Single-player |
| `games/football.html` | Football | Single-player, lives directly in `games/` |
| `games/growing_trees.html` | Growing Trees | Gesture → synthesized note + tree growth (see guide below) |
| `games/orbit/orbit.html` | Orbit | Orbital mechanics game |
| `games/worms/worms.html` | Worms | Slither.io-style game with chunk-based exploration |

> **Known issue:** The homepage "Worms" link incorrectly points to `games/orbit/orbit.html` instead of `games/worms/worms.html`.

## Game Guides

Detailed, indexed write-ups for individual games live in [`.agents/games/`](games/):

| Game | Guide |
|------|-------|
| Growing Trees | [`.agents/games/growing-trees.md`](games/growing-trees.md) — gesture→envelope model, fixed values & Max caps, tree growth phases, HUD, settings, architecture index |

## Test Builds (`public/test/`)

Development versions of games before they go to production:

| Path | Game |
|------|------|
| `test/basketball/basketball.html` | Basketball (test) |
| `test/soccer/soccer.html` | Soccer (test) |

## Sandbox (`public/sandbox/`)

Experimental and work-in-progress files. These may not work properly.

| Path | Description |
|------|-------------|
| `sandbox/bigpickle/index.html` | 🏰 Tower Defense game |
| `sandbox/bigpickle/bible/` | ✝️ Bible Memory Verse app (multi-file: HTML + CSS + JS) |
| `sandbox/Poop/` | Experimental pages |
| `sandbox/googleDoc.html` | Google Doc embed experiment |
| `sandbox/googlesheetfetch.html` | Google Sheets fetch experiment |
| `sandbox/sounds_test.html` | Audio/sound testing |
| `sandbox/message.html`, `meta.html`, `test.html`, `two.html`, `trains.html` | Misc experiments |

## Tools (`public/tools/`)

Standalone utility apps:

| Path | Tool | Description |
|------|------|-------------|
| `tools/lifeProgress.html` | Life Progress Tracker | Date-based life progress calculations |
| `tools/funtext.html` | Fun Text Generator | Text transformation / styling tool |
| `tools/multiStepCalculator.html` | Multi-Step Calculator | Financial calculator with compound interest |
| `tools/AttractionChart.html` | Attraction Chart | Chart/visualization tool |

## Existing Agent Docs

- **`public/CLAUDE.md`** — Older Claude Code guidance file (predecessor to this documentation)
- **`public/DEPLOY.md`** — Deployment instructions for the multiplayer basketball app behind nginx
