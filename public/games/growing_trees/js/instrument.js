/* ============================================================
   instrument.js — the instrument selector strip across the top
   of the playing field. The legacy 🎛️ sound creator is gone; a
   gesture now plays whichever flow-editor note is picked here.

   One chip per READY note node (flowNoteReady: has a volume env
   and at least one connected layer with a wave). The strip is a
   horizontal row of colored rectangles, each showing its note's
   name on the note's color. As long as at least one note is ready,
   a note is ALWAYS selected — "no instrument" is not an option, so
   a chip tap just switches instruments. Only when no ready note
   exists does the strip show a dashed "No instrument" chip and the
   field go silent. Selecting swaps the shared sound globals
   (ENVELOPE / OSC_STACK / MASTER_PITCH_ENV / MASTER_VOICE_ENVS) to
   the compiled flow note, so gestures, taps, and live mode all
   play it. With no instrument the layers are emptied
   (OSC_STACK.layers = []) — the envelope still schedules but
   nothing sounds, so paths draw and the page stays silent.

   flow.js calls window.onFlowGraphChanged() from saveFlow() after
   every graph mutation, so this module re-renders the strip and
   re-applies the active instrument (edits to it are heard live in
   the playing field; if the active note is deleted or stops being
   ready while others remain, the first ready note is picked; only
   when nothing is ready does it fall back to the silent state).
   Loaded last, after flow.js and after main.js's
   loadSavedSettings().
   ============================================================ */

const instBar = document.getElementById('instrumentBar');
const INST_SAVE_KEY = 'growingTrees.instrument.v1';
var instActiveId = null;   // the selected note's id, or null (no ready notes = silent)

// The ready note nodes, in grid order.
function instReadyNotes() {
  return flowNodes.filter(n => n.type === 'note' && flowNoteReady(n));
}

// The "no instrument" globals: no layers means no oscillators are built, so the
// playing field schedules its envelopes into silence. The envelope is kept so a
// later selection only swaps the layers/pitch fields in.
function instSilentGlobals() {
  return { envelope: clone(ENVELOPE), layers: [], masterPitchEnv: null, masterVoiceEnvs: { st: null, ct: null, vol: null } };
}

// Put compiled flow-note globals (or a silent set) into the shared sound
// variables that the playing-field schedulers read.
function instApplyGlobals(glob) {
  ENVELOPE = glob.envelope;
  OSC_STACK = { layers: glob.layers };
  MASTER_PITCH_ENV = glob.masterPitchEnv;
  MASTER_VOICE_ENVS = glob.masterVoiceEnvs;
}

function instPersist() {
  try { localStorage.setItem(INST_SAVE_KEY, JSON.stringify({ id: instActiveId })); } catch (err) {}
}

// Select a note as the active instrument and apply its sound. `id` must be a
// ready note (the strip only renders ready chips); an unready/stale id is a
// no-op rather than a silent fallback.
function instApply(id) {
  const compiled = compileFlowNote(flowNodeById(id));
  if (!compiled) return false;
  instActiveId = id;
  instApplyGlobals(compiled);
  instPersist();
  instRender();
  return true;
}

// Drop to the silent "no instrument" state — only valid when no note is ready
// (callers decide that; the strip shows the empty chip in that case).
function instClear() {
  instActiveId = null;
  instApplyGlobals(instSilentGlobals());
  instPersist();
  instRender();
}

// Rebuild the strip. With at least one ready note, show only the note chips
// (one is always selected). With none, show the dashed "No instrument" chip.
// Names are user input, so chips are built with textContent only.
function instRender() {
  const bar = instBar;
  if (!bar) return;
  bar.textContent = '';
  const notes = instReadyNotes();
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'inst-chip inst-empty';
    empty.dataset.id = '';
    empty.textContent = 'No instrument';
    empty.classList.add('selected');
    bar.appendChild(empty);
    return;
  }
  for (const n of notes) {
    const chip = document.createElement('div');
    chip.className = 'inst-chip';
    chip.dataset.id = n.id;
    chip.style.background = flowNoteColor(n);
    chip.textContent = flowNoteName(n) || FLOW_NODE_TYPES[n.type].label;
    if (n.id === instActiveId) {
      chip.classList.add('selected');
      const check = document.createElement('span');
      check.className = 'inst-check';
      check.textContent = '✓';
      chip.insertBefore(check, chip.firstChild);
    }
    bar.appendChild(chip);
  }
}

if (instBar) {
  instBar.addEventListener('click', e => {
    const chip = e.target.closest('.inst-chip');
    if (!chip || !chip.dataset.id) return;   // the empty chip is only shown when there is nothing to pick
    instApply(chip.dataset.id);
  });
}

// Called by flow.js's saveFlow() after every graph mutation: keep the strip in
// sync and re-apply the active instrument so edits are heard live in the
// playing field. While the flow editor is open (flowActive), the globals are
// temporarily swapped to whatever overlay the editor is working on — re-applying
// the instrument here would replace that working layer with a compiled copy and
// the editor's edits would be lost (the "snaps back" bug). So while in flow
// mode we only skip the swap; closeSoundFlow() ends with a saveFlow() after
// flowActive clears, which is when the refreshed instrument is re-applied.
// Outside flow mode, if the active note was deleted or stopped being ready,
// pick the first ready note; only when nothing is ready does the field fall
// back to silent.
window.onFlowGraphChanged = function () {
  if (flowActive) return;
  const active = instActiveId ? flowNodeById(instActiveId) : null;
  if (active && flowNoteReady(active)) {
    const compiled = compileFlowNote(active);
    if (compiled) {
      instApplyGlobals(compiled);
      instRender();
      return;
    }
  }
  const notes = instReadyNotes();
  if (notes.length) instApply(notes[0].id);
  else instClear();
};

// Boot: the shared globals were just restored by loadSavedSettings() (main.js),
// so re-apply the saved instrument on top if its note still exists and is ready;
// otherwise pick the first ready note, or start silent when none exist.
(function instInit() {
  if (!instBar) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(INST_SAVE_KEY) || 'null'); } catch (err) {}
  const id = saved && saved.id ? String(saved.id) : null;
  let target = null;
  if (id) {
    const n = flowNodeById(id);
    if (n && flowNoteReady(n)) {
      const compiled = compileFlowNote(n);
      if (compiled) target = { id, compiled };
    }
  }
  if (!target) {
    const notes = instReadyNotes();
    if (notes.length) target = { id: notes[0].id, compiled: compileFlowNote(notes[0]) };
  }
  instActiveId = target ? target.id : null;
  instApplyGlobals(target ? target.compiled : instSilentGlobals());
  instPersist();
  instRender();
})();