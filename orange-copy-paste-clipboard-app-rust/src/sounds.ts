/**
 * The app's sounds, synthesized in the browser.
 *
 * Three things make a notification sound feel made rather than generated, and
 * all three are here:
 *
 * 1. **A struck timbre.** Partials that decay at different rates - the top ones
 *    first - is what the ear reads as something hit rather than a tone switched
 *    on. Slight inharmonicity on the upper partials keeps it from ringing like
 *    a test signal.
 * 2. **A soft space.** Every cue is played into a small room. A dry decaying
 *    tone sounds cheap no matter how good the tone is; a short tail after it is
 *    most of the difference between "a beep" and "a sound".
 * 3. **One motif.** Every cue is the same three-note figure in a different mood
 *    (see SCORE), so the set is one thing to learn rather than six.
 *
 * All of it is synthesized: no audio files ship, and no audio backend is linked
 * into the binary. Rust decides *when* (see `notifications::Cue` and the
 * `ui:cue` event); this file decides what it sounds like and whether the user
 * wants to hear it.
 */

/** The cue names Rust sends. Keep in step with `Cue::as_str`. */
export type Cue = "copy" | "paste" | "arrived" | "knock" | "unlocked" | "refused";

// ── Timbre ────────────────────────────────────────────────────────────

// Quiet on purpose: peak -16 dBFS, well under a system alert. There is no
// volume setting - one level, chosen to sit under whatever else is playing,
// beats a slider nobody moves twice.
const PEAK = 0.17;

/**
 * The instrument: a soft mallet on tuned wood.
 *
 * `decay` is a multiplier on the note's own decay, and it is the important
 * column. Equal decay across partials is an organ - the sound just stops. Upper
 * partials dying two to five times faster is a struck bar, and the ear hears
 * the difference immediately even though nobody can name it.
 *
 * The lower ratios are exact. Stretching them - which is what a real bar does -
 * is fine for one note alone and wrong here, because these cues play two and
 * three notes at once: a stretched 2nd partial of C4 lands about a hertz from
 * C5's fundamental, and two tones a hertz apart beat, which the ear reads as
 * unease rather than as detail. Only the top partial is stretched, where there
 * is nothing near it to beat against.
 *
 * The upper partials are also kept quiet on purpose. Partial 3 of an E5 sits
 * near 2 kHz and partial 5 near 3.3 kHz, which is exactly where hearing is
 * sharpest - the same amount of energy that reads as "bright" on a low note
 * reads as "harsh" on a high one.
 */
const PARTIALS = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2, gain: 0.2, decay: 0.45 },
  { ratio: 3, gain: 0.05, decay: 0.25 },
  { ratio: 5.02, gain: 0.012, decay: 0.15 },
];

/**
 * A breath of filtered noise under the onset, gone in a few ms.
 *
 * This is the mallet touching the bar. It sits below the level anyone notices
 * as noise, and removing it makes every cue sound like it fades in from
 * nowhere.
 */
const MALLET = 0.055;
const MALLET_DECAY = 0.0022;

/** Raised-cosine onset. Softer than an exponential attack and never clicks. */
const ATTACK = 0.006;

/**
 * The last few ms of every note ramp to nothing. Without it the buffer ends
 * while the decay is still audible and each cue finishes on a faint click.
 * Cosine rather than linear - a straight ramp is still a corner in the wave.
 */
const RELEASE = 0.014;

// ── The room ──────────────────────────────────────────────────────────

/**
 * A small, soft room: four feedback combs into one allpass.
 *
 * Not decoration. A dry tone stops dead and reads as synthetic; a short tail
 * places it somewhere. The delays are mutually prime-ish in ms so their repeats
 * do not line up into a ringing pitch, and the whole thing is mixed low - you
 * should notice the room only when it is taken away.
 */
const ROOM_DELAYS = [0.0297, 0.0371, 0.0411, 0.0437];
const ROOM_FEEDBACK = 0.68;
const ROOM_ALLPASS = 0.005;
const ROOM_TAIL = 0.5;
const WET = 0.22;

/**
 * How much room each cue gets, as a fraction of the full amount.
 *
 * `copy` and `paste` fire dozens of times an hour, and a half-second tail on
 * something that frequent smears into the next one and makes the app sound
 * washed out. They get a short, nearly dry room; the three that mean something
 * happened get all of it.
 */
const ROOM_MIX: Partial<Record<Cue, number>> = { copy: 0.35, paste: 0.3 };

// ── The notes ─────────────────────────────────────────────────────────
// C major pentatonic: C D E G A. No two degrees are a semitone apart, so any
// two cues landing at the same moment still agree.

const G3 = 196.0;
const C4 = 261.63;
const E4 = 329.63;
const G4 = 392.0;
const A4 = 440.0;
const C5 = 523.25;
const E5 = 659.26;
const G5 = 784.0;
const C6 = 1046.5;

