# Growing Trees (`public/games/growing_trees/`)

> HTML5 canvas instrument: draw a freehand gesture and it **plays a synthesized note**. The path you draw IS the note — its horizontal travel sets the note's length, its screen Y sets the volume — and a small circle traces the path green while it plays. The name and folder are kept for URL stability, but tree planting/rendering was removed entirely — the page is now a gesture→note toy on a plain white background.
>
> Current version badge: `v1.30.0` (bottom-right of the page — **bump on every change**).

## Overview

| Aspect | Detail |
|--------|--------|
| File | `public/games/growing_trees/index.html` (CSS + HTML + `<script src>` tags) with JS modules in `public/games/growing_trees/js/` |
| JS modules | `app.js` (shared state, helpers, camera), `audio.js` (Web Audio engine + note scheduling), `gesture.js` (path recording/playback/drawing), `ui.js` (HUD, settings, persistence), `main.js` (boot, pointer handlers, render loop) |
| Script style | Classic `<script src>` tags — **no ES modules**, so the page still opens over `file://`. Shared top-level state uses `var`; load order matters (see above) |
| Rendering | Canvas 2D, plain white world background; gesture paths drawn in screen space |
| Audio | Web Audio API (oscillator + gain envelope, master gain 0.45, compressor). Gestures use `setValueCurveAtTime` (wait mode) or incremental ramps (live mode) |
| Persistence | `localStorage` key `growingTrees.settings.v8` → `{ chime, gesture, envelope, pitchZones, volume }` (key bumped on schema changes; old saves merge onto defaults) |
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
- **Volume (Y)**: absolute screen Y — `volumeFromStartY(y)` (top = loud `0.5`, bottom = quiet `0.01`). When "Add to gestures" attack/decay are on, the drawn line is placed at the Y of the **output** volume: each point's Y is remapped through the attack/decay envelope (`envelopeY`), so the fade-in rises from the bottom edge and the decay dips back down — the shape of the sound, not just the finger's raw Y. Release-tail points already encode their volume drop spatially, so they keep their Y.
- **Pitch**: from the gesture's horizontal X via `pitchFor(sx, sy)` — snapped to the **7-note diatonic major scale** (degrees 1–7 = the major scale degrees) over a **configurable pitch range** (see Pitch color zones below).

### Playback visualization

While drawing the path is a **dotted line**. During playback a small **glowing circle** travels along the path at the point whose `cumTime` equals the elapsed note time, turning the traveled portion into a **glowing green solid line** (`GESTURE_GREEN = #3ecb5a`); the unplayed portion stays dotted. When the note finishes the whole path stays green and fades out after `LINGER_MS = 800`. Every drawn point (dotted or solid, plus the circle) sits at the **output-volume Y** (`envelopeY` remap) rather than the finger's raw Y, so the attack/decay fades are visible as vertical movement as well as the amber window color.

Gestures **overlap**: starting a new gesture never removes an earlier one that is still playing — each keeps its green path animating and its note sounding until it finishes (`playbacks[]` and `gestureNotes[]` lists). Taps overlap too (each is its own note in `tapNotes[]`); only a global cancel on blur/cancel/clear stops everything (`stopGestureNote`).

**Per-pitch retrigger:** a new gesture or tap on a pitch that is already ringing **steals that voice** instead of stacking another (`retriggerPitch` in `audio.js`). The old voice fades in ~35 ms and **only the stolen note's green playback path is removed** — the new note keeps its own path and starts its attack cycle fresh. This keeps rapid taps on one band legible — at most one voice per pitch rings at a time, and every note that rings has its own path on screen. Different pitches remain polyphonic (multi-finger chords still layer). Each gesture note and playback entry carries its `pitch` (from `pitchFor(startX, startY)`) and wait-mode notes link back to their playback (`note.playback`) so the retrigger removes exactly the old path, never the new note's.

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
| Volume over Y | **Lower gain (bottom)** and **Upper gain (top)** sliders — independent 0–100 gains (100 = full scale, the max the audio engine can produce); the screen-Y volume interpolates between them |
| Gesture timing | Time multiplier (`timeMult` — ms per % of horizontal travel) |
| Pitch color zones | Show zones (checkbox), Low octave + degree, High octave + degree |
| Tap note defaults | Allow tap notes (checkbox), Attack / Decay / Hold / Release ms + End vol sliders |

Settings persist on every change via `saveSettings()`; `resetToDefaults()` clears the saved key and restores the defaults. (The former **Growth speed** slider was removed along with the tree logic.)

