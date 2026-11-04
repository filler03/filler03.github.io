# Context-Aware Music Taste & Song-Building System

> Imported from the shared Google Doc on 2026-11-02 for implementation.
> Source: https://docs.google.com/document/d/1uySkz7WPLKC0w866c6MgPjIv7-9n7ZUL/edit
> The Google Doc is the living source; this copy is the implementation reference.

Context-Aware Music Taste & Song-Building System
Implementation plan for an AI coding agent
Goal: build an exploratory music system that starts from available instrument sounds, lets the user audition combinations and transformations, learns what the user likes in context, and uses those learned preferences to construct songs whose sections can evolve in mood, genre, instrumentation, and musical behavior while still flowing coherently.
1. Core Product Idea
The system should learn preferences as observations, not as universal rules. A positive reaction to a filtered guitar in a sparse, tense buildup should not become “always use filtered guitar.” The stored preference should retain the musical context, the relationships to other sounds, and the position within the song.
* Begin with a library of playable instrument sounds supplied by the user.
* Allow sounds to be layered, transformed, filtered, sequenced, and assigned musical roles.
* Present controlled alternatives and collect explicit user reactions: like, dislike, stronger/weaker preference, skip, or neutral.
* Learn both broad tendencies and context-specific tendencies from those reactions.
* Create songs as a sequence of sections, with per-section musical state and explicit transitions between states.
* Persist the taste model across songs, while retaining song-specific decisions separately.
2. Guiding Model
Taste Profile
 -> Song
     -> Sections
         -> Section musical state
         -> Instrument instances
             -> Source sound
             -> Role
             -> Performance properties
             -> Sound transformations
         -> Relationships between instruments
         -> Transition to next section
     -> User observations / reactions
A useful rule for the implementation: preserve the raw observation forever. Derived preference summaries can be recalculated as the ranking model improves.
3. Musical Data Model
3.1 Instrument source library
Treat an instrument sound as source material rather than as a complete instrument definition. One source can produce many playable variants through synthesis parameters, filters, effects, layering, pitch range, envelopes, or other transformations.
instrument_source:
 id: inst_guitar_clean_01
 name: Clean Electric Guitar 01
 family: guitar
 source_file: audio/guitar/clean_01.wav
 tags: [electric, clean, bright]
 native_register: mid
 metadata:
   duration_ms: ...
   sample_rate: ...
3.2 Sound variants / processing chains
Do not duplicate an audio asset every time it is changed. Store a reference to the source plus a reproducible processing chain. Render/cache audio only as an optimization.
sound_variant:
 source_id: inst_guitar_clean_01
 processing:
   - type: filter
     mode: low_pass
     cutoff_hz: 2400
     resonance: 0.25
   - type: distortion
     drive: 0.35
   - type: reverb
     mix: 0.18
Possible processors: high/low/band-pass filters, EQ, compression, saturation/distortion, delay, reverb, chorus/flanger/phaser, pitch/octave changes, stereo width/pan, transient shaping, envelopes, gating, bit reduction, and automation over time. Implement processors as typed parameter objects so new processor types can be added without restructuring song data.
3.3 Section musical state
Each section owns a musical state. These values are defaults or descriptors for the section, not hard constraints on every instrument.
* Section role: intro, verse, buildup, chorus/drop, breakdown, bridge, climax, outro, or custom.
* Mood: one or more weighted descriptors, e.g. reflective 0.8 + uneasy 0.3.
* Genre/style influences: weighted rather than single-choice where useful.
* Tempo/BPM and meter.
* Tonal center/key/scale or atonal flag.
* Harmony/chord progression.
* Energy/intensity.
* Overall density.
* Dynamics/loudness target.
* Texture description.
* Duration/bars.
3.4 Instrument instance within a section
An instrument instance is a source/variant being used for a particular role during one section. The same source can have completely different settings in another section.
instrument_instance:
 id: layer_17
 source_id: inst_guitar_clean_01
 role: rhythmic_support
 variant: <processing chain>
 rhythm:
   pattern_id: rhythm_42
   activity: 0.60
   syncopation: 0.35
 pitch_material:
   register: mid_high
   octave_range: [4, 5]
 dynamics:
   level: 0.70
   variation: 0.20
 articulation: [short, accented]
 density: 0.55
 spatial:
   pan: -0.25
   width: 0.45
3.5 Relationships matter
Store relational features because the user may like a combination rather than either ingredient independently. Examples: bass below piano, dry vocal over wet pads, sparse lead over dense rhythm bed, call-and-response between two instruments, or a sound entering only after another drops out.
relationship:
 type: register_separation
 participants: [bass_01, piano_02]
 attributes:
   ordering: bass_below_piano
   separation_semitones: 18
4. Preference / Taste Model
4.1 Raw observations
Every interaction should create an immutable observation. This is the most important stored object because it prevents the program from overgeneralizing and allows future algorithms to relearn the taste profile.
observation:
 id: obs_000184
 timestamp: ...
 action: prefer_a_over_b
 strength: 0.85
 candidate_a: <snapshot or reference>
 candidate_b: <snapshot or reference>
 context:
   song_id: song_12
   section_id: sec_04
   section_role: buildup
   mood: {tense: 0.8, energetic: 0.6}
   genre: {electronic: 0.7, rock: 0.4}
   energy: 0.68
   density: 0.42
   neighboring_sections: [sec_03, sec_05]
   active_instruments: [...]
 reason_tags: []
 notes: null
