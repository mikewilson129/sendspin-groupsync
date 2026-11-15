# How GroupSync works

GroupSync measures how much later (or earlier) each speaker is heard compared with a reference speaker, then writes matching delay settings into Music Assistant (MA).

## The idea: measure relative to a reference

Every speaker in the group plays the same stream. If speaker B is heard 40 ms after speaker A, that 40 ms is B's real error compared with A, whatever caused it: Bluetooth, network buffering, a slow TV, or the distance from the phone.

So the app never tries to learn a speaker's absolute delay. It only compares speakers with each other on the phone's own audio clock, then moves them toward the reference.

## 1. The test track

`syncPattern.ts` defines the track, and `vite.config.ts` generates it in memory and serves it at `/sync-track.wav`.

- One chirp per second. Each chirp is 40 ms long, sweeps 1000 to 4000 Hz and has a smooth fade in and out, so it works on phone microphones and small speakers.
- Every fourth chirp sweeps down instead of up. The down-sweeps mark a 4-second cycle, so a speaker that is up to about 2 seconds late or early is still matched to the right chirp.
- The track is 15 minutes long and mono, at 16 kHz.

## 2. One group, one reference

`GroupSyncSession.groupPlayers()` joins the chosen players into a native MA sync group led by the reference speaker.

- Before grouping, `clearExistingGroups()` ungroups any chosen speaker that is already in an ad-hoc group. A player can only be in one group, and leftovers from selecting several players in the MA app would otherwise pull speakers away from the group built here.
- Players are added one at a time, and the result is checked through `synced_to`, because MA skips players that cannot join without reporting an error.
- The app then checks that the right players are in the group and playing, and shows a note on any that are not. A player that is audible but reported as not playing, which some Bluetooth bridges do, only gets a grey warning.

## 3. Listening to one speaker at a time

For each measurement, `measure()` mutes all the other chosen players. Where mute does not work, it turns their volume to zero and restores it afterwards. It waits 2.5 seconds for that to take effect, then records 9 seconds.

`MicCapture` records through an AudioWorklet and stamps every block with the audio frame counter. Echo cancellation, noise suppression and auto gain are off. Because timing comes from audio frames and not from `setTimeout` or `performance.now()`, a busy main thread cannot shift the result.

## 4. Finding the chirps

`ClickAnalyzer` correlates the recording with the up-chirp and the down-chirp templates, in two phases so the result does not depend on the phase of the sound. It keeps peaks that stand at least 6 times above the noise floor and refines each peak to a fraction of a sample. At least 5 good chirps are needed. The down-sweeps give each chirp its place in the 4-second cycle.

If it hears chirps but cannot find the markers, the message points at the usual causes: another speaker is audible, or playback is still settling.

## 5. Solving for offsets

`solveOffsets()` treats chirp number *n* leaving speaker *p* as arriving at `t = r·n + θ_p`. Here `r` is the chirp interval as seen by the phone clock, which differs a little from 1 second because the phone and the server clocks drift apart. θ_p is what we want.

- All measurements share one slope `r`, and each speaker has its own intercept. Measuring the reference more than once lets the solver separate drift from real offset.
- Phone clocks usually drift by tens of parts per million. The solver assumes drift is around 100 ppm at most, and when the data is noisy it pulls the slope toward "no drift", so one bad window cannot invent a large drift.
- Each offset is `θ_p − θ_reference`, wrapped into the 4-second cycle, with an uncertainty and a jitter figure. Jitter is the spread of that speaker's chirps around the fit, and a high value means the speaker's playback is unsteady.

## 6. Turning offsets into settings

`planDelays()` picks the MA setting that controls each player:

- `sendspin_static_delay` (0 to 5000 ms): raise it for a player heard late.
- `sync_adjust` (-500 to 500 ms): positive plays later, negative plays earlier.

A player that exposes its output through another protocol, such as AirPlay, keeps the setting on the parent player as `<id>||protocol||<key>`, and the app reads and saves that exact key.

Players with no delay setting cannot be moved, so the others are moved to match them. If a value would fall outside the allowed range, it is clamped and the review screen says what remains.

Nothing is saved until the person taps Apply. `applyDelays()` then saves each setting with `config/players/save`.

## 7. Checking the result

After Apply, the app clears its measurements. Measuring again shows a panel with the verdict:

- Every speaker within 5 ms of the reference: no further changes.
- Within 15 ms: close, and hard to hear.
- Beyond that: use Review changes again.
- A speaker with jitter above 2 ms, or an uncertainty above 3 ms, is called unsteady, and the verdict waits for another measurement.

## Limits

- Only players that share a sync protocol can be grouped. A plain Chromecast speaker, for example, cannot join a native Sendspin group.
- Universal Groups stream to each member separately, so their offsets wander and are not reliable to measure.
- Bluetooth links can drift in and out of steadiness. Measure again if a reading is marked unsteady.
- The result is only as accurate as the phone's microphone placement. Hold it about a foot from each speaker, and keep the phone in the same position for the reference measurements.