### Pitch color zones

Screen X = pitch, so the canvas is overlaid with **faint vertical color bands**, one per scale degree in the configured range — degree 1 red, 2 orange, 3 yellow, 4 green, 5 light blue, 6 dark blue, 7 pink. The bands are drawn in screen space behind the gestures (`drawPitchZones` in `gesture.js`), and each band maps to the exact same pitch as `pitchFor` (equal-width, `idx = floor(p * count)`), so the strip you touch is the degree you hear.

- **Octave semantics**: octave numbers are **relative to the key note's octave**. Octave **0 is the key octave** (the "middle ground", default C4 = middle C), with −1/−2 below and +1/+2 above.
- **Default range**: degree 1 @ octave −1 → degree 7 @ octave +1 (two octaves centered on the key octave).
- State lives in `PITCH_ZONES` (`app.js`), persisted under the `pitchZones` key; `pitchPositions()` (in `audio.js`) enumerates the ordered `{octave, degree}` positions between the bounds (auto-swapping if reversed) and drives both the audio mapping and the band rendering.

## Architecture Index

### Key functions (by module)

| Module | Functions |
|--------|-----------|
| `app.js` | `resize`, `toWorld`, `zoomAt`, `clampCamY`, `volumeFromStartY`/`yForVolume`, `withAlpha`; shared state (`playbacks`, `gestureNotes`, `tapNotes`, `cam`, `mode`, `dragStates`, `CHIME_SETTINGS`, `GESTURE`, `FIXED`, `PITCH_ZONES`) |
| `audio.js` | `initAudio`/`resumeAudio`/`unlockAudio`, `chime`, `setOscWave`, `pitchFor`/`pitchPositions`/`noteToFreq`/`noteToMidi`/`midiToName`, tap ADSR (`startGestureNote`/`scheduleFixedRun`/`scheduleFixedSlot`/`endGestureNote`), gesture audio (`schedulePathAudio`/`initLivePathAudio`/`scheduleLivePoint`/`tickLiveHold`/`finishLivePathNote`), `stopGestureNote` |
| `gesture.js` | `addPathPoint`/`pathStateAtTime`, `attackFactor`/`decayFactor`/`buildVolumeCurve`, `schedulePathPlayback`/`startLivePathNote`, `buildGesturePlaybackPath`/`drawPitchZones`/`drawGreenPath`/`drawDottedTail`/`drawPlaybackCircle`, `finishPlantGesture`/`cancelDragState` |
| `ui.js` | HUD (`refreshHud`/`tapNoteCardHtml`/`gestureNoteCardHtml`), persistence (`saveSettings`/`loadSavedSettings`/`resetToDefaults`), settings panel wiring (incl. `syncPitchZonesUI`) |
| `creator.js` | Sound creator (tabs: Volume envelope / Pitch / Harmonics): envelope editor (`envBoundaries`/`envSplitAtTime`/`envDragBoundary`), mix curves, harmonic spectrum (`initLayerSpecPoints`/`syncLayerAmplitudes`), pitch envelopes (`selectedPitchEnvOrNull`/`ensureSelectedPitchEnv`/`insertPitchPoint`/`pitchStAt` consumer), note-life slider (`applyLifeFromX`) |
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
| `VOL_MIN` / `VOL_MAX` | 0.01 / 0.5 | screen-Y volume gain range (now set directly via `VOLUME = { bottom: 0.01, top: 0.5 }` — both linear gains, 1.0 = full scale; wave peaks are normalized to 1.0) |
| `PAN_SENS` / `PINCH_SENS` | 2 / 0.4 | nav camera sensitivities (dormant — nav removed for now) |
| `GESTURE.allowTapNotes` | true | when off, a tap plays a ~0-length gesture note instead of the default tap note |

## Pitch envelopes (v1.10.0)

Each oscillator layer (or all of them at once) can bend pitch over the note's
life. Envelopes live in the sound creator's **Pitch** tab:

