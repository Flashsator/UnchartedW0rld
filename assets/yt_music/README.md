# yt_music — the ONLY BGM/ambient source by default

MP3s under this folder (any subfolder depth) are the sole source used for BGM
and interlude ambience. They come from the official **YouTube Audio Library**
(studio.youtube.com → Audio Library), which YouTube does not Content-ID-claim on
uploads — so they don't lose monetization the way Pixabay tracks do.

## Structure

Subfolders are free-form; the picker recurses into all of them. The current
genre/mood split works well:

```
yt_music/
  Cinematic-Dark/      Cinematic -Dramatic/
  Ambient -Calm/       Ambient -Dark/
  Classical-Calm/      Classical-Dark/
```

- **BGM selection** scores tracks by matching script keywords (≥4 chars) against
  the file path, so genre/mood folder names like `Cinematic-Dark` help relevance.
- **Interlude ambience** prefers folders whose name contains `ambient`, `calm`,
  or `nature`.
- The picker avoids replaying the immediately previous episode's track, so keep
  several tracks here.

## Rules

- `assets/**/*.mp3` is un-ignored in `.gitignore`, so committed mp3s are tracked.
- If this folder is empty and `ALLOW_PIXABAY_MUSIC` is not set, the run
  **fails fast** rather than ship a video with claimed music.
- "Attribution required" tracks need a credit line in the video description;
  using only "Attribution not required" tracks keeps it zero-maintenance.
- If any track ever gets claimed, add its assets-relative path (e.g.
  `yt_music/Cinematic-Dark/foo.mp3`) to `assets/music_blacklist.txt`.
