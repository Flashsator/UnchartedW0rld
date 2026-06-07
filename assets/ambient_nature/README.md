# ambient_nature — interlude-only nature / white-noise beds

Drop nature ambience here: birdsong, insect/cricket chirps, white noise, rain,
forest, ocean, etc. These play **only as short interlude beds between sections**
(`fetchAmbient` / `pickLocalAmbient` in `src/stock.ts`). They are deliberately
kept **out of the main-BGM pool**, so they never play under the whole narration.

## Rules

- **Naming:** `Title - Artist.mp3` (same as `yt_music/`), so the attribution
  block can credit them. White noise with no artist: `White Noise - .mp3` works
  (empty artist is allowed), but a real credit is better.
- **Licensing:** must be Content-ID-safe. Prefer the YouTube Audio Library
  ambience / sound-effects section, same policy as `yt_music/`. A claimed track
  here will claim the video just like a BGM track would.
- **Blacklist:** entries in `assets/music_blacklist.txt` (path relative to
  `assets/`, forward slashes) are skipped here too.

Empty folder = no nature beds; interludes fall back to the calmest `yt_music/`
tracks automatically. Subfolders are fine (scanned recursively).