- Shape: `{ range, points: [{ t, st }] }` — `t` = note progress 0..1 across the
  body + release timeline (aligned to HOLD/CUT/REL like mix curves), `st` =
  semitone offset, 0 = no shift. `range` is the editor's ±scale in semitones
  (default ±1, stepper pill in the plot's top-left, max 24).
- **Master override is non-destructive:** while `MASTER_PITCH_ENV` exists it
  drives every layer; the ✕ on the Master swatch clears it and per-layer
  envelopes take over again (they are never erased). Layer envelopes are
  created lazily on first edit; Reset flattens to 0 st.
- Audio: one-shot paths sample the active envelope into
  `osc.frequency.setValueCurveAtTime` (`scheduleLayerPitch`); live gesture
  notes chase targets (`updateLivePitchTargets`) and continue through the
  release tail (`rampPitchToEnd`). No envelope → constant base pitch.
- Persistence: `masterPitchEnv` in the settings payload plus per-layer
  `pitchEnv`; invalid/absent values load as null.

## Layer voices — coupled duplicates (v1.11.0)

Each oscillator layer can carry up to `MAX_LAYER_VOICES` (5) duplicate voices
that play its same waveform in parallel with per-voice offsets:

- Voice shape: `{ id, st, ct, vol }` — semitone offset (−24..24), cents
  (−100..100), relative gain (0..2). Voices are **fully coupled** to their
  layer (no tab per duplicate); they share the waveform, mix curve, and pitch
  envelope. Only pitch/volume differ, producing chorus/unison thickening.
- Editing: a **Voices** tab beside Volume envelope / Pitch / Harmonics. Two
  sub-selection levels: the layer swatch row picks the oscillator, a chip row
  picks which voice to edit (✕ on a chip deletes it, + adds one — new voices
  default to +0 st · +7¢ · 100% for instant audible chorus). The graph area
  shows three draggable sliders (semitones, cents, volume) with −/+ nudge
  buttons for fine steps; **Reset** ("↺ Clear all") wipes every voice of the
  selected oscillator. Deleting all voices returns the layer to a single osc.
- Loudness is **normalized**: each layer's [1, ...voice vols] are divided by
  their sum (`normalizedVoiceLevels`), so duplicating never gets louder.
- Audio: `buildLayerStack` spawns one osc per voice (osc → voiceGain → envGain)
  and exposes parallel arrays (`oscLayer`, `oscVoice`, `oscOffset`, `oscLvl`)
  that every mix/pitch scheduler indexes per oscillator instead of per layer;
  static voice offsets add on top of any active pitch envelope.
- Persistence: per-layer `voices` array, clamped on load; absent → null.

## Sound flow editor — node types (WIP)

The full-screen sound flow editor (`flow.js`, opened from the bottom-right
button) arranges sound-definition nodes at **free positions on an infinitely
pannable canvas** and wires them into a playable graph. The old dotted grid and
its `gx,gy` coordinate labels are **hidden** (drawing code kept, gated by
`FLOW_SHOW_GRID = false` in case it returns). Node types own a slice of the
legacy creator's data model and are edited in dark-theme anchored overlays that
reuse the legacy logic by temporarily pointing a shared global at the node's own
data (the volume-envelope overlay swaps `ENVELOPE`; the wave/unison overlays
swap a layer-shaped proxy into `OSC_STACK` at `selectedLayerIdx` 0 and restore
it on close):

- `note` (🎵) — the entry point of a sound. Its on-node ports assign the
  connections: a required **volume envelope**, up to **3 waves** (1 required),
  and each wave's optional **mix envelope**; its widget card has a **▶ Play**
  that is always live (tapping it previews, never edits — compiles the graph
  and previews it via `compileFlowNote`/`playFlowNote`: builds `ENVELOPE`,
  `OSC_STACK` layers + per-voice envs, swaps the globals in around
  `previewNote`, restores), plus a **Note life** slider that scales the
  connected volume-envelope node's component durations (the legacy
  `setNoteLifetime`). Tapping the note card enters its **note editor**
  (`flowNoteEdit`, `flowNotePanel`) — a big play button + editable Note-life
  slider.
- `volumeEnv` (📉) — the note's required ADSR envelope (HOLD/CUT/REL markers);
  the old `envelope` node type (migrated on load). Overlay reuses the legacy
  envelope editor helpers.
- `env` (📈) — kind-agnostic breakpoint curve `{ points: [{t, v, seg?}], trim }`,
  v ∈ −1..1 with **0 = neutral**. Consumers decide the meaning: a wave's mix
  envelope maps v → mix weight `1+v` (0 = full), a unison's st/ct/vol animation
  envelopes map to `v·24` / `v·100` / `1+v`. Each point owns the span from
  itself to the next, so spans carry **segment line types** (Line / Stairs /
  Spring / Pulse) that the audio engine honors (`curveValue` / `envValueAt`).
