# Context-Aware Music System — Implementation Breakdown

Source spec: [context-aware-music-system.md](context-aware-music-system.md)
Target: `public/sandbox/song-canvas/proto-8/` (working name **Taste studio**), on the
existing sampled-instrument library.

This is the working plan, not a claim that the full spec is implemented. The spec
describes roughly ten milestones; v0.1 covers the first two as a vertical slice so
the data model and feedback loop can be tested before the timeline and composition
engine are built.

**Status (2026-11-02):** v0.1 is implemented at
`public/sandbox/song-canvas/proto-8/` and verified in headless Chrome. It is not
committed or pushed.

## Review round 1 — scope and constraints

The full spec combines five products:

1. A sample/variant library and auditioning instrument.
2. An explicit-intent timeline and curve editor.
3. A contextual taste model built from immutable feedback.
4. A section/transition song planner.
5. A composition/realization/analysis engine that turns intent into notes and audio.

Building them in that order is sensible, but building all five at once is not. The
first vertical slice must prove the most important product claim: **a preference can
be captured with its context, and the system can show the evidence without turning
one reaction into a universal rule.**

Constraints found while mapping the spec to this repo:

- The static site has no build step and no npm dependencies. The browser app must
  use classic `<script src>` files and Web Audio.
- The 50 available sounds are 20-second preview MP3s, not multisample source
  libraries. They are usable as source material for auditioning and processing, but
  not for a production sampler with safe pitch/time stretching. The UI must say so.
- The previews are committed under `public/sandbox/song-canvas/instruments/previews/`;
  the raw SF2s and render tools are only in `/tmp` and are not web assets.
- The spec recommends YAML as the durable format. A browser-only app would need a
  parser dependency or a hand-written parser. v0.1 uses JSON as the runtime and
  export format, keeps stable IDs and `schema_version`, and leaves a YAML export
  adapter for later. The spec's schema is otherwise followed.
- The full time/tempo/meter model, curves, loops, harmony, melody, rhythm, and
  generation ranking are deferred; v0.1 must not pretend to implement them.
- Persistence is local to the browser for now. The spec's cross-song profile is
  satisfied within one browser profile; there are no accounts or server storage.
- FreePats GM previews are GPLv3 with an exception; individual FreePats previews are
  CC0; Tone.js previews are CC-BY 3.0. Attribution stays in
  `instruments/CREDITS.md`; proto-8 links to it.

## Review round 2 — architecture decisions

- **Isolation:** new `proto-8/` folder; do not destabilize proto-7 or the AI backend.
  The backend still renders through the proto-4 engine until a real sample engine is
  designed.
- **Model first:** `model.js` owns schema normalization, stable IDs, JSON
  persistence, observation append-only behavior, and preference derivation. It is
  pure enough to test without audio.
- **Audio second:** `engine.js` owns Web Audio only. It builds a chain from typed
  processor objects; it does not know about taste or DOM.
- **UI third:** `app.js` coordinates the model, engine, and DOM. It records the exact
  candidate snapshots that were heard.
- **Source of truth:** the raw observation array is the source of truth. Derived
  preferences are recalculated caches with support/confidence; they are never edited
  directly.
- **Reproducibility:** variants store source IDs and processor parameters, not
  rendered audio. A/B mutations are deterministic given a seed; the seed is stored.
- **Scope of v0.1:** two source layers, a typed processor chain (filter, drive,
  delay, reverb, pan, gain), A/B comparison, contextual observations, a simple
  evidence summary, saved variants, and JSON import/export.
- **Library metadata:** derive family/role tags from a small key map, not from
  filenames. The library remains the 50 clean sources; no duplicate GM fallbacks.

## Review round 3 — v0.1 acceptance and UX

The slice is accepted when:

- The page loads 50 sources from `../instruments/manifest.json` with no console
  errors, and the library can be filtered by family.
- Two sources can be layered, each with independent level, filter, drive, delay,
  reverb, and pan controls; Play/Stop works and Loop is available.
- A candidate can be captured as A and B; a B suggestion changes a bounded dimension;
  the user can audition A and B; A/B snapshots preserve the exact layer configs.
- Feedback records an immutable observation with action, strength, candidate
  snapshots, and context (song/section IDs, role, mood, genre, energy, density).
- The evidence panel lists observations and derived preferences with support and
  confidence, grouped by context rather than presented as a universal rule.
- Saved variants survive reload; export produces a JSON project file; import
  restores observations and variants without rewriting old observations.
- The page is usable on a phone and does not require a build step.
- The existing instrument library and hub links still work.

Not in v0.1: visual timeline, automation curves, loop regions as musical objects,
section sequencing, transitions, harmony/melody/rhythm planners, candidate ranking,
synthesis generation, audio analysis, and ML. Those are the next pieces, not hidden
inside this one.

## Pieces

### Piece 0 — Spec and decisions (this pass)
- Save the shared doc under `.agents/specs/`.
- Record the three review passes and the v0.1 boundary.

### Piece 1 — Domain model and persistence
- `model.js`: library loading, source metadata, variant/observation factories,
  normalization, localStorage, JSON import/export, preference summaries.
- Storage keys are versioned; observations are append-only; old unknown fields are
  preserved on export where practical.

### Piece 2 — Sample audition engine
- `engine.js`: Web Audio context, buffer cache, layer graph, typed processors,
  A/B deck playback, fade in/out, loop, safe master limiting.
- One shared graph per candidate; stop disconnects all nodes.

