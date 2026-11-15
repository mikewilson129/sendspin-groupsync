/**
 * Click analyzer
 * Finds the chirps of the sync test pattern in a stretch of recorded audio
 * and returns a precise arrival time for each one.
 */

import { SYNC_PATTERN, chirpSample } from './syncPattern';

export interface DetectedClick {
  /** Arrival time in seconds on the recording clock */
  t: number;
  /** Position in the 4-chirp cycle counted from the window start; markers are at multiples of 4 */
  idx: number;
  /** Peak height over the noise floor */
  snr: number;
}

export interface AnalysisResult {
  ok: boolean;
  reason?: string;
  clicks: DetectedClick[];
  /** Median peak-to-noise ratio of the accepted clicks */
  snr: number;
}

const MIN_SNR = 6;
const MIN_CLICKS = 5;
const SEARCH_HALF_WIDTH_S = 0.025;

interface Templates {
  len: number;
  upCos: Float32Array;
  upSin: Float32Array;
  downCos: Float32Array;
  downSin: Float32Array;
}

const templateCache = new Map<number, Templates>();

function getTemplates(fs: number): Templates {
  const cached = templateCache.get(fs);
  if (cached) return cached;
  const len = Math.round(SYNC_PATTERN.chirpS * fs);
  const t: Templates = {
    len,
    upCos: new Float32Array(len),
    upSin: new Float32Array(len),
    downCos: new Float32Array(len),
    downSin: new Float32Array(len),
  };
  for (let i = 0; i < len; i++) {
    const s = i / fs;
    t.upCos[i] = chirpSample(s, false, false);
    t.upSin[i] = chirpSample(s, false, true);
    t.downCos[i] = chirpSample(s, true, false);
    t.downSin[i] = chirpSample(s, true, true);
  }
  templateCache.set(fs, t);
  return t;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param samples mono audio
 * @param fs sample rate of `samples` in Hz
 * @param t0 time in seconds of samples[0] on the recording clock
 */
export function analyzeClicks(samples: Float32Array, fs: number, t0: number): AnalysisResult {
  const tpl = getTemplates(fs);
  const n = samples.length - tpl.len;
  const period = SYNC_PATTERN.intervalS * fs;
  const fail = (reason: string): AnalysisResult => ({ ok: false, reason, clicks: [], snr: 0 });
  if (n < period * (SYNC_PATTERN.cycle + 1)) return fail('Recording too short');

  // Matched filter envelopes for the up-sweep and the down-sweep
  const envUp = new Float32Array(n);
  const envDown = new Float32Array(n);
  const { len, upCos, upSin, downCos, downSin } = tpl;
  for (let k = 0; k < n; k++) {
    let a = 0;
    let b = 0;
    let c = 0;
    let d = 0;
    for (let i = 0; i < len; i++) {
      const x = samples[k + i];
      a += x * upCos[i];
      b += x * upSin[i];
      c += x * downCos[i];
      d += x * downSin[i];
    }
    envUp[k] = Math.sqrt(a * a + b * b);
    envDown[k] = Math.sqrt(c * c + d * d);
  }

  // Noise floor from a subsample of the combined envelope
  const sub: number[] = [];
  for (let k = 0; k < n; k += 16) sub.push(Math.max(envUp[k], envDown[k]));
  const floor = median(sub) || 1e-12;

  // Fold onto one chirp interval to find where in each second the chirps land
  const bins = Math.round(period);
  const fold = new Float32Array(bins);
  for (let k = 0; k < n; k++) fold[Math.floor(k % period) % bins] += Math.max(envUp[k], envDown[k]);
  const smooth = Math.max(1, Math.round(0.001 * fs));
  let bestBin = 0;
  let bestSum = -1;
  for (let p = 0; p < bins; p++) {
    let s = 0;
    for (let q = -smooth; q <= smooth; q++) s += fold[(p + q + bins) % bins];
    if (s > bestSum) {
      bestSum = s;
      bestBin = p;
    }
  }

  // Pick the peak near the expected position in every second
  const half = Math.round(SEARCH_HALF_WIDTH_S * fs);
  interface Peak {
    j: number;
    pos: number;
    snr: number;
    markerScore: number;
  }
  const peaks: Peak[] = [];
  for (let j = 0; ; j++) {
    const center = Math.round(bestBin + j * period);
    if (center + half >= n) break;
    let kBest = -1;
    let vBest = 0;
    for (let k = Math.max(1, center - half); k <= center + half && k < n - 1; k++) {
      const v = Math.max(envUp[k], envDown[k]);
      if (v > vBest) {
        vBest = v;
        kBest = k;
      }
    }
    if (kBest < 0) continue;
    const env = envDown[kBest] > envUp[kBest] ? envDown : envUp;
    const y0 = env[kBest - 1];
    const y1 = env[kBest];
    const y2 = env[kBest + 1];
    const denom = y0 - 2 * y1 + y2;
    const frac = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    peaks.push({
      j,
      pos: kBest + (Math.abs(frac) < 1 ? frac : 0),
      snr: vBest / floor,
      markerScore: (envDown[kBest] - envUp[kBest]) / (vBest || 1),
    });
  }

  const good = peaks.filter((p) => p.snr >= MIN_SNR);
  if (good.length < MIN_CLICKS) {
    return fail(
      good.length === 0
        ? 'Heard no chirps.'
        : `Only heard ${good.length} clear chirps, which is too few.`
    );
  }

  // Work out which chirps are the down-sweep markers
  const cycle = SYNC_PATTERN.cycle;
  let bestPhase = 0;
  let bestScore = -Infinity;
  let secondScore = -Infinity;
  for (let c = 0; c < cycle; c++) {
    let score = 0;
    for (const p of good) score += p.j % cycle === c ? p.markerScore : -p.markerScore;
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      bestPhase = c;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  if (bestScore <= 0 || bestScore - secondScore < 0.5) {
    return fail(
      'Heard chirps, but could not tell which were the marker chirps. Another speaker may be ' +
        'audible, or playback may still be settling. Move the phone closer to this speaker, ' +
        'wait a few seconds and measure again.'
    );
  }

  const clicks = good.map((p) => ({
    t: t0 + p.pos / fs,
    idx: p.j - bestPhase,
    snr: p.snr,
  }));
  return { ok: true, clicks, snr: median(good.map((p) => p.snr)) };
}
