# GroupSync

A mobile web app that lines up the timing of Sendspin speakers in Music Assistant. It plays a chirp track on all your speakers as one group, listens to each speaker with your phone's microphone, and then saves the matching delay settings in Music Assistant.

You walk to each speaker, hold the phone near it, and tap. The app mutes the others while it listens, so it hears one speaker at a time.

## How it works

1. All chosen players are joined into one sync group led by a reference speaker, and a chirp track plays on that group. Every speaker plays the same stream, so any difference in when their chirps arrive is that speaker's real timing error.
2. For each speaker, the app mutes the others and records about nine seconds of chirps through an AudioWorklet. Every sample is stamped with the audio hardware's frame counter, so the phone's own clock is the only clock that matters.
3. A matched filter finds each chirp, and every fourth chirp sweeps down instead of up so the app can tell which chirp is which. That makes offsets of up to about two seconds unambiguous.
4. A solver turns the arrival times into each speaker's offset from the reference. It also fits and removes the drift between the phone's clock and the stream.
5. The review screen shows the Music Assistant setting each speaker would change (`sendspin_static_delay` or `sync_adjust`) and the new value. Nothing is saved until you tap Apply.
6. After Apply, measure again. A panel tells you whether every speaker is now within 5 ms of the reference.

See [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for details.

## Requirements

- Music Assistant 2.10 or newer, with the speakers connected as Sendspin players. Tested with 2.10.9.
- A computer on your network to run this app, and a phone with a microphone.
- The page must be served over HTTPS, because browsers only allow microphone access on secure pages. The dev server does this with a self-signed certificate, so your phone will ask you to accept it once.
- Because the page is HTTPS, the app always opens a `wss://` (secure) WebSocket to the Music Assistant address you enter. If the connection fails, check that address first.
- Music Assistant fetches the test track from the computer running the app, so that computer must be reachable from the Music Assistant server. This worked in testing against the dev server's self-signed certificate.

## Run it

```bash
npm install
npm run dev
```

Open the HTTPS address it prints on your phone, enter your Music Assistant address, and sign in if asked.

## Using it

1. Pick the players to calibrate and tap Start Calibration.
2. Pick a reference speaker that you can get back to easily. The others are lined up to it.
3. Tap Start. The chirp track plays on all the chosen speakers, and the track lasts 15 minutes.
4. Measure the reference first, then each other speaker, holding the phone about a foot from it and keeping still for 12 seconds.
5. Measure the reference again at the end for the best accuracy.
6. Tap Review changes, check the new values, and tap Apply.
7. Measure again to check the result.

## Good to know

- **Only speakers that share a sync protocol can be grouped.** Sendspin players sync natively. Players of another ecosystem (for example a plain Chromecast speaker) cannot join that group, and measuring them through a Universal Group is unreliable because each member streams independently.
- **Leftover groups cause trouble.** A group made by selecting players in the Music Assistant app can pull speakers away from the group the app builds. The app takes chosen speakers out of such groups when it starts. Tick "I already grouped these players in Music Assistant" to keep your own group instead.
- **Bluetooth speakers read less steadily.** They can add hundreds of milliseconds of delay, which the app corrects, but their timing can wobble. If a reading is marked unsteady, measure again.
- **Some players report "not playing" while audible.** The app shows this as a grey note, not an error.
- **TVs reached over AirPlay may not cope with 24-bit music.** A Roku TV added through AirPlay played static whenever 24-bit (hi-res) music was sent to it on its own. Turning off the 24-bit option in that player's audio settings in Music Assistant fixed it. The cause was not confirmed; it may be the TV or the speakers behind it. GroupSync's own test track is 16-bit, so it does not show this problem.
- **Players with no delay setting in Music Assistant** cannot be changed. The others are moved to match them, and the review screen lists what cannot be fixed.

## Project layout

| Path | Purpose |
|------|---------|
| `src/calibration/` | Test pattern, microphone capture, chirp detection, solver and the group session |
| `src/sync-push/DelayApplier.ts` | Finds each player's delay setting in Music Assistant and saves new values |
| `src/ma-client/` | Music Assistant WebSocket client with sign-in and automatic re-authentication |
| `src/components/` | Connection screen, player list and the calibration screen |
| `vite.config.ts` | Dev server plugin that generates and serves the chirp track |

## Credits

This is a fork of [chrisuthe/sendspin-groupsync](https://github.com/chrisuthe/sendspin-groupsync). The original idea and project structure are theirs. This version replaces the click-track calibration with relative chirp measurements and saves the real Music Assistant delay settings.

## License

See [LICENSE](LICENSE).