### Piece 3 — UI and feedback loop
- `index.html`, `style.css`, `app.js`: source browser, two-layer deck, processor
  controls, context panel, A/B bar, feedback bar, evidence panel, saved variants,
  import/export.
- Expose a small test API (`window.TasteLab`) for headless checks.

### Piece 4 — Integration and verification
- Add the proto-8 card to the Song Canvas hub.
- Headless Chrome: load, select sources, capture A/B, record an observation, reload,
  verify persistence, check no page errors.
- Keep the credit/link to `instruments/CREDITS.md`.

## Review round 4 — implementation pass

Implemented v0.1 in `public/sandbox/song-canvas/proto-8/` and reviewed it against
the acceptance list above. Findings and fixes:

- A/B on the same source initially produced only a neutral 50/50 source rule. Added
  transformation-level evidence (brighter/darker filter, more/less drive, more/drier
  space, more/less echo) so a controlled change can be learned without pretending
  the source itself changed.
- Added a genre-influence context field and strength, since the source spec treats
  mood and genre as separate contextual dimensions.
- Added favicon data so the page has no stray 404s.
- Preload all layer buffers before scheduling playback so layers start together;
  cancel in-flight play requests on stop; clean up partially built graphs; cap the
  decoded-buffer cache.
- Sanitize imported and stored observations/variants, preserve raw records on append,
  and surface storage-quota failures instead of reporting a false save.
- Count support per distinct observation, not per evidence event; contextual rules
  now carry role, mood, genre, energy band, and density band.
- Verified 50 source cards, two-layer capture, A/B suggestion, observation writing,
  preference derivation, variant save/load, reload persistence, audio playback,
  corrupt-storage recovery, import/export, and no page exceptions in headless Chrome
  at desktop and phone widths.
- Added live deck-control updates while the deck is playing; source/layer/variant
  changes stop the current playback so the UI never edits the wrong sound.
- Added the 20-second-preview disclaimer and accessible source/layer controls.
- Kept the v0.1 scope honest: no timeline, curves, sections, transitions, generation,
  or ML is claimed here.

## Later slices (mapped to the source spec)

1. **Timeline and curves** (spec §15–21): shared beat/bar ruler, generic automation
   curves, intent/realization overlays, loop regions.
2. **Section composer** (spec §6–7, §23): section state, roles, instrument instances,
   transition objects, locks.
3. **Composition primitives** (spec §23–30): harmony, melody, rhythm, motifs, silence.
4. **Generation and ranking** (spec §10, §16): candidate generation, separate scores,
   diversity, seeds, explanations.
5. **Advanced taste** (spec §31–35): attribution, contradictory evidence, recency,
   context diversity, profile snapshots, analysis pipeline.
6. **Broader language and export** (spec §36–39): YAML/MIDI/MusicXML adapters,
   modal/atonal strategies, stems, migrations.

## Decisions to revisit

- Full source samples vs. the current 20 s previews: the previews are a prototyping
  compromise, not a production sampler library.
- JSON vs. YAML runtime format and the export adapter.
- Whether the eventual home is Song Canvas, Growing Trees, or a separate app path.
- Server-side persistence for cross-device taste profiles.
- The exact scope of the first generated-song milestone after the auditory/feedback
  slice.

## v0.2 — Section curves and one-attribute discovery (proto-9)

**Status (2026-11-02):** implemented at `public/sandbox/song-canvas/proto-9/` and
verified in headless Chrome. Not committed or pushed.

Scope added this pass:

- A 20-second section loop over source previews, presented as 8 projected bars at
  96 BPM with two sampled layers. The preview is not yet bar-aligned audio.
- Six curve lanes: energy, density, brightness, space, grit, motion.
- Each lane can be **specified** (drawn curve) or **auto** (the AI decides later).
- One **discovery focus** lane at a time; its variation is a temporary offset around
  the curve/default while the section loops. A variation advances each loop by
  default, or on demand.
- **Locks** per lane plus an **Effects locked** group control. Locked effects are not
  randomized; focus moves to an unlocked attribute.
- **Like this loop** records a guide snapshot: curve state, locks, focus, variation,
  sources, and sampled effective values.
- **Guide JSON** export marks every auto attribute with `ai_decides: true` and carries
  the explicit curves and liked variations. The export note says the final song must
  re-realise the intent rather than replay the preview.
- Reuses the proto-8 sample engine for playback and live layer updates, with a
  section-length loop end; no new dependencies.
- Removed the per-effect sliders from the main path. The graph, source picks, focus,
  locks, Like, and Next are the primary controls.

Review pass on v0.2 found and fixed:

- Section source normalization had to preserve source URLs when reloading/saving with
  an empty source map; save now receives the live library map.
- Effect-lock group state now follows individual lane locks and unlocks correctly.
- Pointer dragging was verified after removing a redundant pointer-id guard; graph
  clicks add points, drags move them, and the loop keeps playing.
- Auto-next was verified across a real 20-second loop boundary.
- Later review: corrupt/older likes are normalized or ignored instead of bricking
  boot; the effects group preserves individual lane locks; auto-next defers lane
  re-render while a point is being dragged; point hit-testing is in pixels and
  supports double-click/double-tap deletion; drive curves are cached; and the
  8-bar label is marked as a projection over 20 s previews.

Not in v0.2: section ordering, transitions, harmony/melody/rhythm realization, final
audio rendering, sample-library replacement, and cross-device profile storage.
