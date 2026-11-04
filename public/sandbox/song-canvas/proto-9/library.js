(() => {
  'use strict';

  const rows = [
    ['pad', 'pad', ['warm', 'wide', 'sustained'], ['atmosphere', 'drone'], 'mid', 'A long, soft bed for harmonic glue.'],
    ['keys', 'keys', ['electric', 'bright', 'digital'], ['harmony', 'rhythmic_pulse'], 'mid', 'A clear FM keyboard for chords and figures.'],
    ['strings', 'strings', ['bowed', 'warm', 'ensemble'], ['harmony', 'counter_melody'], 'mid', 'A sustained bowed ensemble for harmony and counterlines.'],
    ['pluck', 'pluck', ['nylon', 'organic', 'short'], ['rhythmic_pulse', 'harmony', 'accent'], 'mid_high', 'A nylon guitar for arpeggios and small accents.'],
    ['bells', 'bells', ['metallic', 'bright', 'decaying'], ['accent', 'lead', 'atmosphere'], 'high', 'A tubular bell for high, ringing accents.'],
    ['lead', 'strings', ['bowed', 'expressive', 'solo'], ['lead', 'counter_melody'], 'high', 'A solo violin for a singing top line.'],
    ['bass', 'bass', ['finger', 'round', 'low'], ['bass'], 'low', 'A finger bass for a solid low foundation.'],
    ['drums', 'drums', ['acoustic', 'kit', 'rhythmic'], ['percussion', 'rhythmic_pulse'], 'low', 'A full drum kit for pulse and fills.'],
    ['shaker', 'percussion', ['dry', 'short', 'hand'], ['percussion', 'accent'], 'high', 'A shaker for light high-frequency motion.'],
    ['texture', 'texture', ['vinyl', 'noise', 'loop'], ['atmosphere', 'texture'], 'mid', 'A vinyl loop for air, dust, and texture.'],
    ['flute', 'winds', ['breathy', 'clear', 'solo'], ['lead', 'counter_melody'], 'high', 'A breathy flute for open melodic lines.'],
    ['clarinet', 'winds', ['woody', 'round', 'solo'], ['lead', 'counter_melody'], 'mid', 'A clarinet with a warm, woody center.'],
    ['bassoon', 'winds', ['reedy', 'dark', 'solo'], ['bass', 'counter_melody'], 'low', 'A bassoon for low reeds and bass color.'],
    ['saxophone', 'winds', ['reedy', 'vocal', 'solo'], ['lead', 'counter_melody'], 'mid', 'A saxophone with a vocal, reedy edge.'],
    ['trumpet', 'brass', ['bright', 'brassy', 'solo'], ['lead', 'accent'], 'mid_high', 'A trumpet for bright calls and accents.'],
    ['trombone', 'brass', ['round', 'brassy', 'solo'], ['harmony', 'counter_melody'], 'mid_low', 'A trombone for broad, round brass lines.'],
    ['french-horn', 'brass', ['warm', 'round', 'solo'], ['harmony', 'counter_melody'], 'mid', 'A French horn for warm, distant brass.'],
    ['tuba', 'brass', ['low', 'round', 'solo'], ['bass', 'accent'], 'low', 'A tuba for a heavy low brass anchor.'],
    ['organ', 'organ', ['sustained', 'bright', 'church'], ['harmony', 'drone'], 'mid', 'A sustained organ for chords and drones.'],
    ['harmonium', 'organ', ['reedy', 'warm', 'sustained'], ['harmony', 'drone'], 'mid', 'A small reed organ for a soft harmonic bed.'],
    ['bright-piano', 'keys', ['acoustic', 'bright', 'struck'], ['harmony', 'rhythmic_pulse', 'accent'], 'mid', 'A bright piano for clear chordal rhythm.'],
    ['electric-piano-1', 'keys', ['electric', 'soft', 'struck'], ['harmony', 'rhythmic_pulse'], 'mid', 'A mellow electric piano for chords.'],
    ['electric-piano-2', 'keys', ['electric', 'bell', 'struck'], ['harmony', 'accent'], 'mid', 'An electric piano with a bell-like top.'],
    ['xylophone', 'mallets', ['wood', 'bright', 'short'], ['lead', 'accent'], 'high', 'A xylophone for bright, short melodic accents.'],
    ['e-guitar-jazz', 'guitar', ['electric', 'warm', 'hollow'], ['harmony', 'rhythmic_pulse'], 'mid', 'A hollow jazz guitar for soft chords.'],
    ['e-guitar-clean', 'guitar', ['electric', 'clean', 'bright'], ['rhythmic_pulse', 'harmony'], 'mid', 'A clean electric guitar for arpeggios and rhythm.'],
    ['distortion-guitar', 'guitar', ['electric', 'distorted', 'aggressive'], ['rhythmic_pulse', 'lead'], 'mid', 'A distorted guitar for weight and edge.'],
    ['synth-bass-1', 'synth_bass', ['electronic', 'round', 'low'], ['bass'], 'low', 'A round synth bass with a soft attack.'],
    ['synth-bass-2', 'synth_bass', ['electronic', 'square', 'low'], ['bass'], 'low', 'A sharper synth bass with a square edge.'],
    ['synth-brass-1', 'synth_brass', ['electronic', 'brassy', 'wide'], ['harmony', 'accent'], 'mid', 'A wide synth brass for stabs and pads.'],
    ['synth-brass-2', 'synth_brass', ['electronic', 'brassy', 'soft'], ['harmony', 'atmosphere'], 'mid', 'A softer synth brass for harmonic beds.'],
    ['recorder', 'winds', ['breathy', 'clear', 'simple'], ['lead', 'counter_melody'], 'high', 'A simple recorder for a plain top line.'],
    ['synth-square', 'synth_lead', ['electronic', 'square', 'cutting'], ['lead', 'accent'], 'mid_high', 'A square lead with a direct, cutting tone.'],
    ['synth-bass-and-lead', 'synth_lead', ['electronic', 'versatile', 'wide'], ['bass', 'lead'], 'mid', 'A synth voice that can cover bass or lead.'],
    ['synth-soundtrack', 'synth_pad', ['electronic', 'cinematic', 'wide'], ['atmosphere', 'harmony'], 'mid', 'A cinematic synth pad for atmosphere.'],
    ['synth-crystal', 'synth_bells', ['electronic', 'glassy', 'bright'], ['accent', 'atmosphere', 'lead'], 'high', 'A glassy synth bell for high sparkle.'],
    ['gm-percussion-kit', 'percussion', ['acoustic', 'kit', 'varied'], ['percussion'], 'mid', 'A General MIDI percussion kit for color and accents.'],
    ['acoustic-piano', 'keys', ['acoustic', 'warm', 'struck'], ['harmony', 'rhythmic_pulse', 'lead'], 'mid', 'A close acoustic piano for chords and melody.'],
    ['honky-tonk', 'keys', ['acoustic', 'tack', 'bright'], ['rhythmic_pulse', 'harmony'], 'mid', 'A detuned tack piano for a loose, bright rhythm.'],
    ['drawbar-organ', 'organ', ['electric', 'sustained', 'warm'], ['harmony', 'drone'], 'mid', 'A drawbar organ for sustained chords.'],
    ['percussive-organ', 'organ', ['electric', 'short', 'bright'], ['rhythmic_pulse', 'accent'], 'mid', 'A percussive organ for short chordal hits.'],
    ['rock-organ', 'organ', ['electric', 'bright', 'aggressive'], ['harmony', 'accent'], 'mid', 'A rock organ for bright, forceful chords.'],
    ['church-organ', 'organ', ['acoustic', 'large', 'sustained'], ['harmony', 'drone', 'atmosphere'], 'mid', 'A church organ for a large, sustained space.'],
    ['concert-harp', 'pluck', ['acoustic', 'soft', 'decaying'], ['harmony', 'accent', 'atmosphere'], 'mid_high', 'A concert harp for rolled chords and soft color.'],
    ['timpani', 'percussion', ['orchestral', 'low', 'decaying'], ['percussion', 'accent'], 'low', 'A timpani for low punctuation and weight.'],
    ['synth-strings', 'synth_strings', ['electronic', 'bowed', 'wide'], ['harmony', 'atmosphere'], 'mid', 'A wide synth string bed.'],
    ['synth-pad-bowed', 'synth_pad', ['electronic', 'bowed', 'sustained'], ['atmosphere', 'drone'], 'mid', 'A bowed synth pad with slow movement.'],
    ['ocarina', 'winds', ['breathy', 'simple', 'solo'], ['lead', 'counter_melody'], 'high', 'A small ocarina for a plain, breathy lead.'],
    ['kalimba', 'mallets', ['wood', 'soft', 'short'], ['accent', 'rhythmic_pulse', 'lead'], 'high', 'A kalimba for small, bright patterns.'],
    ['bagpipe', 'winds', ['reedy', 'sustained', 'drone'], ['lead', 'drone', 'atmosphere'], 'mid', 'A bagpipe with a continuous reed drone.']
  ];

  const families = {
    pad: 'Pads',
    keys: 'Keys',
    strings: 'Strings',
    pluck: 'Plucked',
    bells: 'Bells',
    bass: 'Bass',
    drums: 'Drums',
    percussion: 'Percussion',
    texture: 'Texture',
    winds: 'Winds',
    brass: 'Brass',
    organ: 'Organs',
    mallets: 'Mallets',
    guitar: 'Guitars',
    synth_bass: 'Synth bass',
    synth_brass: 'Synth brass',
    synth_lead: 'Synth leads',
    synth_pad: 'Synth pads',
    synth_bells: 'Synth bells',
    synth_strings: 'Synth strings'
  };

  const meta = {};
  for (const [key, family, tags, roles, register, blurb] of rows) {
    meta[key] = {
      key,
      family,
      familyLabel: families[family] || family,
      tags,
      roles,
      register,
      blurb
    };
  }

  window.TasteLibraryMeta = meta;
  window.TasteLibraryFamilies = families;
})();
