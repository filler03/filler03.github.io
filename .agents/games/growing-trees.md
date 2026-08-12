# Growing Trees (`public/games/growing_trees/`)

> HTML5 canvas instrument: draw a freehand gesture and it **plays a synthesized note**. The path you draw IS the note — its horizontal travel sets the note's length, its screen Y sets the volume — and a small circle traces the path green while it plays. The name and folder are kept for URL stability, but tree planting/rendering was removed entirely — the page is now a gesture→note toy on a plain white background.
>
> Current version badge: `v1.7.3` (bottom-left of the page — **bump on every change**).

## Overview

| Aspect | Detail |
|--------|--------|
| File | `public/games/growing_trees/index.html` (CSS + HTML + `<script src>` tags) with JS modules in `public/games/growing_trees/js/` |
| JS modules | `app.js` (shared state, helpers, camera), `audio.js` (Web Audio engine + note scheduling), `gesture.js` (path recording/playback/drawing), `ui.js` (HUD, settings, persistence), `main.js` (boot, pointer handlers, render loop) |
| Script style | Classic `<script src>` tags — **no ES modules**, so the page still opens over `file://`. Shared top-level state uses `var`; load order matters (see above) |
| Rendering | Canvas 2D, plain white world background; gesture paths drawn in screen space |
| Audio | Web Audio API (oscillator + gain envelope, master gain 0.45, compressor). Gestures use `setValueCurveAtTime` (wait mode) or incremental ramps (live mode) |
| Persistence | `localStorage` key `growingTrees.settings.v5` → `{ chime, gesture, fixed }` (key kept for backwards compatibility with saved settings) |
| Interaction | Single mode — freehand gestures only. The nav-mode button/start-mode setting were removed; the dormant camera (pan/zoom) code is kept in case navigation is re-added later |

## Controls

| Input | Action |
|-------|--------|
| Tap | Play the default ADSR note, or a very short gesture note when **Allow tap notes** is off |
| Drag a freehand path | Draw a dotted path that plays back (circle turns it green) |
| **Multiple fingers** | Each finger starts its own independent gesture (path + note) |

- The camera/pan/zoom code (`cam`, `zoomAt`, `navState`, `pinchState`) still exists but is dormant — there is no navigation button and `mode` is always `'plant'`. Re-enabling navigation later just needs the toggle restored.

## Gesture → Note (freehand path)

A gesture is one continuous freehand path. Any number of fingers can gesture at once — each pointer gets its own `dragState` in `dragStates` (keyed by `pointerId`), and lifting one finger only finishes that finger's gesture.

- **Time (X)**: each path step adds `(|Δx| / W * 100) * TIME_PER_W * timeMult` ms of note time. Left and right both count (`|Δx|`), so a purely vertical line is ~0 ms and a long horizontal one makes a long note. `cumTime[]` accumulates this along the path; `totalMs = cumTime[last]`.
- **Volume (Y)**: absolute screen Y — `volumeFromStartY(y)` (top = loud `0.5`, bottom = quiet `0.01`).
- **Pitch**: from the gesture's horizontal X via `pitchFor(sx, sy)` (major pentatonic, an octave below the key).

### Playback visualization

While drawing the path is a **dotted line**. During playback a small **glowing circle** travels along the path at the point whose `cumTime` equals the elapsed note time, turning the traveled portion into a **glowing green solid line** (`GESTURE_GREEN = #3ecb5a`); the unplayed portion stays dotted. When the note finishes the whole path stays green and fades out after `LINGER_MS = 800`.

Gestures **overlap**: starting a new gesture never removes an earlier one that is still playing — each keeps its green path animating and its note sounding until it finishes (`playbacks[]` and `gestureNotes[]` lists). Taps overlap too (each is its own note in `tapNotes[]`); only a global cancel on blur/cancel/clear stops everything (`stopGestureNote`).

### Live vs Wait (top-left toggle)

| Mode | When the note plays |
|------|---------------------|
| 🎵 Live sound (`waitForGesture: false`) | The note starts as soon as the finger moves past `TAP_THRESHOLD`. The audio clock is real time, so each new path point is scheduled at its own `cumTime`. If the circle catches the fingertip (drawing slower than the clock), the sound **holds at the fingertip's volume and waits** for the finger to move again (`setTargetAtTime` catch-up). On lift, any unplayed remainder continues to the end then fades. |
| ⏳ Wait for gesture (`waitForGesture: true`) | The whole note is scheduled at release via a single `setValueCurveAtTime` over 128 volume samples (with a ~20 ms anti-click rise and `FADE_MS` tail). |

