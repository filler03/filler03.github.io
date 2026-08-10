# Tree Creation Logic (`public/games/growing_trees.html`)

Walkthrough of how a tree is created, from touch to finished bitmap.

## 1. Gesture → note
A drag in `plant` mode is broken into lines (sharp turn = new line, turn on last line or finger-lift = release). `finishPlantGesture` → `plantAt()` (growing_trees.html:1049). Each line's length and Y-change map to `attack`/`decay`/`hold`/`release` ms (fixed components get their preset values).

In live-sound mode the tree is planted when the *first* line completes (`plantLiveTree`, :1097) and rebuilt bigger as later lines stretch the envelope (`refreshLiveTree`, :1115).

## 2. Placement
Screen touch is un-projected with `toWorld()`; `depth = (w.y - HORIZON) / (H*0.42)` picks scene depth (0 far → 1 near). The trunk base sits at `groundYFor(depth)` — so it sprouts under the fingertip, but depth only affects *where*, never *size*. Pitch comes from horizontal X.

## 3. Sizing (`Tree.targetSize`, :902)
The **woody window** `attack + decay + hold` (min 120ms) vs `FULL_GROW_MS = 6000` gives a `sizeFactor`, further scaled by the sustain level:
- `scale = 0.7 + 1.3 * sizeFactor` (branch/footprint scale)
- `maxDepth = 2 + round(sizeFactor*6)` (2–8 levels — big trees bushier)
- `trunkHeight` derived from `sizeFactor^0.5`

## 4. Growth caps (`Tree.applyNote`, :942)
Each part's *amount* is capped by its note segment at the fixed `GESTURE.growSpeed`:
- Trunk: `attack / (20/speed)` — `trunkCap`
- Branches: `(decay+hold) / (500/speed)` — `branchCap`
- Leaves/fruit: `release / (1200/speed)` — `foliageCap`

Phase windows: trunk ends at `attack`, branches end at `attack+decay+hold`, total at + `release`.

## 5. Structure (`Tree.buildStructure` + `Branch.build`, :919 & :661)
A trunk `Branch` is created pointing up; `build()` recursively spawns 1–3 children per branch (spread ±0.7 rad, length 62–84% of parent, thickness 72%), leaves at tips (3–6), fruit for some `SPECIES` (apple, cherry, etc., by `chance`). Everything is pre-built up front.

## 6. Growth + render
`update()` drives `grown` from **elapsed time** (so a 5ms attack still completes): trunk does 60% (`TRUNK_ATTACK_FRAC`) during attack then slowly fattens through the branch window; branches grow across decay+hold; leaves/fruit bloom during release. Once `tTotal` passes, `bake()` caches the finished tree to an offscreen bitmap (:990) for cheap depth-sorted blits.
