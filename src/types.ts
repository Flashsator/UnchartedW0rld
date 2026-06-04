export type SectionOverlay = {
  kind: 'stat' | 'label' | 'compare';
  triggerWord: string;
  text: string;
  subtext?: string;
  compareLabel?: string;
  compareWith?: string;
  compareLeftValue?: number;
  compareRightValue?: number;
  holdSec?: number;
};

export type ScriptSection = {
  heading: string;
  narration: string;
  visual: string;
  overlays?: SectionOverlay[];
};

export type Episode = {
  title: string;
  hook: string;
  description: string;
  tags: string[];
  // The one concrete, photographable thing this whole episode is about (e.g.
  // "cave spider", "glass frog", "Roman aqueduct"). Every section's b-roll
  // query is anchored to this subject so the footage stays recognizably
  // on-topic instead of drifting into abstract or tangential stock clips.
  subject?: string;
  sections: ScriptSection[];
  // Concrete, non-abstract visual concept for the thumbnail background image,
  // and the single punchy caption word. Generated per-episode by the script
  // model so the cover actually depicts the topic instead of abstract texture.
  thumbnailConcept?: string;
  thumbnailWord?: string;
};

export type WordTiming = {
  start: number;
  end: number;
  text: string;
};

// A music track credit derived from its "Title - Artist.mp3" filename, used to
// auto-build the attribution block in the video description.
export type MusicCredit = {
  title: string;
  artist: string;
};

export type SectionAudio = {
  index: number;
  narration: string;
  heading: string;
  visual: string;
  mp3Path: string;
  duration: number;
  words: WordTiming[];
  voiceId: string;
};

export type BrollClip = {
  path: string;
  duration: number;
  width: number;
  height: number;
};

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

export type IconEvent = {
  start: number;
  emoji: string;
};

export type Interlude = {
  afterSectionIndex: number;
  durationSec: number;
  visualPath: string;
  audioPath: string;
};

export type StingConfig = {
  subFreq: number;
  topFreq: number;
  topDuration: number;
};

export type RuntimeProfile = {
  voiceId: string;
  voiceLabel: string;
  toneKey: string;
  toneLabel: string;
  structureKey: string;
  structureLabel: string;
  thumbLayout: string;
  subTheme: string;
  hookPattern: string;
};

export type RenderManifest = {
  series: string;
  title: string;
  hook: string;
  coldOpenVisualPath: string;
  intro: { durationSec: number };
  sections: Array<{
    heading: string;
    audioPath: string;
    duration: number;
    gapAfterSec: number;
    brollPaths: string[];
    cutTimes: number[];
    words: WordTiming[];
    iconEvents: IconEvent[];
    overlays?: SectionOverlay[];
  }>;
  interludes: Interlude[];
  outro: { durationSec: number };
  bgmPath: string;
  bgmVolume: number;
  totalDuration: number;
  sting?: StingConfig;
  profile?: RuntimeProfile;
};

export type ShortsPlanEntry = {
  sectionIdx: number;
  daysAhead: number;
};

export type ShortsManifest = {
  series: string;
  longTitle: string;
  shortsTitle: string;
  // Full hook line — used to seed the shorts description/blurb.
  hook: string;
  // Compact, single-thought version of the hook for the on-screen title card,
  // so the big text block stays to a couple of lines instead of swallowing the
  // frame. Derived from `hook` in buildShortsManifest.
  cardHook: string;
  sectionIdx: number;
  audioPath: string;
  // Total composition length = narrationSec + outroSec. Narration plays for
  // narrationSec, then an end card (subscribe + watch full video) fills outroSec.
  duration: number;
  narrationSec: number;
  outroSec: number;
  brollPaths: string[];
  cutTimes: number[];
  words: WordTiming[];
  overlays?: SectionOverlay[];
  bgmPath: string;
  bgmVolume: number;
};
