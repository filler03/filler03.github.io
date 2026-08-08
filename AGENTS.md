# AGENTS.md

> Master index for AI agents working in this repository.
> Detailed documentation for each area lives in the [`.agents/`](.agents/) folder — start there for specifics.

## What This Repo Is

A GitHub Pages site (`filler03.github.io`) plus two companion Node.js multiplayer game servers. The static site hosts single-player HTML5 canvas games, utility tools, and sandbox experiments. The multiplayer servers (basketball & soccer) run on a VPS behind nginx and are linked from the site's homepage.

## Repository Map

```
.
├── public/                  ← GitHub Pages web root (static site)
│   ├── index.html           ← Landing page / game index
│   ├── games/               ← Production single-player games
│   ├── test/                ← Dev/test versions of games
│   ├── sandbox/             ← Experimental / WIP projects
│   └── tools/               ← Standalone utility apps
│
├── apps/                    ← Multiplayer game servers (Node.js, run on VPS)
│   ├── basketball/          ← 🏀 2-player multiplayer (port 3100)
│   └── soccer/              ← ⚽ 2-player multiplayer (port 3200)
│
├── PATCH_NOTES.md           ← Changelog for multiplayer game-over bug fixes
└── AGENTS.md                ← You are here
```

## Detailed Documentation Index

| Document | Covers |
|----------|--------|
| [`.agents/overview.md`](.agents/overview.md) | High-level architecture, tech stack, and conventions |
| [`.agents/public-site.md`](.agents/public-site.md) | The `public/` static site — pages, games, tools, sandbox |
| [`.agents/multiplayer-apps.md`](.agents/multiplayer-apps.md) | The `apps/` multiplayer servers — architecture, files, deployment |
| [`.agents/deployment.md`](.agents/deployment.md) | How to deploy: GitHub Pages for static, nginx + pm2 for multiplayer |
| [`.agents/development.md`](.agents/development.md) | Development workflow, testing, and coding conventions |

## Game Guides Index

Individual game write-ups (indexed from [`.agents/public-site.md`](.agents/public-site.md) → "Game Guides"):

| Game | Guide |
|------|-------|
| Growing Trees | [`.agents/games/growing-trees.md`](.agents/games/growing-trees.md) |

## Quick Rules for Agents

1. **No build system for static content.** Files in `public/` are self-contained HTML — edit and push.
2. **Zero npm dependencies for multiplayer servers.** `apps/basketball/` and `apps/soccer/` use a hand-rolled WebSocket server (`ws-lite.js`). Don't add dependencies.
3. **Server is authoritative.** All game physics run server-side. Clients are pure renderers. Don't move game logic to the client.
4. **Test before deploying multiplayer changes.** Each app has a `test-server.js` — run it with `node test-server.js`.
5. **Keep HTML self-contained.** Games and tools are single-file HTML apps with inline CSS and JS. Don't split them into separate files unless explicitly asked.
