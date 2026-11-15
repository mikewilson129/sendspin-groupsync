/**
 * Group sync session
 * Plays the sync test track on all chosen players as one group, then measures
 * one speaker at a time by muting the others and timing its chirps on the
 * phone's audio clock. Because the group keeps playing the same stream the
 * whole time, the differences between speakers are their real sync errors.
 */

import { maClient } from '../ma-client';
import type { Player } from '../types';
import { MicCapture } from './MicCapture';
import { analyzeClicks } from './ClickAnalyzer';
import { solveOffsets } from './syncSolver';
import type { Measurement, SolveResult } from './syncSolver';
import { SYNC_PATTERN } from './syncPattern';

/** Seconds to wait after muting before recording, so mute changes have landed */
const SETTLE_S = 2.5;
/** Seconds of audio analysed per measurement */
const RECORD_S = 9;
/** Seconds after starting playback before checking who is in the group */
const START_CHECK_S = 4;

export const MEASURE_SECONDS = SETTLE_S + RECORD_S;
export const TRACK_URL_PATH = '/sync-track.wav';

interface PlayerSnapshot {
  volume: number | null;
  muted: boolean;
  silencedByVolume: boolean;
}

type LoosePlayer = Player & {
  volume_muted?: boolean;
  group_members?: string[];
  active_group?: string | null;
  playback_state?: string;
  can_group_with?: string[];
};

export interface PlayerStatus {
  playerId: string;
  /** Music Assistant lists this player as part of the group that is playing */
  inGroup: boolean;
  /** Music Assistant reports this player as playing */
  playing: boolean;
  /** Plain-language problem, when there is one */
  problem: string | null;
  /**
   * Something odd that does not stop measuring. Some players, such as Bluetooth bridges,
   * report a state other than "playing" even while they are audible.
   */
  warning: string | null;
}

/** Volumes we turned down to silence a player, kept so a crashed session can be undone */
const VOLUME_RESTORE_KEY = 'groupsync-volume-restore';

