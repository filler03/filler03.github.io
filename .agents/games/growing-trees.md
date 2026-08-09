# Growing Trees (`public/games/growing_trees.html`)

> Single-file HTML5 canvas game: draw a freehand gesture and it both **plays a synthesized note** and **grows a tree** from the ground. The path you draw IS the note — its horizontal travel sets the note's length, its screen Y sets the volume — and a small circle traces the path green while it plays.
>
> Current version badge: `v1.2.5` (bottom-left of the page — **bump on every change**).

## Overview

| Aspect | Detail |
|--------|--------|
| File | `public/games/growing_trees.html` (self-contained HTML/CSS/JS) |
| Rendering | Canvas 2D, single depth-sorted pass (far → near), finished trees cached to bitmaps |
| Audio | Web Audio API (oscillator + gain envelope, master gain 0.45, compressor). Gestures use `setValueCurveAtTime` (wait mode) or incremental ramps (live mode) |
| Persistence | `localStorage` key `growingTrees.settings.v5` → `{ chime, gesture, fixed, prefs }` |
| Interaction | Two modes: `plant` (draw trees/notes) and `nav` (pan + pinch zoom) |

## Controls

| Input | Plant mode (`plant`) | Navigate mode (`nav`) |
|-------|----------------------|------------------------|
| Tap | Play the default ADSR note + grow a small tree | — |
| Drag a freehand path | Draw a dotted path that plays back (circle turns it green) | — |
| **Multiple fingers** | Each finger starts its own independent gesture (path + note + tree) | — |
| Pan sliders (on-screen) | — | Pan `cam.x` / `cam.y` |
| Pinch inside pan slider | — | Zoom (zoomAt) |

- Startup camera: zoomed all the way out, panned all the way down — `cam = { x: 0, y: HORIZON * MIN_ZOOM, zoom: MIN_ZOOM }`, where `MIN_ZOOM = 0.3`, `MAX_ZOOM = 3.0`, `HORIZON = H * 0.56`.

## Gesture → Note (freehand path)

A gesture is one continuous freehand path (no more line splitting, guide circles, or guard corridors). Any number of fingers can gesture at once — each pointer gets its own `dragState` in `dragStates` (keyed by `pointerId`), and lifting one finger only finishes that finger's gesture.

- **Time (X)**: each path step adds `(|Δx| / W * 100) * TIME_PER_W * timeMult` ms of note time. Left and right both count (`|Δx|`), so a purely vertical line is ~0 ms (fills in a flash) and a long horizontal one makes a long note. `cumTime[]` accumulates this along the path; `totalMs = cumTime[last]`.
- **Volume (Y)**: absolute screen Y — `volumeFromStartY(y)` (top = loud `0.5`, bottom = quiet `0.01`). The starting volume is therefore the first touch's Y automatically.
- **Pitch**: from the plant X position via `pitchFor(sx, sy)` (major pentatonic, an octave below the key).

### Playback visualization

While drawing the path is a **dotted line**. During playback a small **glowing circle** travels along the path at the point whose `cumTime` equals the elapsed note time, turning the traveled portion into a **glowing green solid line** (`GESTURE_GREEN = #3ecb5a`); the unplayed portion stays dotted. When the note finishes the whole path stays green and fades out after `LINGER_MS = 800`.

Gestures **overlap**: starting a new gesture never removes an earlier one that is still playing — each keeps its green path animating and its note sounding until it finishes (`playbacks[]` and `gestureNotes[]` lists). Taps overlap too (each is its own note in `tapNotes[]`); only a global cancel on blur/cancel/mode-switch/clear stops everything (`stopGestureNote`).

### Live vs Wait (top-left toggle)

| Mode | When the note plays |
|------|---------------------|
| 🎵 Live sound (`waitForGesture: false`) | The note starts as soon as the finger moves past `TAP_THRESHOLD`. The audio clock is real time, so each new path point is scheduled at its own `cumTime`. If the circle catches the fingertip (drawing slower than the clock), the sound **holds at the fingertip's volume and waits** for the finger to move again (`setTargetAtTime` catch-up). On lift, any unplayed remainder continues to the end then fades. |
| ⏳ Wait for gesture (`waitForGesture: true`) | The whole note is scheduled at release via a single `setValueCurveAtTime` over 128 volume samples (with a ~20 ms anti-click rise and `FADE_MS` tail). |

### Tap note defaults

A tap (movement ≤ `TAP_THRESHOLD`, 8 px) plays the default ADSR note: the four `FIXED` presets (attack/decay/hold/release + end-vol), volume from the touch's Y, pitch from its X. Taps **overlap** — each gets its own oscillator + gain node (`tapNotes[]`), so multiple taps ring at once; a new tap never cuts an earlier one (only a global cancel on blur/mode-switch/clear stops them).

## Tree Growth Animation

Growth runs at a **fixed speed** (`GESTURE.growSpeed`, slider 0.25–4x, default 1); the **note durations decide how much each part grows** (not how fast). Growth is computed from elapsed time, so even sub-frame segments reach their cap.

| Part | Grows during | Cap (fraction of full) |
|------|--------------|------------------------|
| Trunk | attack window | `clamp01(attack / (20 / speed))` |
| Branches | decay + hold window | `clamp01((decay + hold) / (500 / speed))` |
| Leaves & fruit | release window | `clamp01(release / (1200 / speed))` |