4.2 Derived preference rules
Periodically derive compact preference summaries from observations. They are caches, not ground truth. Give each rule support and confidence so one reaction does not become a permanent rule.
preference_rule:
 target:
   instrument_family: guitar
   timbre: distorted
 conditions:
   section_role: climax
   min_energy: 0.7
   vocal_exposure: low
 preference_score: 0.82
 confidence: 0.64
 positive_examples: 7
 negative_examples: 2
 source_observation_ids: [...]
4.3 Preference levels
* Global: tendencies that generalize across many contexts.
* Contextual: e.g. likes piano when mood is reflective and density is low.
* Combinational: preferences about simultaneous elements.
* Sequential: preferences about what follows what.
* Transformation: preferences for filters/effects/timbres under particular conditions.
* Structural: preferences for section length, recurrence, contrast, buildup, climax placement, etc.
* Novelty tolerance: how far generation can deviate from known preferences.
5. Human Feedback Workflow
Use comparison rather than asking the user to describe everything verbally. Pairwise A/B choices are especially valuable because they reveal preference while controlling context.
* Choose an initial instrument source or small set of sources.
* Generate/audition several variants that change one or a small number of dimensions.
* User marks like/dislike/neutral or chooses A vs B; optionally marks strength.
* Persist the full context and exact candidate configurations.
* Prefer comparisons that are informative: uncertain areas of the taste model, new combinations, or controlled changes to a known-liked idea.
* Occasionally re-test an established preference in a different context to learn its boundaries.
* Do not force every reaction into a rule. Preserve uncertainty and contradictory observations.
6. Building a Song Section by Section
Phase A - establish a section
* Choose section intent: role, mood, genre/style blend, energy and desired direction.
* Select candidate instruments using learned preferences plus an exploration allowance.
* Assign each instrument a role.
* Generate performance properties and processing variants.
* Audition alternatives and gather feedback until the section has an accepted core.
* Freeze accepted aspects while allowing the user to continue exploring individual layers.
Phase B - propose the next section
Generate the next section as a transformation of the current musical state rather than an unrelated block. Mood and genre are allowed to shift. The transition generator should decide what remains continuous, what changes, and how quickly.
* Carry an instrument, motif, chord, rhythm, ambience, or processing tail across the boundary.
* Change density gradually or deliberately cut it for contrast.
* Introduce a new section instrument before the boundary when a smoother handoff is desired.
* Reuse a motif with a different instrument/register/harmony.
* Allow tempo, key, genre, and mood changes, but score the transition based on continuity anchors and user-learned sequential preferences.
7. Transition Object
transition:
 from_section: sec_02
 to_section: sec_03
 length_bars: 2
 changes:
   energy: [0.45, 0.78]
   density: [0.35, 0.70]
   tempo_bpm: [96, 104]
 continuity:
   retained_motif: motif_03
   retained_instrument: pad_02
 techniques:
   - filter_open
   - percussion_addition
   - reverb_tail
 user_rating: 0.9
Transitions should receive their own feedback. A user may like Section A and Section B independently but dislike how the system connects them.
8. Text-Readable Storage Layout
Recommendation: start with version-controlled YAML files plus audio assets. YAML is easy for a person and an AI agent to inspect/edit. If scale later makes queries slow, introduce SQLite as an index/cache while keeping YAML/JSON export as the durable human-readable representation.
project/
 schema/
   version.yaml
 library/
   instruments.yaml
   processors.yaml
   rhythm_patterns.yaml
   motifs.yaml
 taste/
   profile.yaml
   observations/
     2026-11.yaml
   derived_preferences.yaml
 songs/
   song_001/
     song.yaml
     sections/
       001_intro.yaml
       002_buildup.yaml
       003_chorus.yaml
     transitions.yaml
     feedback.yaml
 audio/
   sources/...
   cache/...
Use stable IDs everywhere. References should use IDs rather than names because names are editable. Put a schema_version field on every top-level file. Avoid storing only derived scores; keep raw observations. Consider append-only observation files so feedback history is auditable and resilient.
9. Suggested Song File Shape
schema_version: 1
id: song_001
title: null
intent:
 starting_mood: reflective
 desired_arc: reflective -> tense -> energetic -> calm
sections:
 - ref: sections/001_intro.yaml
 - ref: sections/002_buildup.yaml
 - ref: sections/003_chorus.yaml
transitions_ref: transitions.yaml
generation:
 taste_profile_version: 12
 random_seed: 918234
 exploration_level: 0.25
