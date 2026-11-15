/**
 * Sync test pattern shared by the track generator (Node, via vite.config.ts)
 * and the in-browser analyzer. Keep this file free of DOM and Node imports.
 *
 * The track is one chirp per second. Every 4th chirp sweeps down instead of
 * up, which marks a 4-second cycle so offsets up to +/-2 s are unambiguous.
 */

export const SYNC_PATTERN = {
  /** Seconds between chirps */
  intervalS: 1,
  /** Every Nth chirp is a down-sweep marker */
  cycle: 4,
  /** Chirp length in seconds */
  chirpS: 0.04,
  /** Sweep range in Hz (well inside phone-mic and small-speaker range) */
  fLow: 1000,
  fHigh: 4000,
  amplitude: 0.6,
  /** Silence before the first chirp */
  leadInS: 1,
  /** Track length in seconds */
  durationS: 900,
  /** Sample rate of the generated file */
  fileSampleRate: 16000,
} as const;

/**
 * One sample of a Hann-windowed linear chirp.
 * @param t seconds from chirp start (0 <= t < chirpS)
 * @param down true for the down-sweep marker
 * @param quadrature true for the 90-degree shifted copy (used for envelopes)
 */
export function chirpSample(t: number, down: boolean, quadrature = false): number {
  const { chirpS, fLow, fHigh } = SYNC_PATTERN;
  if (t < 0 || t >= chirpS) return 0;
  const fa = down ? fHigh : fLow;
  const fb = down ? fLow : fHigh;
  const phase = 2 * Math.PI * (fa * t + ((fb - fa) * t * t) / (2 * chirpS));
  const window = 0.5 * (1 - Math.cos((2 * Math.PI * t) / chirpS));
  return window * (quadrature ? Math.sin(phase) : Math.cos(phase));
}

/** Build the whole test track as a 16-bit mono WAV file. */
export function buildSyncTrackWav(): Uint8Array {
  const { fileSampleRate: fs, durationS, leadInS, intervalS, cycle, chirpS, amplitude } =
    SYNC_PATTERN;
  const total = fs * durationS;
  const out = new Uint8Array(44 + total * 2);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, fs, true);
  view.setUint32(28, fs * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, total * 2, true);

  const chirpLen = Math.round(chirpS * fs);
  const clicks = Math.floor((durationS - leadInS - chirpS) / intervalS);
  for (let n = 0; n < clicks; n++) {
    const start = Math.round((leadInS + n * intervalS) * fs);
    const down = n % cycle === 0;
    for (let i = 0; i < chirpLen; i++) {
      const v = amplitude * chirpSample(i / fs, down);
      view.setInt16(44 + (start + i) * 2, Math.round(v * 32767), true);
    }
  }
  return out;
}