interface Note {
  /** Hz. */
  freq: number;
  /** Seconds of sound. */
  dur: number;
  /** Seconds from the start of the cue. */
  at?: number;
  gain?: number;
  attack?: number;
  /** Decay constant. Defaults to a little over half `dur`. */
  decay?: number;
  /** Scales the upper partials: a duller note is the same bar struck softly. */
  bright?: number;
}

/**
 * The motif, and its variations.
 *
 * **Every cue is the same figure: up a fourth, then up a third** - G, C, E.
 * That is what makes a set recognizable rather than merely pleasant: six
 * unrelated nice sounds are six things to learn, one phrase in six moods is
 * one. It is a C major triad taken from below, so it resolves - the sound is
 * finished when it stops, which is why it can be sweet and still short.
 *
 * What separates the cues is direction and rhythm, never new material:
 *
 * - The rhythm is uneven - short, short, long. Evenly spaced notes are a beep
 *   sequence; an uneven figure is a phrase, and a phrase is what somebody can
 *   hum back.
 * - `refused` is the motif inverted and falling, so "that did not happen" is
 *   audibly the same phrase undone rather than a new sound to learn.
 * - `knock` opens on two taps at one pitch. Two even taps at one pitch is a
 *   door being knocked on, and this is the one cue that means a person is
 *   waiting on you.
 * - `copy` and `paste` are the head of the figure only, high and dry. They fire
 *   dozens of times an hour, so they get the smallest piece of it.
 */
const SCORE: Record<Cue, Note[]> = {
  // The landing note alone. Nothing to recognize, and nothing to tire of.
  paste: [{ freq: C6, dur: 0.05, decay: 0.017, bright: 0.5 }],
  // The rising fourth, compressed: the motif's head and no more.
  copy: [
    { freq: G5, dur: 0.055, decay: 0.02, bright: 0.7 },
    { freq: C6, dur: 0.11, at: 0.028, gain: 0.8, decay: 0.032, bright: 0.7 },
  ],
  // The motif plain. This is the sound of the app.
  arrived: [
    { freq: G4, dur: 0.1, decay: 0.05 },
    { freq: C5, dur: 0.11, at: 0.062, gain: 0.95, decay: 0.055 },
    { freq: E5, dur: 0.24, at: 0.118, gain: 0.9, decay: 0.095 },
  ],
  // Two taps, then the rise. Lower and softer-edged than an arrival: a person
  // waiting, not a thing landing.
  knock: [
    { freq: E4, dur: 0.08, attack: 0.012, decay: 0.032, bright: 0.5 },
    { freq: E4, dur: 0.09, at: 0.1, gain: 0.9, attack: 0.012, decay: 0.034, bright: 0.5 },
    { freq: A4, dur: 0.26, at: 0.212, gain: 0.95, attack: 0.012, decay: 0.11, bright: 0.8 },
  ],
  // The motif over a short root an octave down - a foundation under the phrase,
  // not a drone beneath it. A low note still sounding while the top note rings
  // is the muddiness that made this one uncomfortable.
  unlocked: [
    { freq: C4, dur: 0.2, gain: 0.32, decay: 0.075, bright: 0.35 },
    { freq: G4, dur: 0.1, decay: 0.05 },
    { freq: C5, dur: 0.11, at: 0.064, gain: 0.95, decay: 0.056 },
    { freq: E5, dur: 0.3, at: 0.124, gain: 0.95, decay: 0.105 },
  ],
  // The motif inverted: down a third, then down a fourth. Duller and slower to
  // start, so it reads as a shrug rather than an alarm - nothing here is urgent.
  refused: [
    { freq: E4, dur: 0.09, attack: 0.009, decay: 0.036, bright: 0.3 },
    { freq: C4, dur: 0.11, at: 0.066, gain: 0.9, attack: 0.009, decay: 0.045, bright: 0.28 },
    { freq: G3, dur: 0.26, at: 0.138, gain: 0.85, attack: 0.009, decay: 0.1, bright: 0.25 },
  ],
};

// ── Settings ──────────────────────────────────────────────────────────

let enabled = true;
// Copy and paste are off by default. They are the two that fire dozens of times
// an hour, and a sound that frequent has to be asked for rather than endured.
let wantCopy = false;
let wantPaste = false;

/** Apply whatever of the three the caller knows. */
export function configureSounds(next: { enabled?: boolean; copy?: boolean; paste?: boolean }) {
  if (next.enabled !== undefined) enabled = next.enabled;
  if (next.copy !== undefined) wantCopy = next.copy;
  if (next.paste !== undefined) wantPaste = next.paste;
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Deterministic noise for the mallet.
 *
 * A plain LCG rather than `Math.random`, so a cue sounds identical every time
 * it plays. A transient that changes shape between plays is a transient the ear
 * starts listening to.
 */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
}