status: draft
Store a random seed and generation settings so a candidate can be reproduced. A rendered waveform/audio file is an output artifact; the authoritative song representation should remain the structured configuration plus source assets.
10. Generation and Ranking Strategy
Use a candidate-generation/ranking loop rather than having the model make one irreversible choice.
* Generate N plausible candidates for an instrument, variant, section, or transition.
* Extract comparable features from each candidate.
* Score them against relevant preference rules, similarity to positively rated observations, transition coherence, and musical constraints.
* Add an exploration bonus so the highest-known preference is not selected forever.
* Present a small diverse subset to the user.
* Record feedback, update derived preferences, and repeat.
Keep separate scores for preference fit, musical validity/coherence, continuity with neighboring sections, and novelty. Do not collapse these too early; debugging is much easier when the UI can explain why a candidate ranked highly.
11. Application Architecture
* Audio engine: source playback, sequencing, layering, processing chain, automation, offline rendering.
* Music model: songs, sections, notes/events, harmony, patterns, instrument instances, transitions.
* Asset library: source audio and instrument metadata.
* Candidate generator: creates controlled musical alternatives.
* Feature extractor: produces attributes used by ranking and preference learning.
* Preference service: raw observations, derived rules, confidence, similarity/scoring.
* Song planner: establishes section sequence and high-level arc.
* Transition planner: proposes continuity/change between adjacent sections.
* Persistence layer: YAML first; optional SQLite index/cache later.
* UI: audition controls, A/B comparison, lock/freeze controls, section timeline, preference strength, undo/history.
* Renderer/exporter: reproducibly renders a complete song and optionally stems.
12. MVP Implementation Order
Milestone 1 - asset auditioning
* Import instrument sounds and metadata.
* Play individual sources.
* Layer multiple sounds synchronously.
* Apply serial processing chains with editable parameters.
* Save/load a sound variant.
Milestone 2 - feedback memory
* A/B and like/dislike UI.
* Immutable observation records with full context.
* Simple weighted preference summaries with support/confidence.
* Preference inspection screen showing evidence rather than only a mysterious score.
Milestone 3 - single-section composer
* Create a section state.
* Add instrument instances and assign roles.
* Generate/edit patterns, register, dynamics, articulation, density, spatial placement, and processing.
* Lock properties the user likes and regenerate unlocked properties.
Milestone 4 - multi-section songs
* Timeline of ordered sections.
* Clone/transform a section to seed the next one.
* Transition objects and transition feedback.
* Support intentional changes in mood/genre/tempo/key/density/instrumentation.
Milestone 5 - taste-guided generation
* Context-aware candidate scoring.
* Combination and sequential preferences.
* Exploration/diversity control.
* Cross-song profile persistence.
* New song creation from taste profile without copying an old song.
13. Important Design Rules
* Context first: never assume one liked attribute is universally preferred.
* Raw observations are permanent; derived models are replaceable.
* Properties can exist at song, section, instrument, relationship, and transition levels.
* A section is not tied to one genre or mood label; allow weighted blends and change over time.
* Separate source sound from processing/usage so one starting sample can become many variants.
* Make candidates reproducible using stable source IDs, parameters, and random seeds.
* Contradictions are valid data; model them rather than overwriting earlier preference.
* Prefer explainable ranking initially. Sophisticated ML can come later after meaningful feedback data exists.
* Allow user locks: if the user loves the drums but wants to explore bass, regeneration must not disturb the drums.
* Version schemas and migrations from the beginning.
14. Agent Build Brief
Build the MVP around a domain model, not around a particular UI framework. Start with the YAML schemas and a deterministic audio/candidate representation, then implement persistence, auditioning, feedback capture, and section composition. The first learning algorithm can be deliberately simple: weighted contextual similarity plus explicit positive/negative evidence. The architecture should permit replacing that scorer later without changing observation history or song files.
The key success criterion is not “generate a good song automatically.” It is: the program can repeatedly present meaningful musical choices, remember exactly what was preferred and under what conditions, construct a section from accepted choices, connect multiple sections, and reuse learned taste in later songs without treating contextual preferences as universal rules.
15. Visual Timeline and Attribute-Curve Editor
Add a visual composition surface that lets the user draw how musical attributes should evolve over time. This becomes the explicit intent layer for the current song. The taste profile fills in unspecified decisions, while controlled randomness prevents the generated result from becoming mechanically identical to the curves.
15.1 Timeline model
* Use a shared horizontal x-axis representing musical time. Support seconds, bars/beats, or both; store canonical positions in musical ticks or beats so tempo changes do not destroy alignment.
* Display section boundaries as labeled regions over the timeline: Intro, Build, Climax, Breakdown, Outro, or custom names.
* Allow curves to cross section boundaries. Sections describe intent and structure; curves describe continuous change.
* Provide zoom, horizontal scrolling, snapping to beats/bars/section boundaries, and free positioning.
* Use a playhead that moves during auditioning and highlights the current value of every visible lane.
* Allow selection of a time range for looping, regeneration, comparison, or focused editing.
15.2 Lane groups
Do not place every property on one graph. Use collapsible groups of aligned line-graph lanes. All visible lanes share the same time axis so relationships remain easy to see.
* Song-level lanes: energy, tension, overall density, brightness, harmonic complexity, melodic activity, rhythmic activity, tempo, dynamics, and perceived width.
* Mood lanes: separate weighted curves such as dark, hopeful, dreamy, aggressive, reflective, or user-defined descriptors.
* Genre/style lanes: separate influence curves such as ambient, electronic, rock, orchestral, jazz, or custom styles. Multiple influences may be active simultaneously.
* Section-level lanes: local overrides or curves applying only within a section.
* Instrument-level lanes: presence, prominence, register, dynamics, density, rhythmic activity, articulation intensity, brightness, filter cutoff, distortion, reverb, delay, pan, width, and other processor parameters.
* Relationship lanes where useful: register separation, call-and-response intensity, rhythmic overlap, or sidechain/ducking strength.
* Transition lanes: amount of continuity, transition intensity, rate of change, and effect-tail behavior.
15.3 Curve editing
* Create, drag, and delete control points.
* Support step, linear, smooth/spline, exponential, and hold interpolation.
* Allow points or ranges to be locked so generation cannot alter them.
* Allow curve copying between instruments, sections, and songs, with optional scaling or inversion.
* Provide presets such as gradual buildup, sudden drop, arch, pulse, repeated ramp, fade-in, and fade-out.
* Allow numeric editing for precise values in addition to direct drawing.
* Show an optional shaded variation band around the target curve.
* Display generated/realized values as a second line so the user can compare intent with the actual result.
15.4 Generic curve schema
Implement one generic automation-curve model rather than a separate data type for each attribute. Attribute definitions describe valid ranges, units, defaults, display labels, and whether a property is continuous, discrete, categorical, or weighted.
automation_curve:
 id: curve_song_energy_01
 attribute: energy
 scope:
   type: song
   target_id: song_001
 time_base: beats
 points:
   - position: 0
     value: 0.20
   - position: 32
     value: 0.30
   - position: 64
     value: 0.78
   - position: 96
     value: 0.95
 interpolation: smooth
 constraints:
   min: 0.0
   max: 1.0
   locked_ranges: []
 generation:
   variation: 0.08
   freedom: 0.15
   correlation_length_beats: 8
   random_seed: 48192