function loadVolumeRestore(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOLUME_RESTORE_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function saveVolumeRestore(map: Record<string, number>): void {
  try {
    localStorage.setItem(VOLUME_RESTORE_KEY, JSON.stringify(map));
  } catch {
    // Storage is a safety net only
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroupSyncSession {
  private mic = new MicCapture();
  private players: LoosePlayer[];
  private snapshots = new Map<string, PlayerSnapshot>();
  private measurements: Measurement[] = [];
  private queueId: string | null = null;
  private statuses = new Map<string, PlayerStatus>();
  private joinFailures = new Map<string, string>();
  private interrupted = false;
  private startedAt = 0;
  private busy = false;
  private wakeLock: { release: () => Promise<void> } | null = null;

  readonly referenceId: string;
  /** Things the session did that the person should know about, shown after starting */
  readonly notes: string[] = [];

  constructor(players: Player[], referenceId: string) {
    this.players = players;
    this.referenceId = referenceId;
  }

  get level(): number {
    return this.mic.currentLevel;
  }

  /** Seconds of test track left before it runs out */
  get secondsLeft(): number {
    if (!this.startedAt) return SYNC_PATTERN.durationS;
    return Math.max(0, SYNC_PATTERN.durationS - (Date.now() - this.startedAt) / 1000);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** True once Music Assistant has reported the group as stopped mid-session */
  get wasInterrupted(): boolean {
    return this.interrupted;
  }

  getStatus(playerId: string): PlayerStatus | undefined {
    return this.statuses.get(playerId);
  }

  /**
   * Open the microphone, group the players and start the test track.
   * Call from a tap handler so the browser allows microphone access.
   * @param group false when the user has already grouped the players themselves
   */
  async start(group: boolean): Promise<void> {
    await this.mic.start();
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      // Wake lock is a nicety only
    }

    // Undo volume changes left behind by a session that was closed mid-measurement
    const leftover = loadVolumeRestore();
    for (const p of this.players) {
      const volume = leftover[p.player_id];
      if (typeof volume !== 'number') continue;
      try {
        await maClient.sendCommand('players/cmd/volume_set', {
          player_id: p.player_id,
          volume_level: volume,
        });
        p.volume_level = volume;
        delete leftover[p.player_id];
      } catch (error) {
        console.warn(`[GroupSync] Could not restore volume on ${p.player_id}:`, error);
      }
    }
    saveVolumeRestore(leftover);

    // These players were picked to be calibrated, so they all need to be audible.
    // A previous session that was closed without Stop may have left them muted.
    for (const p of this.players) {
      this.snapshots.set(p.player_id, {
        volume: typeof p.volume_level === 'number' ? p.volume_level : null,
        muted: false,
        silencedByVolume: false,
      });
    }
    await Promise.all(
      this.players.map(async (p) => {
        try {
          await maClient.sendCommand('players/cmd/volume_mute', { player_id: p.player_id, muted: false });
        } catch (error) {
          console.warn(`[GroupSync] Could not unmute ${p.player_id}:`, error);
        }
      })
    );

    const leader = await this.chooseLeader(group);
    this.queueId = leader;

    const url = `${window.location.origin}${TRACK_URL_PATH}`;
    await maClient.playMedia(leader, url, 'replace');
    this.startedAt = Date.now();

    // Give the players a moment to start, then check who is really in the group
    await delay(START_CHECK_S * 1000);
    await this.refreshStatus();
    this.interrupted = false;
  }

  /**
   * Ask Music Assistant which of the chosen players are in the playing group
   * and whether they report playing. Safe to call at any time.
   */
  async refreshStatus(): Promise<void> {
    if (!this.queueId) return;
    let all: LoosePlayer[];
    try {
      all = (await maClient.getAllPlayers()) as LoosePlayer[];
    } catch (error) {
      console.warn('[GroupSync] Could not refresh player status:', error);
      return;
    }
    const byId = new Map(all.map((p) => [p.player_id, p]));
    const leaderId = this.queueId;
    const leader = byId.get(leaderId);
    const members = new Set([...(leader?.group_members ?? []), ...(leader?.group_childs ?? [])]);

    if (this.startedAt && Date.now() - this.startedAt > START_CHECK_S * 1000 + 2000) {
      if (leader && leader.playback_state !== undefined && leader.playback_state !== 'playing') {
        this.interrupted = true;
      }
    }

    for (const p of this.players) {
      const id = p.player_id;
      const current = byId.get(id);
      const inGroup =
        id === leaderId ||
        members.has(id) ||
        current?.synced_to === leaderId ||
        current?.active_group === leaderId;
      const playing = current?.playback_state === 'playing';
      let problem: string | null = null;
      let warning: string | null = null;
      if (!current || current.available === false) {
        problem = 'Music Assistant shows this player as unavailable';
      } else if (!inGroup) {
        const reason = this.joinFailures.get(id);
        problem = reason
          ? `Could not join the group: ${reason}`
          : 'Not in the group that is playing';
      } else if (current.playback_state !== undefined && !playing) {
        warning = 'In the group. Music Assistant does not report it as playing, which some players do even while audible';
      }
      this.statuses.set(id, { playerId: id, inGroup, playing, problem, warning });
    }
  }

  /** Measure one speaker. The phone should be held close to it. */
  async measure(playerId: string): Promise<void> {
    if (this.busy) throw new Error('A measurement is already running');
    if (this.secondsLeft < MEASURE_SECONDS + 2) {
      throw new Error('The test track has run out. Stop and start again.');
    }
    this.busy = true;
    try {
      await Promise.all(
        this.players.map((p) => this.setSilenced(p.player_id, p.player_id !== playerId))
      );
      await delay(SETTLE_S * 1000);
      const from = this.mic.now;
      await delay(RECORD_S * 1000 + 300);
      const audio = this.mic.read(from, from + RECORD_S);
      if (!audio) throw new Error('Microphone recording was interrupted. Try again.');

      // Let the UI repaint before the heavy analysis
      await delay(30);
      const result = analyzeClicks(audio.samples, this.mic.sampleRate, audio.t0);
      if (!result.ok) {
        // Find out whether Music Assistant thinks this speaker should be playing
        await this.refreshStatus();
        const name = this.players.find((p) => p.player_id === playerId)?.name ?? 'this speaker';
        const status = this.statuses.get(playerId);
        const why = status?.problem
          ? `${status.problem}.`
          : 'Music Assistant has it in the group, so check that it is audible and hold the phone closer.';
        throw new Error(`${result.reason ?? 'Could not hear the test track'} (${name}) ${why}`);
      }
      this.measurements.push({ playerId, clicks: result.clicks });
    } finally {
      this.busy = false;
    }
  }

  getResults(): SolveResult | null {
    return solveOffsets(this.measurements, this.referenceId);
  }

  measuredCount(playerId: string): number {
    return this.measurements.filter((m) => m.playerId === playerId).length;
  }

  /** Forget measurements, for example after new delays were applied */
  clearMeasurements(): void {
    this.measurements = [];
  }

  /** Unmute every player so the whole group can be heard together */
  async unmuteAll(): Promise<void> {
    await Promise.all(this.players.map((p) => this.setSilenced(p.player_id, false)));
  }

  /** Stop playback, restore volumes and release the microphone */
  async finish(): Promise<void> {
    await this.stopPlayback();
    try {
      await this.unmuteAll();
    } catch (error) {
      console.warn('[GroupSync] Could not restore mute state:', error);
    }
    this.mic.stop();
    try {
      await this.wakeLock?.release();
    } catch {
      // Already released
    }
    this.wakeLock = null;
  }

  // ==================== Private ====================

  /**
   * Stop the test track. The queue is stopped first, then every chosen player is asked to
   * stop directly, because Music Assistant can route a player's queue through another
   * player or group and a queue stop alone has been seen to leave the chirps playing.
   */
  private async stopPlayback(): Promise<void> {
    if (this.queueId) {
      try {
        await maClient.sendCommand('player_queues/stop', { queue_id: this.queueId });
      } catch (error) {
        console.warn('[GroupSync] Could not stop the queue:', error);
      }
    }
    const ids = new Set(this.players.map((p) => p.player_id));
    if (this.queueId) ids.add(this.queueId);
    await Promise.all(
      [...ids].map(async (id) => {
        try {
          await maClient.sendCommand('players/cmd/stop', { player_id: id });
        } catch (error) {
          console.warn(`[GroupSync] Could not stop ${id}:`, error);
        }
      })
    );
  }

  /**
   * Break up ad-hoc groups that involve any chosen speaker, such as one made by selecting
   * several players in the Music Assistant app. A player can only be in one group at a
   * time, so such a group would pull speakers away from the one built here.
   * Returns the names of the players that were taken out of their groups.
   */
  private async clearExistingGroups(): Promise<string[]> {
    let all: LoosePlayer[];
    try {
      all = (await maClient.getAllPlayers()) as LoosePlayer[];
    } catch {
      return [];
    }
    const chosen = new Set(this.players.map((p) => p.player_id));
    const toUngroup = all.filter(
      (p) =>
        p.type !== 'group' &&
        !!p.synced_to &&
        (chosen.has(p.player_id) || chosen.has(p.synced_to))
    );
    const cleared: string[] = [];
    for (const p of toUngroup) {
      try {
        await maClient.sendCommand('players/cmd/ungroup', { player_id: p.player_id }, 20000);
        cleared.push(p.name);
      } catch (error) {
        console.warn(`[GroupSync] Could not ungroup ${p.player_id}:`, error);
      }
    }
    if (cleared.length > 0) await delay(2000);
    return cleared;
  }

  /**
   * Join the players into one sync group led by the reference speaker.
   * Players are added one at a time so one that cannot join does not block the rest.
   */
  private async groupPlayers(): Promise<string> {
    const leader = this.referenceId;
    this.joinFailures.clear();
    if (this.players.length === 1) return leader;

    const cleared = await this.clearExistingGroups();
    if (cleared.length > 0) {
      this.notes.push(
        `Took ${cleared.join(', ')} out of an existing group so the test track plays on one group.`
      );
    }

    let fresh: LoosePlayer[] = this.players;
    try {
      fresh = (await maClient.getAllPlayers()) as LoosePlayer[];
    } catch {
      // Fall back to what we already know
    }
    const byId = new Map(fresh.map((p) => [p.player_id, p]));

    // The leader cannot itself be a follower of some other group
    const leaderNow = byId.get(leader);
    if (leaderNow?.synced_to) {
      try {
        await maClient.sendCommand('players/cmd/ungroup', { player_id: leader }, 20000);
      } catch (error) {
        console.warn('[GroupSync] Could not ungroup the reference speaker:', error);
      }
    }
    const already = new Set([
      ...(leaderNow?.group_members ?? []),
      ...(leaderNow?.group_childs ?? []),
    ]);

    // Remove speakers left in this group by an earlier run that were not chosen this time,
    // or they would keep playing the test track and spoil the readings
    const chosenIds = new Set(this.players.map((p) => p.player_id));
    const extras = [...already].filter((id) => id !== leader && !chosenIds.has(id));
    if (extras.length > 0) {
      try {
        await maClient.sendCommand(
          'players/cmd/set_members',
          { target_player: leader, player_ids_to_remove: extras },
          20000
        );
      } catch (error) {
        console.warn('[GroupSync] Could not remove other speakers from the group:', error);
      }
    }

    let joined = 0;
    for (const p of this.players) {
      const id = p.player_id;
      if (id === leader) continue;
      if (already.has(id)) {
        joined++;
        continue;
      }
      const current = byId.get(id);
      try {
        if (current?.synced_to && current.synced_to !== leader) {
          await maClient.sendCommand('players/cmd/ungroup', { player_id: id }, 20000);
        }
        await maClient.sendCommand(
          'players/cmd/set_members',
          { target_player: leader, player_ids_to_add: [id] },
          20000
        );
        joined++;
      } catch (error) {
        console.warn(`[GroupSync] ${id} could not join the group:`, error);
        this.joinFailures.set(id, errorText(error));
      }
    }

    if (joined === 0) {
      const reasons = [...new Set(this.joinFailures.values())].join('; ');
      if (/authentication is required/i.test(reasons)) {
        throw new Error(
          'Music Assistant has signed this page out and the saved login did not work. ' +
            'Tap Back, reconnect (enter your password if asked), then Start again.'
        );
      }
      throw new Error(`Music Assistant could not group any of these players: ${reasons}`);
    }
    return leader;
  }

  /**
   * Decide which Music Assistant player the test track plays on.
   * Speakers of one kind are joined into a native sync group led by the reference.
   * When Music Assistant says they cannot sync with each other (for example a Sendspin
   * player and a soundbar), a group player that already contains all of them, such as a
   * Universal Group, is used instead.
   */
  private async chooseLeader(group: boolean): Promise<string> {
    if (!group) return this.findExistingLeader();
    let all: LoosePlayer[] = [];
    try {
      all = (await maClient.getAllPlayers()) as LoosePlayer[];
    } catch {
      // Fall through to native grouping
    }
    const reference = all.find((p) => p.player_id === this.referenceId);
    const others = this.players.map((p) => p.player_id).filter((id) => id !== this.referenceId);
    const canGroup = reference?.can_group_with;
    const nativeOk = !Array.isArray(canGroup) || others.every((id) => canGroup.includes(id));
    if (!nativeOk) {
      const covering = this.findCoveringGroup(all);
      if (covering) return covering;
    }
    return this.groupPlayers();
  }

  /** A Music Assistant group player whose members include every chosen speaker (smallest wins) */
  private findCoveringGroup(all: LoosePlayer[]): string | null {
    if (this.players.length < 2) return null;
    const chosen = this.players.map((p) => p.player_id);
    const candidates = all
      .filter((p) => p.type === 'group' && p.available !== false && !chosen.includes(p.player_id))
      .map((p) => ({
        id: p.player_id,
        members: new Set([...(p.group_members ?? []), ...(p.group_childs ?? [])]),
      }))
      .filter((g) => chosen.every((id) => g.members.has(id)))
      .sort((a, b) => a.members.size - b.members.size);
    return candidates[0]?.id ?? null;
  }

  /** Find the player or group that leads the group the reference is already in */
  private async findExistingLeader(): Promise<string> {
    try {
      const all = (await maClient.getAllPlayers()) as LoosePlayer[];
      const reference = all.find((p) => p.player_id === this.referenceId);
      const inGroup = reference?.synced_to || reference?.active_group;
      if (inGroup) return inGroup;
      // Not playing in a group right now: look for a group player that contains everyone
      return this.findCoveringGroup(all) ?? this.referenceId;
    } catch {
      return this.referenceId;
    }
  }

  private async setSilenced(playerId: string, silenced: boolean): Promise<void> {
    const snap = this.snapshots.get(playerId);
    if (!snap) return;
    // Leave players alone that the user had muted before we started
    if (snap.muted) return;
    try {
      if (snap.silencedByVolume) {
        if (!silenced && snap.volume !== null) {
          await maClient.sendCommand('players/cmd/volume_set', {
            player_id: playerId,
            volume_level: snap.volume,
          });
          snap.silencedByVolume = false;
          const map = loadVolumeRestore();
          delete map[playerId];
          saveVolumeRestore(map);
        }
        return;
      }
      await maClient.sendCommand('players/cmd/volume_mute', { player_id: playerId, muted: silenced });
    } catch (muteError) {
      // No mute control on this player: fall back to turning the volume down
      if (silenced && snap.volume !== null) {
        try {
          await maClient.sendCommand('players/cmd/volume_set', { player_id: playerId, volume_level: 0 });
          snap.silencedByVolume = true;
          saveVolumeRestore({ ...loadVolumeRestore(), [playerId]: snap.volume });
          return;
        } catch (volumeError) {
          console.warn(`[GroupSync] Could not silence ${playerId}:`, volumeError);
          return;
        }
      }
      console.warn(`[GroupSync] Could not change mute on ${playerId}:`, muteError);
    }
  }
}