/** The dry notes, before the room. */
function strike(notes: Note[], rate: number): Float32Array {
  const length = Math.ceil(Math.max(...notes.map((n) => (n.at ?? 0) + n.dur)) * rate);
  const acc = new Float32Array(length);
  const rand = noise(0x5eed);

  for (const n of notes) {
    const attack = n.attack ?? ATTACK;
    const decay = n.decay ?? n.dur * 0.55;
    const bright = n.bright ?? 1;
    const gain = n.gain ?? 1;
    const start = Math.floor((n.at ?? 0) * rate);
    const count = Math.floor(n.dur * rate);
    const release = Math.min(Math.floor(RELEASE * rate), count);
    const attackSamples = Math.max(1, Math.floor(attack * rate));

    // Two-pole smoothing on the mallet noise: unfiltered it is a click, and a
    // click is the one thing a soft sound cannot have.
    let lp1 = 0;
    let lp2 = 0;

    for (let i = 0; i < count; i++) {
      const t = i / rate;
      const onset = i < attackSamples ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attackSamples) : 1;
      const tail =
        i > count - release
          ? 0.5 + 0.5 * Math.cos((Math.PI * (i - (count - release))) / release)
          : 1;

      let s = 0;
      for (const p of PARTIALS) {
        const amp = p.ratio === 1 ? p.gain : p.gain * bright;
        s += amp * Math.sin(2 * Math.PI * n.freq * p.ratio * t) * Math.exp(-t / (decay * p.decay));
      }

      lp1 += 0.22 * (rand() - lp1);
      lp2 += 0.22 * (lp1 - lp2);
      s += lp2 * MALLET * bright * Math.exp(-t / MALLET_DECAY);

      acc[start + i] += s * onset * tail * gain;
    }
  }
  return acc;
}

/** Play the dry signal into the small room and mix the result back under it. */
function reverb(dry: Float32Array, rate: number, mix: number): Float32Array {
  const out = new Float32Array(dry.length + Math.ceil(ROOM_TAIL * mix * rate));
  const combs = ROOM_DELAYS.map((d) => ({ buf: new Float32Array(Math.floor(d * rate)), i: 0 }));
  const ap = { buf: new Float32Array(Math.floor(ROOM_ALLPASS * rate)), i: 0 };

  for (let i = 0; i < out.length; i++) {
    const input = i < dry.length ? dry[i] : 0;

    let wet = 0;
    for (const c of combs) {
      const echo = c.buf[c.i];
      wet += echo;
      c.buf[c.i] = input + echo * ROOM_FEEDBACK;
      c.i = (c.i + 1) % c.buf.length;
    }
    wet /= combs.length;

    const delayed = ap.buf[ap.i];
    const through = delayed - 0.7 * wet;
    ap.buf[ap.i] = wet + 0.7 * delayed;
    ap.i = (ap.i + 1) % ap.buf.length;

    out[i] = input + through * WET * mix;
  }
  return out;
}

/** Render one cue, normalized so a four-note phrase is no louder than a tick. */
function render(audio: AudioContext, cue: Cue): AudioBuffer {
  const rate = audio.sampleRate;
  const samples = reverb(strike(SCORE[cue], rate), rate, ROOM_MIX[cue] ?? 1);

  let high = 0;
  for (const v of samples) high = Math.max(high, Math.abs(v));
  const scale = high > 0 ? PEAK / high : 0;

  const buffer = audio.createBuffer(1, samples.length, rate);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * scale;
  return buffer;
}

// ── Playback ──────────────────────────────────────────────────────────

let ctx: AudioContext | null = null;
const cache = new Map<Cue, AudioBuffer>();

/** Whether this particular cue is wanted right now. */
function wanted(cue: Cue): boolean {
  if (!enabled) return false;
  if (cue === "copy") return wantCopy;
  if (cue === "paste") return wantPaste;
  return true;
}

/**
 * Play `cue`, unless the user asked not to hear it.
 *
 * Never throws and never awaits anything the caller cares about: a sound that
 * failed has cost nothing, and the thing it accompanied already happened.
 *
 * `force` is for the Settings previews, which must sound even for a cue whose
 * checkbox is off - that is how you decide to turn it on.
 */
export function playCue(cue: Cue, force = false) {
  if (!SCORE[cue]) return;
  if (!force && !wanted(cue)) return;
  try {
    if (!ctx) ctx = new AudioContext();
    // Browsers start the context suspended until a gesture. Resuming on every
    // play is cheap and means the first sound after a click is not swallowed.
    if (ctx.state === "suspended") void ctx.resume();

    let buffer = cache.get(cue);
    if (!buffer) {
      buffer = render(ctx, cue);
      cache.set(cue, buffer);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  } catch (e) {
    console.warn("[sounds]", e);
  }
}