15.5 Attribute definitions
attribute_definition:
 id: filter_cutoff
 label: Filter Cutoff
 value_type: continuous
 unit: hz
 range: [20, 20000]
 display_scale: logarithmic
 applicable_scopes: [instrument, processor]
 default_interpolation: smooth
Categorical properties such as articulation should use timed regions, event markers, or weighted categorical lanes instead of forcing them into a numeric line. Mood and genre should be represented as multiple weighted curves, not as one mutually exclusive value.
16. Intent, Taste, Constraints, and Randomness
The generator should combine four distinct sources of direction. Keep their scores separate for explainability and debugging.
explicit timeline intent
 > hard locks and musical validity constraints
 > current song/section context
 > learned taste preferences
 > controlled randomness and exploration
Explicit values for the current song should normally outrank historical taste. If the profile predicts sparse intros but the user draws high intro density, the drawn curve wins. Taste should guide unspecified or loosely constrained choices, not override current intent.
16.1 Three controls per numeric intent
* Target: the desired center value at a point in time.
* Variation: the size of natural local fluctuations around the target.
* Freedom: how much the generator may depart from the target to improve musical coherence, satisfy relationships, or explore alternatives.
Randomness should not be independent noise at every time step, which would sound jittery. Generate smooth, temporally correlated variation whose rate matches the attribute. Dynamics may fluctuate relatively quickly; genre influence should usually move slowly. Store the seed so every result is reproducible.
16.2 Realization process
* Sample target curve values over the generation window.
* Apply locked values and hard constraints.
* Generate temporally correlated variation inside the variation band.
* Use freedom as a budget for deviations proposed by the composition/ranking engine.
* Score the candidate for curve fit, learned preference fit, musical coherence, transition continuity, and novelty.
* Retain the realized curve/values with the generated song so the UI can show where the output differed from the request.
* Let the user approve the deviation, regenerate it, or convert realized values into the new explicit curve.
17. Looping and Repetition
Treat loops as first-class timeline objects rather than merely repeating rendered audio. A loop can repeat notes, patterns, processing automation, or an entire section while still evolving toward later timeline targets.
loop_region:
 id: loop_build_01
 start_position: 48
 end_position: 64
 repetitions: 4
 mode: evolving
 retained_elements: [drum_pattern_03, bass_motif_02]
 variation:
   amount: 0.20
   cumulative: true
   allowed_attributes: [velocity, ornamentation, filter_cutoff, percussion_density]
 exit_behavior:
   align_to_following_curves: true
   transition_id: trans_04
17.1 Loop modes
* Exact: replay the underlying musical events and automation without variation.
* Humanized: preserve the pattern while slightly varying timing, velocity, articulation, or timbre.
* Varied: regenerate selected unlocked attributes independently each repetition.
* Evolving: progressively change allowed attributes across repetitions to approach the timeline values after the loop.
* Conditional: continue looping until a musical condition or user action, mainly useful during interactive auditioning.
The UI should let the user drag a loop range above the timeline, choose a repetition count or open-ended audition mode, select which properties may evolve, and preview individual iterations. Feedback can apply to one iteration, the loop as a whole, or the transition out of the loop.
18. Timeline-Oriented Storage Additions
songs/song_001/
 song.yaml
 timeline.yaml
 curves/
   song_attributes.yaml
   mood.yaml
   genre_influences.yaml
   instruments/
     guitar_01.yaml
     piano_01.yaml
 loops.yaml
 sections/...
 transitions.yaml
 realizations/
   generation_001.yaml
timeline.yaml should define the time base, tempo map, meter map, section boundaries, markers, and curve references. Keep source curves separate from generated realizations. This makes it possible to regenerate music with a new seed while preserving the exact visual plan.
timeline:
 time_base: ticks
 ticks_per_quarter: 960
 tempo_map:
   - position: 0
     bpm: 96
   - position: 61440
     bpm: 104
     transition: linear
 meter_map:
   - position: 0
     numerator: 4
     denominator: 4
 sections:
   - section_id: intro
     start: 0
     end: 30720
   - section_id: build
     start: 30720
     end: 61440
