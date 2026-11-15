# CLAUDE.md - Developer Guidance for GroupSync

This file gives AI assistants context for working on this codebase. Keep it in step with the code.

## Project purpose

GroupSync is a mobile web app that lines up the timing of Sendspin speakers in Music Assistant (MA). It plays a chirp track on all chosen speakers as one sync group, measures each speaker with the phone microphone, and saves new delay settings through the MA API.

It does not talk to players directly and it does not speak the Sendspin protocol. Everything goes through the MA WebSocket API.

## How a calibration run works

1. `GroupSyncSession.start()` unmutes the chosen players, builds one sync group led by the reference speaker (`groupPlayers()`), and plays the chirp track on it.
2. `GroupSyncSession.measure(id)` mutes the other players, waits for the mute to land, records with `MicCapture`, and runs `analyzeClicks` on the recording.
3. `solveOffsets()` combines every measurement into an offset per player relative to the reference.
4. `planDelays()` in `src/sync-push/DelayApplier.ts` turns offsets into new values for each player's MA delay setting. `applyDelays()` saves them with `config/players/save`.

More detail is in `docs/HOW_IT_WORKS.md`.

## Code map

| Path | Purpose |
|------|---------|
| `src/calibration/syncPattern.ts` | Test pattern constants and WAV builder. No DOM or Node imports, because it is used by both the browser and `vite.config.ts` |
| `src/calibration/MicCapture.ts` | AudioWorklet capture into a ring buffer, stamped with audio frame numbers |
| `src/calibration/ClickAnalyzer.ts` | Matched-filter chirp detection and marker identification |
| `src/calibration/syncSolver.ts` | Offsets and clock drift from chirp arrival times |
| `src/calibration/GroupSyncSession.ts` | Grouping, muting, measuring and cleanup against MA |
| `src/sync-push/DelayApplier.ts` | Reads, plans and saves the MA delay settings |
| `src/ma-client/MAWebSocketClient.ts` | MA WebSocket client, sign-in, token reuse and reconnect |
| `src/components/` | `ConnectionPanel`, `PlayerList`, `GroupCalibration` |
| `src/store/` | Zustand stores for the connection and the screen phase |
| `vite.config.ts` | Plugin that generates and serves `/sync-track.wav` |

## Music Assistant facts the code relies on

Checked against MA 2.10.9. Re-check them after an MA upgrade.

- **Delay settings.** `sendspin_static_delay` (0 to 5000 ms) is raised when a player is heard late. `sync_adjust` (-500 to 500 ms) is positive for later and negative for earlier. A player that exposes its output through another protocol stores the setting on the parent player as `<id>||protocol||<key>`. `readDelaySetting()` looks for both forms and returns the exact key to save.
- **Grouping.** `players/cmd/set_members` silently skips players that are not in the target's `can_group_with`, and redirects to the active group when the target is already a member of one. After adding members, check `synced_to` instead of trusting the call.
- **One group at a time.** A player can only be in one group. Ad-hoc groups made by selecting several players in the MA app pull speakers away from the group GroupSync builds, so `clearExistingGroups()` ungroups them at the start. Groups with `type === 'group'` (Universal Group or sync-group players) are left alone.
- **Universal Groups** stream to each member independently, so measured offsets wander. Native Sendspin groups gave about 0.3 ms of jitter in testing.
- **Authentication.** MA 2.10 may require sign-in after reconnecting. The client keeps a token in `localStorage` under `ma_access_token`.
- **Player state.** Some players, such as Bluetooth bridges, report a state other than "playing" while audible. That is a soft `warning` on `PlayerStatus`, not a `problem`.

## Conventions

- TypeScript strict mode, React 19, Zustand, Tailwind. Mobile first.
- Comments say why, not what.
- Keep `syncPattern.ts` free of DOM and Node imports.
- Before finishing, run `npm run build` (it runs `tsc -b` first) and `npm run lint`.

## Testing

There are no automated tests yet. Test on real speakers:

- [ ] Connect to MA and list players
- [ ] Start with two speakers and see both in the group
- [ ] Measure the reference twice; the readings should agree within a few milliseconds
- [ ] Measure another speaker; the jitter should be a few milliseconds or less
- [ ] Review changes shows a sensible setting for each speaker
- [ ] Apply, measure again, and see the check panel report the result
- [ ] Stop actually stops the chirps on every speaker
- [ ] Start again while an ad-hoc MA group exists; the group is cleared and a note is shown

Debug output is in the browser console, prefixed with `[GroupSync]`.

## Gotchas

1. **HTTPS is required.** Microphone access needs a secure context. The dev server uses a self-signed certificate (`@vitejs/plugin-basic-ssl`).
2. **`wss://` from an HTTPS page.** `MAWebSocketClient.buildWebSocketUrl()` always uses `wss://` when the page is HTTPS, because browsers block insecure WebSockets from secure pages. The MA address entered must accept that.
3. **Echo cancellation, noise suppression and auto gain are off** in `getUserMedia`. The chirps must reach the analyzer unprocessed.
4. **The track is served by this app.** MA fetches `/sync-track.wav` from the machine running the dev server, so that machine must be reachable from the MA server.
5. **Saving a delay can restart a player,** which stops the chirps. Tell the person to Stop and Start again.
6. **Stop must stop every player.** A queue stop alone has been seen to leave chirps playing, so `finish()` also sends `players/cmd/stop` to each chosen player.
