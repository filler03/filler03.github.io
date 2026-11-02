# Song Canvas — Instrument library

Candidates are posted one per message in **#instrument-inception** in the JF_FOUNDRY Discord. React to the messages you want kept.

## Layout

- `previews/` — the 20-second audition renders (saved on disc, not only in Discord)
- `audio/` — liked previews copied here, with their instrument spec in `specs/`
- `specs/` — instrument JSON for liked sounds
- `manifest.json` — preview → Discord message ID → source → status
- `index.html` — the library page
- `CREDITS.md` — sources and licenses

## Workflow

1. A new preview is posted in `#instrument-inception`.
2. The user reacts to the ones they like.
3. Liked audio is copied to `audio/`, its spec to `specs/`, and `manifest.json` is updated (`liked: true`).
4. The page shows the candidate and liked sets from the manifest.

Preview files are 20-second MP3s; the longer source renders and sample libraries stay in the local working area until a sound is kept.