- Full-growth reference times: `GROW_TRUNK_FULL_MS = 20`, `GROW_BRANCH_FULL_MS = 500`, `GROW_FOLIAGE_FULL_MS = 1200`.
- **Taps** size the tree from the woody window (attack + decay + hold) vs `FULL_GROW_MS = 6000` × sustain.
- **Gestures** use a simple proportional envelope of the path's total time (`gestureTreeNote`): attack 10%, decay 20%, hold 25%, release 45% — so the tree grows in sync with playback (longer path = bigger tree). In live mode the tree is planted at note start and `refreshLiveTreePath` re-applies the envelope (and rebuilds bigger) as the path grows. **The exact gesture→growth mapping is intentionally pending refinement.**
- Structure is **pre-built** (`Branch.build`); each branch draws from its parent's live tip, then `Tree.bake()` caches finished trees to bitmaps.

## Top-Left HUD (`#statHud`)

Stacked **note cards**, one per running tap and one per active gesture playback, removed when that sound finishes:

- **Taps** (`tapNoteCardHtml`): one `hud-fixed` note card per active tap showing the phases **A D S R** in a line (A/D/S/R = attack / decay / hold-as-sustain / release) with a progress bar that moves through them (the active phase's letter is highlighted; per-phase durations come from `note.slots[]`). Simultaneous taps stack one on top of the other.
- **Gesture playback** (`gestureNoteCardHtml`): one `live` note card per active gesture — as compact as the tap cards, showing `⏳` + the note's total ms and `🔊` + the volume % at the circle's current position. Every simultaneous gesture gets its own note card.

## Settings Panel

| Section | Controls |
|---------|----------|
| Default values | Start mode (`plant`/`nav`), Key (root note) |
| Gesture timing | Growth speed (`growSpeed`), Time multiplier (`timeMult` — ms per % of horizontal travel) |
| Tap note defaults | Attack / Decay / Hold / Release ms + End vol sliders |

Settings persist on every change via `saveSettings()`; `resetToDefaults()` clears the saved key and restores the defaults.

## Architecture Index

### Key classes

| Class | Role |
|-------|------|
| `Branch` | One wood segment: `build()` pre-builds children/foliage, `update()` grows by phase, `draw()`/`drawWood()` render, `bounds()` for bake box |
| `Tree` | Root of a branch network: growth caps/rates, phase times (`tTrunkEnd`/`tBranchEnd`/`tTotal`), `bake()`/`blit()` |

### Key functions

| Function | Purpose |
|----------|---------|
| `addPathPoint` / `pathStateAtTime` | Record a freehand point; locate the playback circle on the path for an elapsed time |
| `buildVolumeCurve` / `schedulePathPlayback` | Wait mode: sample the path's volume profile and play it with `setValueCurveAtTime` |
| `startLivePathNote` / `scheduleLivePoint` / `finishLivePathNote` | Live mode: real-time delayed scheduling with `setTargetAtTime` catch-up when the circle reaches the fingertip |
| `gestureTreeNote` / `plantGestureTree` / `refreshLiveTreePath` | Gesture trees: proportional envelope, plant + stretch as the path grows |
| `finishPlantGesture` / `cancelDragState` | Finish / abort one finger's gesture (others keep going); `dragStates` holds one per pointer |
| `startGestureNote` / `scheduleFixedRun` / `scheduleFixedSlot` | Per-tap ADSR scheduling (each tap is its own note in `tapNotes[]`) |
| `volumeFromStartY` / `pitchFor` / `toWorld` / `zoomAt` | Volume, pitch, camera math |
| `refreshHud` / `tapNoteCardHtml` / `tapPhase` / `gestureNoteCardHtml` | HUD: stacked note cards, one per active tap (A/D/S/R) + one per active gesture |

### Key constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `TIME_PER_W` | 50 | ms of note time per % of screen width at 1× time multiplier |
| `MIN_GESTURE_MS` | 80 | shortest note a gesture can produce (a vertical line ≈ 0 ms) |
| `LINGER_MS` | 800 | how long a finished green path stays before fading |
| `FADE_MS` | 150 | anti-clip fade-out |
| `TAP_ATTACK_MS` | 60 | attack for a tap (no line) |
| `TAP_THRESHOLD` | 8 | px before a drag counts |
| `VOL_MIN` / `VOL_MAX` | 0.01 / 0.5 | screen-Y volume gain range |
| `PAN_SENS` / `PINCH_SENS` | 2 / 0.4 | nav camera sensitivities |
| `GROW_*_FULL_MS` | 20 / 500 / 1200 | full-growth reference per part |

## Maintenance Notes

- **Always bump the `#version` badge** (currently `v1.2.5`) and re-run `node --check` on the extracted `<script>` block after changes.
- Trees/branches: don't re-introduce lazy spawning — the pre-built + dynamic-base approach keeps parts connected during growth.
- Don't revert the elapsed-time growth math to per-frame accumulation; sub-frame segments (e.g. a 5ms attack) would never grow.
- Gesture→tree growth mapping is still provisional (proportional split of `totalMs`); revisit when the tree-growth design is decided.
- Keep this guide lean: if the game's internals outgrow it, split deep details into their own `.agents/games/` file rather than padding this one.
