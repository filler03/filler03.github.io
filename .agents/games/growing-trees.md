# Growing Trees (`public/games/growing_trees.html`)

> Single-file HTML5 canvas game: draw a multi-segment gesture and it both **plays a synthesized note** and **grows a tree** from the ground. The envelope you draw (attack / decay / hold / release) drives the sound, the tree growth, and a live top-left HUD with per-component progress bars.
>
> Current version badge: `v1.1.21` (bottom-left of the page — **bump on every change**).

## Overview

| Aspect | Detail |
|--------|--------|
| File | `public/games/growing_trees.html` (self-contained HTML/CSS/JS) |
| Rendering | Canvas 2D, single depth-sorted pass (far → near), finished trees cached to bitmaps |
| Audio | Web Audio API (oscillator + gain envelope, master gain 0.45, compressor) |
| Persistence | `localStorage` key `growingTrees.settings.v4` → `{ chime, gesture, fixed, prefs }` |
| Interaction | Two modes: `plant` (draw trees/notes) and `nav` (pan + pinch zoom) |

## Controls

| Input | Plant mode (`plant`) | Navigate mode (`nav`) |
|-------|----------------------|------------------------|
| Tap / drag on ground | Plant a tree (gesture sets the note) | — |
| Sharp direction change (~72°, `TURN_DOT = 0.3`, line must be ≥ `TURN_MIN_LINE = 30px`) | Ends the current line, starts the next | — |
| Sharp turn on the **last** line | Ends the line **and** releases the gesture (plants the tree) | — |
| Pan sliders (on-screen) | — | Pan `cam.x` / `cam.y` |
| Pinch inside pan slider | — | Zoom (zoomAt) |

- Startup camera: zoomed all the way out, panned all the way down — `cam = { x: 0, y: HORIZON * MIN_ZOOM, zoom: MIN_ZOOM }`, where `MIN_ZOOM = 0.3`, `MAX_ZOOM = 3.0`, `HORIZON = H * 0.56`.

## Gesture → Sound Envelope

Up to **4 gesture lines** map onto the note's envelope, in order (skipping fixed components):

1. Each line's **length** (px) × `GESTURE.timePerPx` (default `12`, slider 1–40) = that component's **time in ms**.
2. Each line's **Y change** = that component's **volume change** (`VOL_PX_REF = 400` px sweeps the whole gain range).
   - **Y is inverted**: screen Y grows downward, so `dy = y0 - y1` → dragging **up = louder**, down = quieter.
3. A component's gesture value is capped by its **Max** setting (`FIXED[name].max` via `lineTimeForSlot`).
4. Volume ceiling (gain) comes from the gesture **start X**: `volumeFromStartX` — far left ≈ `0.01`, far right ≈ `0.5`.
5. Pitch comes from the plant position: `pitchFor(sx, sy)` — major pentatonic, one octave below the key.

| Slot | Component | Gesture line role |
|------|-----------|-------------------|
| 0 | `attack` | Always ramps silence → full gain over the line's time |
| 1 | `decay` | Ramp to its ΔY target, chains from attack's end |
| 2 | `hold` | Same, chains after decay |
| 3 | `release` | Same, then fades to 0 (anti-clip `FADE_MS = 150`) |

## Fixed Values & Max Caps

Each component can be ticked **fixed** ("skip its gesture line") or gesture-driven:

| Setting | Purpose |
|---------|---------|
| `on` (checkbox) | Tick = use preset, skip this component's gesture line |
| value (`fx-<name>T`) | Preset ms used when fixed (defaults: attack 5, decay 120, hold 250, release 1200) |
| End vol (`fx-<name>Vol`) | Preset target level as % of gain (defaults: 100 / 60 / 60 / 0) |
| Max (`fx-<name>Max`) | Cap for gesture-derived ms (defaults: 2000 / 3000 / 10000 / 5000) |

- All four ticked (defaults) = a piano note: quick attack to peak, decay to 60%, hold, smooth release to 0.
- `lineSlotFor(lineIndex)` maps gesture lines to unticked slots in order; `gestureLineLimit()` = count of unticked components.

## Tree Growth Animation