19. Timeline UI Layout
* Top ruler: bars/beats, clock time, markers, section boundaries, and loop ranges.
* Left lane browser: searchable hierarchy of song, mood, genre, section, instrument, relationship, transition, and processor attributes.
* Center editor: stacked line graphs sharing one x-axis.
* Right inspector: numeric point values, interpolation, variation, freedom, locks, applicable scope, and generator explanation.
* Bottom transport: play, pause, stop, previous/next section, loop toggle, candidate A/B, regenerate range, and render.
* Optional mini-map: condensed full-song overview for navigating long timelines.
* Visibility presets: Arrangement, Emotion, Rhythm, Harmony, Mix, Selected Instrument, and All Changed Attributes.
Avoid rendering hundreds of lanes at once. Virtualize lane rendering and show only selected groups. Curves should remain synchronized under zoom and scroll. Undo/redo should operate on semantic edits such as “move energy point” or “create loop,” not only raw file changes.
20. Updated Generation Workflow
* Create a song and define rough section regions.
* Draw the broad emotional/energy arc using song-level curves.
* Add mood and genre influence curves, including gradual morphs where desired.
* Choose initial instrument sources and assign roles.
* Draw or accept suggested instrument-level curves.
* Define loop regions and their variation/evolution mode.
* Generate several candidates for a selected range, section, or whole song.
* Compare candidates using the same curves and different seeds or generation freedom.
* Record preference feedback with the visual intent and realized values included in context.
* Lock accepted regions/layers, revise curves, and regenerate only what remains unlocked.
* Render the final mix and optional stems while preserving the complete structured project.
21. Additional MVP Milestone: Visual Composer
Insert this milestone after the single-section composer and before advanced taste-guided generation.
* Shared timeline with bars/beats, clock time, sections, and playhead.
* Generic automation-curve editor with control points and interpolation.
* Song-level energy, density, tension, brightness, and dynamics lanes.
* Instrument presence, register, dynamics, density, and basic effect lanes.
* Variation bands, freedom controls, deterministic seeds, and realized-value overlays.
* Loop range creation with exact, humanized, varied, and evolving modes.
* Range-based audition and regeneration while preserving locked material.
* YAML serialization for timeline, curves, loops, and generated realization data.
22. Revised Success Criteria
* The user can draw a multi-section musical arc over time without specifying every note.
* The user can independently shape song-level and per-instrument attributes on aligned timelines.
* The system can generate reproducible music that follows the drawn targets while applying controlled, musically appropriate variation.
* Mood and genre influences can blend and change over time.
* Loops can repeat exactly or evolve toward later section goals.
* Generated output exposes where and why it deviated from the explicit curves.
* Feedback records include intended curves, realized values, active context, relationships, and loop iteration where applicable.
* The learned taste profile assists generation without overriding explicit current-song instructions.
23. Composition Engine: Turning Intent into Musical Events
The remaining core subsystem is the realization engine that converts abstract intent curves into harmony, melody, rhythm, phrases, roles, notes, and audio. Treat this as hierarchical planning rather than mapping each curve value directly to a sound parameter.
intent curves and section goals
 -> structural planner
 -> role and instrumentation planner
 -> harmony planner
 -> motif and phrase planner
 -> rhythm/groove planner
 -> melody and accompaniment planners
 -> performance realization
 -> sound/processing realization
 -> analysis and scoring
 -> candidate ranking
Each stage should consume constraints from earlier stages and produce both musical output and an explanation of its choices. Generation should remain iterative: produce multiple candidates, analyze them, rank them, and retain the best diverse options for auditioning.
23.1 Composition hierarchy
song
 -> movement or large region (optional)
     -> section
         -> phrase group
             -> phrase
                 -> measure
                     -> beat/subdivision
                         -> musical event
* Use phrases as the main unit of musical thought; do not generate every measure independently.
* Allow phrases to repeat, answer one another, develop a motif, or provide contrast.
* Keep the large-region/movement level optional for shorter songs but available for long or strongly segmented forms.
* Store note events using musical time positions, pitch, duration, velocity, articulation, role, source motif, and generation provenance.
* Permit non-note events such as automation changes, rests, effect triggers, transitions, and sample launches.
24. Attribute Dictionary and Dependency System
Create a formal dictionary for every controllable or analyzed attribute. This prevents ambiguous meanings such as treating energy, loudness, and density as interchangeable. It also supplies the UI, validation layer, generator, and explainability system from one definition.
attribute_definition:
 id: energy
 layer: intent
 value_type: continuous
 range: [0.0, 1.0]
 anchors:
   0.0: extremely calm or inactive
   0.5: moderate perceived activity
   1.0: extremely energetic
 realization_influences:
   rhythmic_activity: {weight: 0.85, direction: positive}
   velocity: {weight: 0.70, direction: positive}
   density: {weight: 0.55, direction: positive}
   brightness: {weight: 0.35, direction: positive}
 scope: [song, section, instrument]
 rate_of_change: medium
 default_variation: 0.08
Organize attributes into distinct layers:
* Intent: mood, genre influence, energy, tension, emotional direction, familiarity, novelty.
* Musical character: density, brightness, rhythmic activity, harmonic complexity, melodic activity, register, predictability, syncopation.
* Structure: section role, phrase length, repetition, contrast, buildup, release, recurrence.
* Performance: notes, timing, duration, velocity, dynamics, articulation, microtiming.
* Sound: instrument source, envelope, filter, distortion, modulation, reverb, delay, spatial placement.
* Analysis: measured/estimated realization values produced from generated events or audio.
Dependencies should be probabilistic influences, not rigid formulas. High energy may often raise rhythmic activity and velocity, but a sparse, quiet, high-tension passage must remain possible. Permit explicit curves and constraints to override default dependencies.
24.1 Conflict handling and multi-objective scoring
Attribute combinations may intentionally conflict. The engine should search for a musically coherent compromise and report separate scores instead of hiding the tradeoff in one opaque number.
candidate_scores:
 explicit_intent_fit: 0.91
 musical_coherence: 0.88
 section_continuity: 0.94
 taste_fit: 0.82
 novelty: 0.57
 constraint_violations: []
 per_attribute_fit:
   energy: 0.95
   density: 0.97
   tension: 0.76