### Tap note defaults

A tap (movement ≤ `TAP_THRESHOLD`, 8 px) plays the default ADSR note: the four `FIXED` presets (attack/decay/hold/release + end-vol), volume from the touch's Y, pitch from its X. Taps **overlap** — each gets its own oscillator + gain node (`tapNotes[]`). When **Allow tap notes** (`GESTURE.allowTapNotes`) is off, the default note is skipped and the tap instead plays a very short **gesture** note via `schedulePathPlayback` — same rules as any freehand gesture (min `MIN_GESTURE_MS` = 80 ms, volume from Y, pitch from X, gesture attack/decay/release settings, and green playback visualization).

## Top-Left HUD (`#statHud`)

Stacked **note cards**, one per running tap and one per active gesture playback, removed when that sound finishes:

- **Taps** (`tapNoteCardHtml`): one `hud-fixed` note card per active tap showing the phases **A D S R** in a line (A/D/S/R = attack / decay / hold-as-sustain / release) with a progress bar that moves through them.
- **Gesture playback** (`gestureNoteCardHtml`): one `live` note card per active gesture showing `⏳` + the note's total ms and `🔊` + the volume % at the circle's current position.

## Settings Panel

| Section | Controls |
|---------|----------|
| Default values | Key (root note) |
| Gesture timing | Time multiplier (`timeMult` — ms per % of horizontal travel) |
| Tap note defaults | Allow tap notes (checkbox), Attack / Decay / Hold / Release ms + End vol sliders |

Settings persist on every change via `saveSettings()`; `resetToDefaults()` clears the saved key and restores the defaults. (The former **Growth speed** slider was removed along with the tree logic.)

## Architecture Index

### Key functions (by module)

| Module | Functions |
|--------|-----------|
| `app.js` | `resize`, `toWorld`, `zoomAt`, `clampCamY`, `volumeFromStartY`/`yForVolume`; shared state (`playbacks`, `gestureNotes`, `tapNotes`, `cam`, `mode`, `dragStates`, `CHIME_SETTINGS`, `GESTURE`, `FIXED`) |
| `audio.js` | `initAudio`/`resumeAudio`/`unlockAudio`, `chime`, `setOscWave`, `pitchFor`/`noteToFreq`/`noteToMidi`/`midiToName`, tap ADSR (`startGestureNote`/`scheduleFixedRun`/`scheduleFixedSlot`/`endGestureNote`), gesture audio (`schedulePathAudio`/`initLivePathAudio`/`scheduleLivePoint`/`tickLiveHold`/`finishLivePathNote`), `stopGestureNote` |
| `gesture.js` | `addPathPoint`/`pathStateAtTime`, `attackFactor`/`decayFactor`/`buildVolumeCurve`, `schedulePathPlayback`/`startLivePathNote`, `buildGesturePlaybackPath`/`drawGreenPath`/`drawDottedTail`/`drawPlaybackCircle`, `finishPlantGesture`/`cancelDragState` |
| `ui.js` | HUD (`refreshHud`/`tapNoteCardHtml`/`gestureNoteCardHtml`), persistence (`saveSettings`/`loadSavedSettings`/`resetToDefaults`), settings panel wiring |
| `main.js` | Boot (apply saved settings, sound-overlay gate), pointer handlers, `loop()` render loop |

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
| `PAN_SENS` / `PINCH_SENS` | 2 / 0.4 | nav camera sensitivities (dormant — nav removed for now) |
| `GESTURE.allowTapNotes` | true | when off, a tap plays a ~0-length gesture note instead of the default tap note |

## Maintenance Notes

- **Always bump the `#version` badge** (currently `v1.7.3`) after changes.
- **Multi-file layout:** the page loads `js/app.js` → `audio.js` → `gesture.js` → `ui.js` → `main.js` in order. Classic scripts share globals: cross-file shared state is declared with `var` in `app.js`; per-file `const`/`let` stay file-local. Don't switch to ES modules (breaks `file://` testing) and don't reorder the tags.
- **Syntax check** each JS file after edits: `node --check js/*.js` (each file is plain JS).
- **No tree code:** tree planting/rendering was removed entirely (this is a gesture→note instrument now). Don't reintroduce trees without a design.
- Keep this guide lean: if the game's internals outgrow it, split deep details into their own `.agents/games/` file rather than padding this one.
