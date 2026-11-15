import { useEffect, useRef, useState } from 'react';
import { useCalibrationStore, usePlayersStore } from '../store';
import { GroupSyncSession, MEASURE_SECONDS } from '../calibration/GroupSyncSession';
import type { SolveResult } from '../calibration/syncSolver';
import { planDelays, applyDelays } from '../sync-push/DelayApplier';
import type { DelayPlanRow, ApplyResult } from '../sync-push/DelayApplier';

type Stage = 'setup' | 'starting' | 'running' | 'review';

function formatOffset(ms: number): string {
  const rounded = Math.round(ms * 10) / 10;
  if (Math.abs(rounded) < 0.05) return 'in sync';
  return `${Math.abs(rounded).toFixed(1)} ms ${rounded > 0 ? 'late' : 'early'}`;
}

/** Readings this close to the reference are inside what people can hear as one sound source */
const IN_SYNC_MS = 5;
const CLOSE_MS = 15;

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function GroupCalibration() {
  const { setPhase } = useCalibrationStore();
  const { players, selectedPlayerIds } = usePlayersStore();
  const selected = players.filter((p) => selectedPlayerIds.includes(p.player_id));
  const nameOf = (id: string) => selected.find((p) => p.player_id === id)?.name ?? id;

  const [stage, setStage] = useState<Stage>('setup');
  const [referenceId, setReferenceId] = useState(selected[0]?.player_id ?? '');
  const [alreadyGrouped, setAlreadyGrouped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [measuringId, setMeasuringId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [level, setLevel] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [results, setResults] = useState<SolveResult | null>(null);
  const [plan, setPlan] = useState<DelayPlanRow[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<ApplyResult[] | null>(null);
  const [, setStatusTick] = useState(0);
  const [interrupted, setInterrupted] = useState(false);
  const [applied, setApplied] = useState(false);

  const sessionRef = useRef<GroupSyncSession | null>(null);

  // Stop playback and release the mic if the component goes away mid-session
  useEffect(() => {
    return () => {
      void sessionRef.current?.finish();
      sessionRef.current = null;
    };
  }, []);

  // Best effort: if the page is closed mid-measurement, put the sound back
  useEffect(() => {
    const restore = () => void sessionRef.current?.unmuteAll();
    window.addEventListener('pagehide', restore);
    return () => window.removeEventListener('pagehide', restore);
  }, []);

  // Level meter and track countdown
  useEffect(() => {
    if (stage !== 'running') return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      setLevel(session.level);
      setSecondsLeft(session.secondsLeft);
    }, 150);
    return () => clearInterval(timer);
  }, [stage]);

  // Keep checking with Music Assistant that every speaker is still in the group
  useEffect(() => {
    if (stage !== 'running') return;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session || session.isBusy) return;
      void session.refreshStatus().then(() => {
        setInterrupted(session.wasInterrupted);
        setStatusTick((n) => n + 1);
      });
    }, 8000);
    return () => clearInterval(timer);
  }, [stage]);

  const handleStart = async () => {
    setError(null);
    setNotice(null);
    setApplied(false);
    setStage('starting');
    const session = new GroupSyncSession(selected, referenceId);
    sessionRef.current = session;
    try {
      await session.start(!alreadyGrouped);
      setResults(null);
      setInterrupted(false);
      if (session.notes.length > 0) setNotice(session.notes.join(' '));
      const missing = selected.filter((p) => session.getStatus(p.player_id)?.problem);
      if (missing.length > 0) {
        setError(
          `${missing.map((p) => p.name).join(', ')} ${
            missing.length === 1 ? 'is' : 'are'
          } not playing with the group. See the note on each speaker below. You can still measure the others.`
        );
      }
      setStage('running');
    } catch (err) {
      await session.finish();
      sessionRef.current = null;
      setError(err instanceof Error ? err.message : 'Could not start');
      setStage('setup');
    }
  };

  const handleMeasure = async (playerId: string) => {
    const session = sessionRef.current;
    if (!session || measuringId) return;
    setError(null);
    setNotice(null);
    setMeasuringId(playerId);
    setCountdown(Math.ceil(MEASURE_SECONDS));
    const ticker = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    try {
      await session.measure(playerId);
      setResults(session.getResults());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Measurement failed');
      setStatusTick((n) => n + 1);
    } finally {
      clearInterval(ticker);
      setMeasuringId(null);
    }
  };

  const handleReview = async () => {
    if (!results) return;
    setError(null);
    setApplyResults(null);
    try {
      const rows = await planDelays(
        results.offsets.map((o) => ({
          playerId: o.playerId,
          playerName: nameOf(o.playerId),
          offsetMs: o.offsetMs,
        }))
      );
      setPlan(rows);
      setStage('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read player settings');
    }
  };

  const handleApply = async () => {
    if (!plan) return;
    setApplying(true);
    try {
      const outcome = await applyDelays(plan);
      setApplyResults(outcome);
      if (outcome.every((r) => r.success)) {
        sessionRef.current?.clearMeasurements();
        setResults(null);
        setApplied(true);
        const restarted = plan.some(
          (r) => r.setting?.key === 'sync_adjust' && r.newValue !== r.setting.current
        );
        setNotice(
          'New delays saved. Measure the speakers again to check: they should now read close to in sync.' +
            (restarted
              ? ' Some players restart when this setting changes. If the chirps stopped, tap Stop and start again.'
              : '')
        );
        setPlan(null);
        setStage('running');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save delays');
    } finally {
      setApplying(false);
    }
  };

  const handleStop = async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    await session?.finish();
    setPhase('idle');
  };

  const offsetFor = (id: string) => results?.offsets.find((o) => o.playerId === id);
  const measuredIds = new Set(results?.offsets.map((o) => o.playerId) ?? []);
  const canReview = measuredIds.has(referenceId) && measuredIds.size >= 2;

  return (
    <div className="space-y-5 pb-20">
      {error && (
        <div className="p-3 bg-red-900/20 border border-red-700/50 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 bg-green-900/20 border border-green-700/50 rounded-lg text-green-300 text-sm">
          {notice}
        </div>
      )}

      {(stage === 'setup' || stage === 'starting') && (
        <>
          <div>
            <h2 className="text-2xl font-bold mb-2">Group calibration</h2>
            <p className="text-text-muted text-sm">
              All {selected.length} players play a chirp track together as one group. You walk to
              each speaker, and the app mutes the others and times that speaker against the
              reference.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="font-medium">Reference speaker</h3>
            <p className="text-text-muted text-xs">
              The others are measured against this one. Pick one you can get back to easily.
            </p>
            {selected.map((player) => (
              <label
                key={player.player_id}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${
                  referenceId === player.player_id
                    ? 'bg-primary/20 border-primary'
                    : 'bg-surface border-gray-600'
                }`}
              >
                <input
                  type="radio"
                  name="reference"
                  checked={referenceId === player.player_id}
                  onChange={() => setReferenceId(player.player_id)}
                  className="accent-primary"
                />
                <span>{player.name}</span>
              </label>
            ))}
          </div>

          <label className="flex items-start gap-3 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={alreadyGrouped}
              onChange={(e) => setAlreadyGrouped(e.target.checked)}
              className="mt-1 accent-primary"
            />
            <span>
              I already grouped these players in Music Assistant. Don&apos;t regroup them, just play
              on the reference speaker&apos;s group.
            </span>
          </label>

          <div className="p-3 bg-blue-900/20 border border-blue-700/50 rounded-lg text-blue-300/80 text-sm">
            Chirps will play on every selected speaker. Set a moderate volume first. The track
            runs for 15 minutes.
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setPhase('idle')}
              disabled={stage === 'starting'}
              className="px-4 py-3 bg-surface hover:bg-gray-700 disabled:opacity-50 rounded-lg font-medium"
            >
              Back
            </button>
            <button
              onClick={handleStart}
              disabled={stage === 'starting' || selected.length < 2 || !referenceId}
              className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50 rounded-lg font-medium"
            >
              {stage === 'starting' ? 'Starting...' : 'Start'}
            </button>
          </div>
          {selected.length < 2 && (
            <p className="text-sm text-yellow-300">Select at least two players to compare.</p>
          )}
        </>
      )}

      {stage === 'running' && (
        <>
          <div>
            <h2 className="text-2xl font-bold mb-1">Measure each speaker</h2>
            <p className="text-text-muted text-sm">
              Hold the phone about a foot from a speaker, tap it below, and keep still for{' '}
              {Math.ceil(MEASURE_SECONDS)} seconds. Start with the reference, and measure it again
              at the end for the best accuracy.
            </p>
          </div>

          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span>Mic</span>
            <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-secondary transition-all duration-100"
                style={{ width: `${Math.min(100, Math.sqrt(level) * 250)}%` }}
              />
            </div>
            <span>Track left {formatClock(secondsLeft)}</span>
          </div>

          <div className="space-y-3">
            {selected.map((player) => {
              const id = player.player_id;
              const offset = offsetFor(id);
              const isReference = id === referenceId;
              const isMeasuring = measuringId === id;
              const unsteady = offset && (offset.jitterMs > 2 || offset.uncertaintyMs > 3);
              const status = sessionRef.current?.getStatus(id);
              const problem = status?.problem;
              const warning = status?.warning;
              return (
                <button
                  key={id}
                  onClick={() => handleMeasure(id)}
                  disabled={measuringId !== null}
                  className={`w-full p-4 rounded-lg border text-left transition-colors ${
                    isMeasuring
                      ? 'bg-primary/20 border-primary'
                      : 'bg-surface border-gray-600 hover:bg-gray-700'
                  } disabled:cursor-default`}
                >
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="font-medium truncate">
                      {player.name}
                      {isReference && <span className="text-xs text-secondary"> (reference)</span>}
                    </span>
                    <span className="font-mono text-sm shrink-0">
                      {isMeasuring
                        ? `Listening ${countdown}s`
                        : offset
                        ? isReference
                          ? 'measured'
                          : formatOffset(offset.offsetMs)
                        : 'tap to measure'}
                    </span>
                  </div>
                  {offset && !isMeasuring && (
                    <div className={`text-xs mt-1 ${unsteady ? 'text-yellow-300' : 'text-text-muted'}`}>
                      {!isReference && `± ${offset.uncertaintyMs.toFixed(1)} ms · `}
                      jitter {offset.jitterMs.toFixed(1)} ms · measured {offset.windows}×
                      {unsteady && ' · unsteady, measure again'}
                    </div>
                  )}
                  {problem && !isMeasuring && (
                    <div className="text-xs mt-1 text-yellow-300">{problem}</div>
                  )}
                  {!problem && warning && !isMeasuring && (
                    <div className="text-xs mt-1 text-text-muted">{warning}</div>
                  )}
                </button>
              );
            })}
          </div>

          {applied && results && (() => {
            const others = results.offsets.filter((o) => o.playerId !== referenceId);
            if (others.length === 0) return null;
            const unmeasured = selected.filter(
              (p) => p.player_id !== referenceId && !measuredIds.has(p.player_id)
            );
            const shaky = others.filter((o) => o.jitterMs > 2 || o.uncertaintyMs > 3);
            const worst = others.reduce((a, b) => (Math.abs(b.offsetMs) > Math.abs(a.offsetMs) ? b : a));
            const refName = nameOf(referenceId);
            let tone = 'bg-green-900/20 border-green-700/50 text-green-300';
            let text: string;
            if (shaky.length > 0) {
              tone = 'bg-yellow-900/20 border-yellow-700/50 text-yellow-300';
              text = `${shaky.map((o) => nameOf(o.playerId)).join(', ')} read unsteadily, so this check is not conclusive yet. Measure again before changing anything.`;
            } else if (Math.abs(worst.offsetMs) <= IN_SYNC_MS) {
              text = `Checked: every speaker measured so far is within ${IN_SYNC_MS} ms of ${refName}. No further changes needed.`;
            } else if (Math.abs(worst.offsetMs) <= CLOSE_MS) {
              tone = 'bg-yellow-900/20 border-yellow-700/50 text-yellow-300';
              text = `Close: ${nameOf(worst.playerId)} is ${formatOffset(worst.offsetMs)} of ${refName}. That is hard to hear. Use Review changes only if you can hear it.`;
            } else {
              tone = 'bg-red-900/20 border-red-700/50 text-red-300';
              text = `${nameOf(worst.playerId)} is still ${formatOffset(worst.offsetMs)} of ${refName}. Use Review changes to correct it, then check again.`;
            }
            return (
              <div className={`p-3 border rounded-lg text-sm ${tone}`}>
                {text}
                {unmeasured.length > 0 && ` Not measured yet: ${unmeasured.map((p) => p.name).join(', ')}.`}
              </div>
            );
          })()}

          {interrupted && (
            <div className="p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg text-yellow-300 text-sm">
              Music Assistant reported that playback stopped during this session. Readings taken
              before and after a stop cannot be compared. Tap Stop and start again once the group
              plays steadily.
            </div>
          )}

          {results && (
            <p
              className={`text-xs ${
                Math.abs(results.driftPpm) > 300 ? 'text-yellow-300' : 'text-text-muted'
              }`}
            >
              Phone clock drift against the stream: {results.driftPpm.toFixed(0)} ppm (corrected).
              {Math.abs(results.driftPpm) > 300 &&
                ' That is more than a phone clock should drift, which usually means playback was unsteady.'}
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleStop}
              disabled={measuringId !== null}
              className="px-4 py-3 bg-surface hover:bg-gray-700 disabled:opacity-50 rounded-lg font-medium"
            >
              Stop
            </button>
            <button
              onClick={() => void sessionRef.current?.unmuteAll()}
              disabled={measuringId !== null}
              className="px-4 py-3 bg-surface hover:bg-gray-700 disabled:opacity-50 rounded-lg font-medium"
            >
              Unmute all
            </button>
            <button
              onClick={handleReview}
              disabled={!canReview || measuringId !== null}
              className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50 rounded-lg font-medium"
            >
              Review changes
            </button>
          </div>
        </>
      )}

      {stage === 'review' && plan && (
        <>
          <div>
            <h2 className="text-2xl font-bold mb-1">Review changes</h2>
            <p className="text-text-muted text-sm">
              These are the Music Assistant delay settings that would line the speakers up.
              Nothing is saved until you tap Apply.
            </p>
          </div>

          <div className="space-y-3">
            {plan.map((row) => {
              const outcome = applyResults?.find((r) => r.playerId === row.playerId);
              const measured = offsetFor(row.playerId);
              const shaky = measured && (measured.jitterMs > 2 || measured.uncertaintyMs > 3);
              return (
                <div key={row.playerId} className="p-4 bg-surface rounded-lg text-sm space-y-1">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium truncate">{row.playerName}</span>
                    <span className="font-mono shrink-0">{formatOffset(row.offsetMs)}</span>
                  </div>
                  {row.setting && row.newValue !== null ? (
                    <div className="text-text-muted">
                      {row.setting.key}: {row.setting.current} → {row.newValue} ms
                      {row.newValue === row.setting.current && ' (no change)'}
                    </div>
                  ) : (
                    <div className="text-yellow-300">
                      Can't be changed from here
                    </div>
                  )}
                  {shaky && (
                    <div className="text-yellow-300 text-xs">
                      This reading was unsteady (± {measured.uncertaintyMs.toFixed(1)} ms). Consider
                      measuring again before applying.
                    </div>
                  )}
                  {row.note && <div className="text-yellow-300 text-xs">{row.note}</div>}
                  {outcome && !outcome.success && (
                    <div className="text-red-300 text-xs">Save failed: {outcome.error}</div>
                  )}
                </div>
              );
            })}
          </div>

          {(() => {
            const fixed = plan.filter((row) => !row.setting);
            if (fixed.length < 2) return null;
            const offsets = fixed.map((row) => row.offsetMs);
            const spread = Math.max(...offsets) - Math.min(...offsets);
            if (spread < 1) return null;
            return (
              <p className="text-yellow-300 text-sm">
                {fixed.map((row) => row.playerName).join(' and ')} have no delay setting here, so
                they stay about {spread.toFixed(1)} ms apart.
              </p>
            );
          })()}

          <div className="flex gap-3">
            <button
              onClick={() => {
                setPlan(null);
                setStage('running');
              }}
              disabled={applying}
              className="px-4 py-3 bg-surface hover:bg-gray-700 disabled:opacity-50 rounded-lg font-medium"
            >
              Back
            </button>
            <button
              onClick={handleApply}
              disabled={applying}
              className="flex-1 py-3 px-4 bg-primary hover:bg-primary-dark disabled:opacity-50 rounded-lg font-medium"
            >
              {applying ? 'Applying...' : 'Apply'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