- `wave` (🌊) — harmonic structure `{ amplitudes[32], specPoints, presetId }`;
  on-node ports assign an optional **mix env** and one or more **unisons**
  (stacked up to `MAX_LAYER_VOICES`). The overlay's
  Point/Draw/**Erase**/Delete modes edit the spectrum (Erase drags flatten the
  swept harmonics to 0 via `flowWaveEraseAt`).
- `unison` (🦄) — exactly one additional voice `[{ id, st, ct, vol, muted }]`
  (the first stored voice is kept; defaults to a single voice). Its widget shows
  mini read-only faders for the selected voice's st/ct/vol; tapping it opens the
  overlay (interval presets + st/ct/vol faders). On-node ports assign optional
  **vol / st / ct** env connections (compiled to per-voice `envs`), each port
  aligned beside the fader it drives (Semitones / Cents / Volume); while an env
  is connected, that fader (and the semitone interval chips, for st) is locked —
  rendered greyed with an `ENV` readout and inert until the connection is
  removed (`flowUnisonParamLocked`). In the overlay a locked fader shows a
  **Disconnect** button (`flowUnisonDisconnectEnv`) that severs the env
  connection (coalesced into the session's undo entry) and immediately
  re-enables the fader/chips.

Connections are consumer-owned named slots (`conn` on each node): the note has
`{ volumeEnv, waves[3], mixEnvs[3] }`, the wave `{ mixEnv, unison[] }` (a wave
can stack up to `MAX_LAYER_VOICES` unisons, one port per stack), the
unison `{ volEnv, stEnv, ctEnv }`. Any node may feed multiple consumers
(fan-out). Slots are type-constrained (DAG by construction); a note is
"ready" (playable) with a volume env + ≥1 wave, shown by a warning badge
otherwise. **No drawer**: each consumer's slots are drawn as small
emoji-labeled **ports around the node itself** (`flowPorts` — note: Vol top +
W1..W3 right + M1..M3 left; wave: a unison port along the bottom for each
stack plus an empty port for the next; unison: Vol/St/Ct
left). Tap a port to arm it ("Connecting…"), tap a valid source node to assign,
tap the port again to cancel; wires terminate at the consumer's port anchor,
routed as beziers that arc over/under any node card they'd otherwise cross
(`flowWirePath`). Connections are cleared by selecting a wire and long-pressing
it to delete (there is no ✕ on ports). **Every node is an always-visible widget card**
 (`flowWidgetRect`/`drawFlowWidget`) that shows its values read-only — a mini
 envelope/curve/spectrum plot for volumeEnv/env/wave, mini faders for unison,
 a ▶ play + Note-life slider for a note — **sized to fit exactly**
(`flowWidgetSize`; the single place to tune sizes, where a future per-node
  scale factor can fold in). **Tapping a card enters edit mode**: the node grows
  **in place** into its full editor (the panel is centered on the node's
  position via `flowEnvPanel`/`flowNotePanel`, clamped to the screen), and
  **tapping outside it shrinks it back** (editors close on an outside tap).
  Opening an editor also **pans the camera to center the node** (`panToNode`
  from `openFlowNodeEditor`), so the enlarged window settles mid-screen.
  The graph editors' window is a **fixed px size** (`flowEnvPanel`: 520×360 —
  it clamps down only to fit a small screen, never grows with the screen, so it
  stays a modest window on an iPad). Cards are drawn on a `rgba(20,20,24,0.92)`
  background; the enlarged editor overlay uses `rgba(14,14,16,0.74)`.

