/**
 * Sync solver
 * Turns chirp arrival times from several speakers into each speaker's offset
 * from a reference speaker.
 *
 * All speakers play the same stream as one group, so chirp n leaves speaker p
 * at  t = r * n + theta_p  on the phone's audio clock. r absorbs the drift
 * between the phone clock and the server clock; theta_p is what we want.
 */

import { SYNC_PATTERN } from './syncPattern';
import type { DetectedClick } from './ClickAnalyzer';

/** Expected size of phone clock drift, as a fraction (100 ppm) */
const DRIFT_PRIOR = 100e-6;

export interface Measurement {
  playerId: string;
  clicks: DetectedClick[];
}

export interface PlayerOffset {
  playerId: string;
  /** Milliseconds this speaker is heard after the reference (negative = before) */
  offsetMs: number;
  /** Rough one-sigma uncertainty in milliseconds */
  uncertaintyMs: number;
  /** Spread of this speaker's chirps around the fit, in milliseconds */
  jitterMs: number;
  windows: number;
  clicks: number;
}

export interface SolveResult {
  offsets: PlayerOffset[];
  /** Phone clock drift against the stream in parts per million */
  driftPpm: number;
}

export function solveOffsets(measurements: Measurement[], referenceId: string): SolveResult | null {
  const { intervalS, cycle } = SYNC_PATTERN;
  const first = measurements.find((m) => m.clicks.length > 0);
  if (!first) return null;
  const span = cycle * intervalS;
  const origin = first.clicks[0].t - first.clicks[0].idx * intervalS;

  interface Point {
    n: number;
    t: number;
  }
  const byPlayer = new Map<string, { points: Point[]; windows: number }>();
  for (const m of measurements) {
    if (m.clicks.length === 0) continue;
    const entry = byPlayer.get(m.playerId) ?? { points: [], windows: 0 };
    entry.windows++;
    for (const c of m.clicks) {
      // Global chirp number: same position in the cycle, nearest whole cycle
      const cycles = Math.round((c.t - origin - c.idx * intervalS) / span);
      entry.points.push({ n: c.idx + cycles * cycle, t: c.t });
    }
    byPlayer.set(m.playerId, entry);
  }
  if (!byPlayer.has(referenceId)) return null;

  // Pooled slope with a separate intercept per speaker
  let sxx = 0;
  let sxy = 0;
  const means = new Map<string, { n: number; t: number }>();
  for (const [id, { points }] of byPlayer) {
    const nMean = points.reduce((s, p) => s + p.n, 0) / points.length;
    const tMean = points.reduce((s, p) => s + p.t, 0) / points.length;
    means.set(id, { n: nMean, t: tMean });
    for (const p of points) {
      sxx += (p.n - nMean) * (p.n - nMean);
      sxy += (p.n - nMean) * (p.t - tMean);
    }
  }
  // Fit the offsets for a given drift rate
  const fit = (r: number) => {
    const thetas = new Map<string, number>();
    const squares = new Map<string, number>();
    let total = 0;
    let count = 0;
    for (const [id, { points }] of byPlayer) {
      const mean = means.get(id)!;
      const th = mean.t - r * mean.n;
      thetas.set(id, th);
      let sq = 0;
      for (const p of points) {
        const res = p.t - (r * p.n + th);
        sq += res * res;
      }
      squares.set(id, sq);
      total += sq;
      count += points.length;
    }
    const dof = Math.max(1, count - byPlayer.size - 1);
    return { thetas, squares, sigma: Math.sqrt(total / dof) };
  };

  // Real phone clocks drift by tens of ppm. With jittery playback and little
  // data the raw slope can be far off, so pull it toward "no drift" in
  // proportion to how noisy the data is.
  let rate = sxx > 0 ? sxy / sxx : intervalS;
  let { thetas: theta, squares: residualSq, sigma } = fit(rate);
  let rateSigma = 0;
  if (sxx > 0) {
    const prior = (sigma * sigma) / (DRIFT_PRIOR * DRIFT_PRIOR);
    rate = (sxy + prior * intervalS) / (sxx + prior);
    ({ thetas: theta, squares: residualSq, sigma } = fit(rate));
    rateSigma = sigma / Math.sqrt(sxx + prior);
  }

  const refTheta = theta.get(referenceId)!;
  const refMean = means.get(referenceId)!;
  const refCount = byPlayer.get(referenceId)!.points.length;

  const offsets: PlayerOffset[] = [];
  for (const [id, { points, windows }] of byPlayer) {
    let diff = theta.get(id)! - refTheta;
    diff -= Math.round(diff / span) * span;
    const mean = means.get(id)!;
    const jitter = Math.sqrt(residualSq.get(id)! / Math.max(1, points.length - 1));
    const uncertainty =
      id === referenceId
        ? 0
        : Math.sqrt(
            sigma * sigma * (1 / points.length + 1 / refCount) +
              Math.pow(rateSigma * (mean.n - refMean.n), 2)
          );
    offsets.push({
      playerId: id,
      offsetMs: diff * 1000,
      uncertaintyMs: uncertainty * 1000,
      jitterMs: jitter * 1000,
      windows,
      clicks: points.length,
    });
  }

  return { offsets, driftPpm: (rate / intervalS - 1) * 1e6 };
}
