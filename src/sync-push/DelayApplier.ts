/**
 * Delay applier
 * Works out which Music Assistant setting controls each player's timing,
 * turns measured offsets into new values for those settings, and saves them.
 *
 * Music Assistant has two such settings (checked against server 2.10):
 *  - sendspin_static_delay (0..5000 ms): raise it when the player is heard late
 *  - sync_adjust (-500..500 ms): positive plays later, negative plays earlier
 */

import { maClient } from '../ma-client';

type DelayKind = 'sendspin_static_delay' | 'sync_adjust';

const DEFAULT_RANGE: Record<DelayKind, [number, number]> = {
  sendspin_static_delay: [0, 5000],
  sync_adjust: [-500, 500],
};

/** Newer Music Assistant stores a protocol's settings on the parent player as `<id>||protocol||<key>` */
const PROTOCOL_KEY_SPLITTER = '||protocol||';

export interface DelaySetting {
  key: DelayKind;
  /** The exact config key to read and save, which may carry a protocol prefix */
  configKey: string;
  current: number;
  min: number;
  max: number;
}

export interface DelayPlanRow {
  playerId: string;
  playerName: string;
  /** Milliseconds heard after the reference */
  offsetMs: number;
  setting: DelaySetting | null;
  /** New value for the setting, or null when the player has no setting */
  newValue: number | null;
  /** Milliseconds of offset expected to remain after applying */
  remainingMs: number;
  note?: string;
}

interface RawEntry {
  key?: string;
  value?: unknown;
  default_value?: unknown;
  range?: [number, number] | null;
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a player's timing setting from Music Assistant, if it has one. */
export async function readDelaySetting(playerId: string): Promise<DelaySetting | null> {
  const config = await maClient.sendCommand<{ values?: Record<string, RawEntry> | RawEntry[] }>(
    'config/players/get',
    { player_id: playerId }
  );
  const raw = config?.values;
  const entries: RawEntry[] = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
  for (const key of ['sendspin_static_delay', 'sync_adjust'] as const) {
    // Match the plain key, or the same key with a protocol prefix
    const entry = entries.find(
      (e) => typeof e?.key === 'string' && (e.key === key || e.key.endsWith(PROTOCOL_KEY_SPLITTER + key))
    );
    if (!entry || typeof entry.key !== 'string') continue;
    const current = toNumber(entry.value) ?? toNumber(entry.default_value) ?? 0;
    const range = Array.isArray(entry.range) && entry.range.length === 2 ? entry.range : DEFAULT_RANGE[key];
    return { key, configKey: entry.key, current, min: range[0], max: range[1] };
  }
  return null;
}

/**
 * Build the list of changes that lines every player up with the others.
 *
 * Each player needs to play `offsetMs + shift` earlier, where `shift` is one
 * amount shared by the whole group. The shift is chosen so every new value
 * fits its setting's range, and so players without a setting need no change.
 */
export async function planDelays(
  offsets: { playerId: string; playerName: string; offsetMs: number }[]
): Promise<DelayPlanRow[]> {
  const rows: DelayPlanRow[] = [];
  for (const o of offsets) {
    let setting: DelaySetting | null = null;
    let note: string | undefined;
    try {
      setting = await readDelaySetting(o.playerId);
      if (!setting) note = 'No delay setting found for this player';
    } catch (error) {
      note = error instanceof Error ? error.message : 'Could not read player settings';
    }
    rows.push({ ...o, setting, newValue: null, remainingMs: o.offsetMs, note });
  }

  // Allowed range of the shared shift, from each player's setting range
  let lo = -Infinity;
  let hi = Infinity;
  for (const row of rows) {
    const s = row.setting;
    if (!s) continue;
    if (s.key === 'sendspin_static_delay') {
      lo = Math.max(lo, s.min - s.current - row.offsetMs);
      hi = Math.min(hi, s.max - s.current - row.offsetMs);
    } else {
      lo = Math.max(lo, s.current - s.max - row.offsetMs);
      hi = Math.min(hi, s.current - s.min - row.offsetMs);
    }
  }

  const fixed = rows.filter((r) => !r.setting);
  let shift = 0;
  if (fixed.length > 0) {
    // Players that cannot be adjusted set the target for everyone else
    shift = -fixed.reduce((sum, r) => sum + r.offsetMs, 0) / fixed.length;
  } else if (lo <= hi) {
    shift = Math.min(hi, Math.max(lo, 0));
  } else {
    shift = (lo + hi) / 2;
  }

  for (const row of rows) {
    const earlier = row.offsetMs + shift;
    const s = row.setting;
    if (!s) {
      row.remainingMs = earlier;
      continue;
    }
    const wanted = s.key === 'sendspin_static_delay' ? s.current + earlier : s.current - earlier;
    const clamped = Math.round(Math.min(s.max, Math.max(s.min, wanted)));
    row.newValue = clamped;
    const applied = s.key === 'sendspin_static_delay' ? clamped - s.current : s.current - clamped;
    row.remainingMs = earlier - applied;
    if (Math.abs(wanted - clamped) > 1) {
      row.note = `Needs ${Math.round(wanted)} ms but the setting only allows ${s.min} to ${s.max}`;
    }
  }
  return rows;
}

export interface ApplyResult {
  playerId: string;
  playerName: string;
  success: boolean;
  skipped: boolean;
  error?: string;
}

/** Save the planned values to Music Assistant. */
export async function applyDelays(rows: DelayPlanRow[]): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  for (const row of rows) {
    const base = { playerId: row.playerId, playerName: row.playerName };
    if (!row.setting || row.newValue === null || row.newValue === row.setting.current) {
      results.push({ ...base, success: true, skipped: true });
      continue;
    }
    try {
      await maClient.sendCommand('config/players/save', {
        player_id: row.playerId,
        values: { [row.setting.configKey]: row.newValue },
      });
      results.push({ ...base, success: true, skipped: false });
    } catch (error) {
      results.push({
        ...base,
        success: false,
        skipped: false,
        error: error instanceof Error ? error.message : 'Save failed',
      });
    }
  }
  return results;
}