* Hard constraints must never be violated: locked material, unavailable samples, invalid ranges, required duration, or explicitly forbidden elements.
* Soft objectives may trade off: taste fit, curve fit, novelty, continuity, simplicity, and stylistic consistency.
* Expose user-adjustable objective weights, but provide sensible presets such as Faithful, Balanced, Experimental, and Transition-Focused.
* Preserve candidates with meaningfully different tradeoffs rather than returning nearly identical top results.
25. Motifs and Musical Memory
Model motifs explicitly so sections feel related. A motif is a reusable musical identity that may be melodic, rhythmic, harmonic, bass-oriented, percussive, textural, timbral, or a combination.
motif:
 id: motif_03
 kind: melodic_rhythmic
 events: [...]
 characteristic_intervals: [2, 3, -2]
 characteristic_rhythm: pattern_17
 importance: 0.8
 transformations_allowed:
   - transpose
   - fragment
   - rhythmic_augmentation
   - rhythmic_diminution
   - reharmonize
   - register_shift
   - instrument_change
   - simplify
   - ornament
* Track motif appearances and transformations across sections.
* Allow timeline lanes for motif presence, prominence, similarity to original, and transformation amount.
* Use motifs as continuity anchors when mood, genre, instrumentation, or tempo changes.
* Let the taste model learn preferences for recurrence patterns, e.g. an intro motif returning at the climax.
* Prevent excessive repetition by scoring both recognizability and development.
26. Roles, Instrument Capabilities, and Orchestration
Separate musical role from instrument identity. The planner first assigns needed roles, then selects instrument sources and variants capable of fulfilling them.
* Primary roles: lead, counter-melody, harmony, bass foundation, rhythmic pulse, percussion, atmosphere, drone, texture, accent, transition, and sound effect.
* One instrument may serve multiple roles, and a role may migrate to another instrument between sections.
* Role occupancy should be sparse by default; unused roles are valid.
* Instrument selection should consider capability, register, timbre, current section context, other active instruments, taste evidence, and novelty.
instrument_capability:
 source_id: inst_guitar_clean_01
 pitch_mode: pitched
 polyphony: polyphonic
 playable_register:
   comfortable_midi: [40, 88]
   extended_midi: [36, 96]
 role_affinity:
   rhythmic_pulse: 0.95
   lead: 0.78
   atmosphere: 0.42
 characteristics:
   attack: medium
   sustain: medium
   timbre_tags: [clean, bright, organic]
 supported_articulations: [sustained, short, muted, accented]
 processing_tolerance_tags: [distortion_friendly, filter_friendly]
For sample-based sources, capability metadata may be entered manually at first and enriched later through analysis. Never assume every sample can be stretched across all pitches or durations without artifacts; record safe pitch-shift and time-stretch ranges where relevant.
27. Harmony Subsystem
Represent harmony independently enough that it can be planned, transformed, analyzed, and constrained. The initial implementation can support common tonal harmony while leaving room for modal, chromatic, atonal, drone-based, or sample-led approaches.
* Tonal center, key, scale, or mode; allow no-key/ambiguous states.
* Chord symbols plus explicit pitches so generated voicings are reproducible.
* Chord function or tension category where applicable.
* Harmonic rhythm: when chords change and how frequently.
* Voicing, inversion, spacing, doubling, register, voice leading, and instrument allocation.
* Consonance/dissonance and harmonic-tension analysis.
* Modulation, borrowed harmony, pedal tones, drones, and transition pivots.
* Rules for non-chord tones in melodic and accompaniment parts.
harmony_plan:
 section_id: build
 tonal_center: D
 mode: dorian
 harmonic_rhythm_bars: 1
 events:
   - start_bar: 1
     duration_bars: 1
     symbol: Dm7
     pitches: [50, 57, 60, 64]
     tension: 0.28
 target_tension_curve: curve_harmonic_tension_build
The harmony planner should search for progressions and voicings that approximate the harmonic-tension curve while maintaining voice-leading quality and respecting genre/style influences. Store both the intended tension and the analyzed tension of the realized harmony.
28. Melody and Counter-Melody Subsystem
Generate melody at the phrase level using harmony, motifs, vocal/instrument capability, timeline intent, and section role. Expose melodic character rather than requiring the user to specify every note.
* Contour: rising, falling, arch, valley, wave, static, or custom curve.
* Range and register.
* Interval size and leap frequency.
* Rhythmic activity and note-length distribution.
* Repetition, motif similarity, variation, ornamentation, and predictability.
* Phrase length, pickup behavior, cadence strength, and breath/rest space.
* Harmony alignment, chord-tone emphasis, dissonance treatment, and resolution.
* Interaction: solo lead, call-and-response, unison, imitation, counterpoint, or background fill.
Counter-melodies should be generated in relation to the lead, with controls for overlap, independence, register separation, rhythmic complement, and moments of silence. The system should avoid filling every opening.
29. Rhythm and Groove Subsystem
Represent rhythm as patterns plus performance variation. Groove is relational: the quality of a drum pattern, bass line, and rhythmic instrument depends on how they interlock.
* Pulse, meter, beat hierarchy, and subdivision.
* Pattern length and phase relative to the section.
* Activity, complexity, syncopation, accent pattern, swing, and repetition.
* Microtiming, velocity variation, humanization, and quantization amount.
* Polyrhythm or cross-rhythm where enabled.
* Interlocking rules among percussion, bass, harmony, and lead roles.
* Fill placement, pickup patterns, transition gestures, and cadence rhythms.
* Pattern mutation across loop repetitions and section development.
rhythm_pattern:
 id: pattern_42
 meter: 4/4
 length_beats: 8
 subdivision: 16
 events: [...]
 features:
   activity: 0.62
   syncopation: 0.38
   complexity: 0.44
   swing: 0.08
 variation_policy:
   preserve_accents: true
   mutation_amount: 0.12