**Graph editors are gesture-driven (no mode toolbar).** The 📉 Envelope and 📈
Env curve overlays have **no Point/Draw/Delete buttons** — the gesture decides
the mode on each press inside the plot: grabbing a **dot** moves it; **tap +
drag empty space** adds a point and drags it; a **swipe starting in the left
edge strip** of the plot (`FLOW_ENV_DRAW_ZONE` = 26 px) scribbles draw mode;
**tapping a line segment** selects it and opens the line-mode strip **docked at
the top of the editor window** (Line/Stairs/Spring/Pulse pills + the active
type's params — no floating card over the plot). **Drag a dot off the graph and
release to delete it** — a 🗑 pill appears while it's outside the plot
(protected anchors and the last envelope component can't be deleted; the dot's
data stays clamped while its visual rides the finger). HOLD/CUT/REL marker tabs,
the trim slider, and the Clear pill are unchanged.

**Placement & spacing.** Nodes store a world-px centre (`x,y`, no grid); a node
"exists" at a spot when the point falls inside its widget card's bounds plus a
small pad (`flowNodeAt`, rect-based). The
**first node ever placed** (i.e. when no nodes exist yet) becomes the world
origin: `addFlowNode` shifts the camera by the node's position so it's stored
at `0,0` yet still appears exactly where it was placed — and the origin
re-anchors this way whenever a new first node is created after all nodes have
been deleted (mass delete or otherwise). A
**long-press** (500 ms) on an empty spot opens the **add menu** anchored there
 (`flowAddMenu` = `{x,y}` world coords); a **plain tap never opens it** — it only
 dismisses any open add menu (and clears selection). Long-press a **node** to
 enter move mode (it flashes); the next tap moves it anywhere. **Hold it longer
 still** (≥ `FLOW_HOLD_DELETE = 1200` ms) to start a **delete countdown** — the
 card turns red with a 3-2-1 (`FLOW_DELETE_MS = 3000`) overlay; releasing early
 cancels, reaching 0 deletes the node (`deleteFlowNode`). There is **no delete
 button** anywhere. Both adds and
moves then run **float-away separation**: the affected node is pushed out of
every neighbour until its centre is ≥ `FLOW_NODE_SEP = 190` px from the rest
(only that node moves — existing nodes stay put) and drifts there with a 250 ms
ease-out (`flowSepAnim`), leaving room for the wires. The camera pans with the
drift, so the node settles in the centre of the screen.

**No bottom bar.** Navigation is a read-only **node-list side bar**
(`flowSideRect`/`drawFlowSide`, left edge, `FLOW_SIDE_W = 250`): a ☰ button at
the **top-left** (`flowSideBtnRect`, overlaying the panel's header while open)
expands/collapses it; each row lists a node's emoji, type, and its position in
grid-cell units (world px ÷ `FLOW_CELL`, 2 decimals — the old grid's scale);
tapping a row pans the camera to it (`panToNode`) and the list
stays open — no selection/editing happens there. A red **🗑 Clear all** pill in
the panel header (`flowSideClearRect`) wipes every node and returns the camera
to the world origin — undoable, and undo restores the camera too (history
snapshots carry the camera, so every undo returns the view to where the action
happened). All editing (tap a widget to edit, long-press to move, longer hold
for the delete countdown, connect via ports) happens on the field. ↺ undo sits
top-right and the ‹ back-to-playing-field button sits **bottom-right**
(`flowTopButtonRects`/`flowTopHit`) — away from the editors' corners. The two
buttons are drawn **on top of the editor overlays** and win the pointerdown
hit-test, so the undo button stays visible and tappable while an editor is open
(no need to exit edit mode first — undo reverts the session's edits in place
and leaves the editor open). The
editor windows have **no ✕ button**; tapping anywhere outside a window closes
it (each editor's `*HandleDown` dismisses on an outside tap).

Persistence: nodes save under the same `growingTrees.flow.v1` key, storing their
world-px `x,y`; `loadFlow` migrates old `gx,gy` grid saves to cell centres,
migrates `envelope`→`volumeEnv`, parses `env`/`conn` (clamping via
`envCurveFromSaved`/`connFromSaved`), and prunes dangling ids. Edits are
coalesced into one undo entry per overlay session; undo **never leaves edit
mode** — it pops the session's snapshot, restores, and reopens the same editor
(`flowActiveEditId` + `openFlowNodeEditor`). If an open editor has **not**
changed anything yet, pressing undo does nothing (no unrelated earlier snapshot
is popped — `flowEditorPending` gates the pop).

## Maintenance Notes

- **Always bump the `#version` badge** (currently `v1.30.0`) after changes.
- **Never serve stale JS:** `index.html` loads its modules through an inline bootstrap that appends a per-load timestamp to every `<script src>` (`?t=Date.now()` via `document.write`), so the browser can't reuse a cached copy of any JS file. Don't replace it with plain static `<script src>` tags. The HTML document itself is covered by the `no-cache`/`no-store` meta tags in `<head>`.
- **Multi-file layout:** the page loads `js/app.js` → `audio.js` → `gesture.js` → `ui.js` → `main.js` in order. Classic scripts share globals: cross-file shared state is declared with `var` in `app.js`; per-file `const`/`let` stay file-local. Don't switch to ES modules (breaks `file://` testing) and don't reorder the tags.
- **Syntax check** each JS file after edits: `node --check js/*.js` (each file is plain JS).
- **No tree code:** tree planting/rendering was removed entirely (this is a gesture→note instrument now). Don't reintroduce trees without a design.
- Keep this guide lean: if the game's internals outgrow it, split deep details into their own `.agents/games/` file rather than padding this one.
