# Overview

## What This Project Is

This is the source for **filler03.github.io** — a personal site hosting HTML5 games and utility tools, plus two real-time multiplayer game servers that run on a separate VPS.

## Tech Stack

### Static Site (`public/`)
- **HTML5 / CSS / vanilla JavaScript** — no frameworks, no build step
- **Canvas API** for game rendering
- **CSS Custom Properties** for theming
- **Mobile-first** — viewport meta tags, touch events, `safe-area-inset` for notch support
- Deployed via **GitHub Pages** (push to deploy)

### Multiplayer Servers (`apps/`)
- **Node.js** — zero external dependencies
- **Custom WebSocket server** (`ws-lite.js`) — no `ws`, no `socket.io`
- **Server-authoritative physics** at 60 Hz tick rate
- Managed with **pm2**, reverse-proxied through **nginx**
- Basketball on port **3100**, soccer on port **3200**

## Design Conventions

- **Dark themes** with gradient accents and glassmorphism effects
- Smooth animations and particle effects in games
- The homepage (`public/index.html`) uses a time-rotating gradient background (red-white-blue, angle based on current second within the minute)
- All games are **mobile-responsive** with both mouse and touch input support

## File Naming

- Production single-player games live in `public/games/<sport>/`
- Test/dev versions live in `public/test/<sport>/`
- Each multiplayer app is a self-contained Node project under `apps/<sport>/`
- READMEs exist in each multiplayer app directory with full architecture details