30. Silence, Space, and Presence
Silence must be generated intentionally. Add presence and rest concepts at song, role, and instrument levels so the system does not continuously fill the arrangement.
* Instrument-presence curves determine when a layer is active, fading, entering, leaving, or intentionally absent.
* Activity and density curves apply only while present; presence is not the same as low density.
* Phrase-level rest probability and preferred rest lengths.
* Dropout events for dramatic contrast or transition preparation.
* Reserve frequency, register, rhythmic, and spatial space for focal elements.
* Allow a section or transition to be defined partly by what is removed.
31. Feedback Vocabulary and Attribution
Preserve quick feedback while allowing optional attribution. A user should be able to respond rapidly, then specify what caused the reaction only when useful.
* Overall reaction: love, like, neutral, dislike, strongly dislike.
* Pairwise choice: A, B, no preference, or prefer a blend.
* Action feedback: keep, lock, regenerate, more like this, less like this, simplify, intensify.
* Optional target: instrument, pattern, motif, harmony, melody, sound design, combination, section, loop iteration, or transition.
* Optional reason tags: too busy, too sparse, too bright, too dark, repetitive, abrupt, predictable, unfocused, or custom note.
* Feedback scope: this moment only, similar contexts, this song, or general preference. Treat scope as user guidance, not absolute truth.
feedback:
 reaction: like
 strength: 0.8
 target_type: transition
 target_id: trans_04
 attribution:
   aspects: [motif_continuity, density_ramp]
   reason_tags: [smooth, satisfying_release]
 intended_scope: similar_contexts
When attribution is omitted, record the reaction against the whole candidate without guessing the cause. Later comparisons can isolate dimensions and infer likely contributors with confidence values.
32. Exploration, Novelty, and Taste Evolution
Taste guidance must not collapse generation into repetition. Keep exploration explicit and measurable.
* Expose taste adherence, timeline adherence, novelty, and structural risk as separate controls or named presets.
* Use uncertainty-aware selection: occasionally present candidates in areas where the model lacks evidence.
* Use diversity selection so audition choices differ meaningfully in instrumentation, musical strategy, or transition approach.
* Apply recency weighting without deleting older observations.
* Track evidence count, context diversity, confidence, contradictions, and last-supported date for each derived preference.
* Allow profile snapshots so a song can be regenerated against the taste model that existed when it was created.
* Support profile branches or named taste modes later, such as focused, experimental, ambient, or guitar-oriented, without duplicating raw observations.
preference_evidence:
 score: 0.74
 confidence: 0.61
 support_count: 9
 contradiction_count: 3
 context_diversity: 0.68
 recency_weighted_score: 0.79
 last_supported_at: ...
33. Intent, Realization, and Taste Maps
Formalize three related but separate maps. This separation is central to the product and should appear in the data model, UI, generation pipeline, and feedback records.
* Intent Map: the curves, regions, locks, section goals, and constraints explicitly authored for the current song.
* Realization Map: analyzed properties of the generated musical events and rendered audio, including actual instrument activity and deviations from intent.
* Taste Map: learned contextual preferences, evidence, uncertainty, and expected preference under the current conditions.
Intent Map
   + Taste Map
   + musical constraints
   + exploration settings
         -> generation and ranking
         -> Realization Map
         -> user feedback
         -> updated Taste Map
The UI should allow overlaying intent and realization curves. The difference between them is useful information, not automatically an error. The explanation panel should show whether a deviation resulted from a hard musical constraint, a higher-ranked tradeoff, learned preference, or random exploration.
34. Explainability and Provenance
Every generated section, instrument layer, event group, and transition should retain enough provenance to answer “why is this here?” without claiming certainty beyond available evidence.
* Which explicit curves and section goals influenced it.
* Which role requirement it satisfies.
* Which motif, pattern, harmony event, or earlier section it derives from.
* Which preference rules contributed and the confidence/evidence behind them.
* Which random seed and generation parameters produced it.
* Which constraints rejected competing choices.
* How strongly each scoring objective contributed to candidate selection.
generation_explanation:
 target_id: guitar_layer_04
 influences:
   - source: curve_song_energy_01
     contribution: 0.41
   - source: role_rhythmic_pulse
     contribution: 0.24
   - source: preference_rule_19
     contribution: 0.18
     confidence: 0.64
   - source: exploration
     contribution: 0.07
 derived_from: motif_03
 random_seed: 48192