Growth runs at a **fixed speed** (`GESTURE.growSpeed`, slider 0.25–4x, default 1); the **note durations decide how much each part grows** (not how fast). Growth is computed from elapsed time, so even sub-frame segments reach their cap.

| Part | Grows during | Cap (fraction of full) |
|------|--------------|------------------------|
| Trunk | attack window | `clamp01(attack / (20 / speed))` |
| Branches | decay + hold window | `clamp01((decay + hold) / (500 / speed))` |
| Leaves & fruit | release window | `clamp01(release / (1200 / speed))` |

- Full-growth reference times: `GROW_TRUNK_FULL_MS = 20`, `GROW_BRANCH_FULL_MS = 500`, `GROW_FOLIAGE_FULL_MS = 1200`.
- **Tree size** comes from the *woody* window (attack + decay + hold) vs `FULL_GROW_MS = 6000`, scaled by `sustain` — a short gesture = small shrub, long = full tree. Size does **not** depend on where you plant.
- Structure is **pre-built** (`Branch.build`); each branch draws from its parent's live tip (no floating during growth), then `Tree.bake()` renders the finished tree to an offscreen bitmap for fast blits.

## Top-Left HUD (`#statHud`)

Four rows — Attack / Decay / Hold / Release — each showing its value (fixed preset, committed gesture line, or the live line being drawn) plus a **progress bar** that fills while that component's segment plays. Timing is derived from `hudState` (`noteStart`, per-slot `startOff`/`dur`, chained `elapsed`).

## Settings Panel

| Section | Controls |
|---------|----------|
| Default values | Start mode (`plant`/`nav`), Key (root note) |
| Gesture timing | Dist → time (`timePerPx`), Growth speed (`growSpeed`) |
| Fixed values | Per component: checkbox + ms slider + End vol slider + Max slider |

Settings persist on every change via `saveSettings()`; `resetToDefaults()` clears the saved key and restores `DEFAULT_CHIME` / `DEFAULT_GESTURE` / `DEFAULT_FIXED`.

## Architecture Index

### Key classes

| Class | Role |
|-------|------|
| `Branch` | One wood segment: `build()` pre-builds children/foliage, `update()` grows by phase, `draw()`/`drawWood()` render, `bounds()` for bake box |
| `Tree` | Root of a branch network: growth caps/rates, phase times (`tTrunkEnd`/`tBranchEnd`/`tTotal`), `bake()`/`blit()` |

### Key functions

| Function | Purpose |
|----------|---------|
| `plantAt` | Builds the note from the gesture, ends the note, creates the `Tree` |
| `commitLine` / `applyLineToNote` | Commit a gesture line and schedule its envelope segment |
| `checkDirectionChange` / `finishPlantGesture` | Turn detection; last-line turn = release, or finger-lift = release |
| `startGestureNote` / `scheduleVolumeSegment` / `scheduleFixedRun` / `scheduleFixedSlot` | Web Audio scheduling for gesture and fixed segments |
| `renderHud` / `refreshHud` / `commitHudLine` | Top-left HUD incl. progress bars |
| `lineSlotFor` / `gestureLineLimit` / `lineTimeForSlot` | Slot mapping, line limit, Max caps |
| `volumeFromStartX` / `pitchFor` / `toWorld` / `zoomAt` | Volume, pitch, camera math |

### Key constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `VOL_PX_REF` | 400 | px of Y change = full gain range |
| `FADE_MS` | 150 | anti-clip fade-out |
| `TAP_ATTACK_MS` | 60 | attack for a tap (no line) |
| `TURN_DOT` / `TURN_MIN_LINE` | 0.3 / 30 | line-ending turn thresholds |
| `TAP_THRESHOLD` | 8 | px before a drag counts |
| `PAN_SENS` / `PINCH_SENS` | 2 / 0.4 | nav camera sensitivities |
| `GROW_*_FULL_MS` | 20 / 500 / 1200 | full-growth reference per part |

## Maintenance Notes

- **Always bump the `#version` badge** (currently `v1.1.21`) and re-run `node --check` on the extracted `<script>` block after changes.
- Trees/branches: don't re-introduce lazy spawning — the pre-built + dynamic-base approach keeps parts connected during growth.
- Don't revert the elapsed-time growth math to per-frame accumulation; sub-frame segments (e.g. a 5ms attack) would never grow.