Contribution values should be presented as model explanations rather than objective causal truth. If the implementation cannot calculate reliable numeric contributions, provide ranked qualitative reasons instead of fabricated precision.
35. Analysis and Validation Pipeline
After generation, analyze the structured events and, where useful, the rendered audio. This produces the Realization Map and validates that generation matches the requested plan.
* Event-level analysis: notes, rests, register, density, rhythmic activity, syncopation, melodic range, motif similarity, harmonic tension, dynamics, and role occupancy.
* Audio-level analysis: loudness, spectral brightness, onset density, stereo width, clipping, silence, and effect tails.
* Compare analyzed values with intent curves using time windows appropriate to each attribute.
* Flag hard failures separately from soft mismatches.
* Reject or repair candidates with invalid notes, sample gaps, severe clipping, impossible overlaps, or broken loop boundaries.
* Save analysis algorithm/version so realization maps can be recalculated later.
36. Expanded Persistence Model
project/
 schema/
   version.yaml
   attribute_definitions.yaml
 library/
   instruments.yaml
   capabilities.yaml
   processors.yaml
   patterns.yaml
   motifs.yaml
 taste/
   observations/...
   derived_preferences.yaml
   profile_snapshots/...
 songs/song_001/
   song.yaml
   timeline.yaml
   intent_map/...
   structure.yaml
   harmony.yaml
   motifs.yaml
   patterns.yaml
   sections/...
   transitions.yaml
   loops.yaml
   candidates/...
   realizations/generation_001/
     events.yaml
     realization_map.yaml
     explanations.yaml
     analysis.yaml
     render_manifest.yaml
Large note/event collections may eventually be better stored as MIDI, MusicXML, or a compact event format with a text-readable manifest. Preserve text-readable project metadata and stable references even if binary interchange files or cached audio are introduced. Define schema migrations, validation, and unknown-field preservation from the start.
37. Expanded Implementation Milestones
Milestone 6 - composition primitives
* Composition hierarchy and event schema.
* Attribute dictionary and dependency graph.
* Roles and instrument capability metadata.
* Basic motif, rhythm-pattern, phrase, and silence representation.
Milestone 7 - tonal composition engine
* Basic tonal harmony planner and voicing.
* Phrase-based melody and bass generation.
* Rhythm/groove planner for percussion and accompaniment.
* Motif recurrence and simple transformations.
* Multi-candidate generation with separate objective scores.
Milestone 8 - realization and explanation
* Intent-to-realization analysis.
* Intent/realization curve overlays.
* Generation provenance and why-this-exists explanations.
* Hard validation, soft mismatch reporting, and range-based repair/regeneration.
Milestone 9 - advanced preference learning
* Attributed feedback and contextual evidence.
* Combination, sequential, structural, and transformation preferences.
* Recency, contradiction, context diversity, and confidence handling.
* Uncertainty-driven exploration and diverse candidate selection.
* Taste snapshots and optional named profile modes.
Milestone 10 - broader musical language
* Modal, chromatic, drone-based, sample-led, and optionally atonal strategies.
* More advanced voice leading, modulation, counter-melody, polymeter, and groove handling.
* Additional instrument articulations and capability-aware performance.
* Import/export adapters and richer rendering workflows as required by the chosen platform.
38. Definition of a Complete Implementation Plan
The design is implementation-ready when the following decisions are encoded in schemas, interfaces, acceptance tests, or documented defaults rather than left implicit:
* Canonical musical time representation and tempo/meter behavior.
* Attribute dictionary, units, ranges, layer, applicable scopes, interpolation, and rate of change.
* Intent-to-musical-character dependencies and conflict-resolution policy.
* Composition hierarchy and event model.
* Role vocabulary and instrument capability schema.
* Harmony, melody, rhythm, motif, phrase, and silence representations.
* Candidate generation, objective scoring, diversity selection, and deterministic randomness.
* Intent Map, Realization Map, and Taste Map boundaries and data ownership.
* Feedback vocabulary, attribution, confidence, contradictions, and taste evolution.
* Loop semantics, section transitions, regeneration boundaries, and lock behavior.
* Explainability/provenance requirements.
* Persistence layout, versioning, validation, migration, caching, and export expectations.
* MVP acceptance scenarios and quality checks for each milestone.
At that point, remaining choices should mainly be engineering decisions: programming language, UI framework, audio engine, plugin architecture, deployment target, performance tuning, and model implementation. Those technical choices should be selected after confirming the target platform and the formats of the starting instrument sounds.
39. Acceptance Scenarios for the Full System
* Create a song with five sections whose mood, genre influence, energy, density, and instrumentation vary continuously over the timeline.
* Use one motif in the intro, transform it in the buildup, and return it with another instrument at the climax.
* Create an evolving four-repeat loop that adds rhythmic activity and opens a filter while preserving the core bass motif.
* Lock the accepted drums and harmony, redraw the guitar density curve, and regenerate only the affected guitar material and dependent mix realization.
* Generate three diverse transition candidates between contrasting genres while preserving a chosen continuity anchor.
* Explain why an instrument, pattern, chord, and transition were selected and identify the evidence/constraints used.
* Show intended versus analyzed realization curves and allow the user to accept a generated deviation as the new intent.
* Record that the user liked a sound only in the present context, then avoid incorrectly treating it as a universal preference in a later song.
* Recreate an earlier candidate exactly from stored sources, configuration, model versions where available, and random seed.
* Open the text-readable project files and trace the song from source assets through sections, curves, generated events, feedback, and preference evidence.
