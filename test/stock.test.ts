import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateClipsAcrossBeats,
  backfillSectionClips,
  filterAndRankByRelevance,
  interleaveRoundRobin,
  isClipOnSubject,
  isPermissiveLicense,
  orderPoolByPreference,
  pexelsSlugText,
  pickBestVideoFile,
  pixabayCategoryForSeries,
  planSectionShots,
  preferredMoods,
  moodFromPath,
  parseCommonsResults,
  relaxedQueryVariants,
  segmentWindow,
  shotSource,
  stripHtml,
  normalizeINatLicense,
  iNatLicenseLabel,
  licenseNeedsAttribution,
  parseINaturalistResults,
  shortsStillIntroCount,
} from '../src/stock.js';
import type { BrollClip } from '../src/types.js';

// --- shortsStillIntroCount -----------------------------------------------------

test('shortsStillIntroCount splits ~half to stills, always leaving footage', () => {
  assert.equal(shortsStillIntroCount(8, 0.5), 4);
  assert.equal(shortsStillIntroCount(10, 0.5), 5);
  assert.equal(shortsStillIntroCount(2, 0.5), 1);
});

test('shortsStillIntroCount never takes every slot and never zero-below-2', () => {
  assert.equal(shortsStillIntroCount(1, 0.5), 0); // too few slots to split
  assert.equal(shortsStillIntroCount(10, 2), 9); // ratio clamps; back half keeps >=1
  assert.equal(shortsStillIntroCount(6, 0), 1); // floor of 1 still when enabled
});

test('shortsStillIntroCount tolerates a NaN ratio (defaults to half)', () => {
  assert.equal(shortsStillIntroCount(8, Number.NaN), 4);
});

// --- iNaturalist parsing -------------------------------------------------------

test('normalizeINatLicense turns hyphen codes into space form so isPermissiveLicense applies', () => {
  assert.equal(normalizeINatLicense('cc-by'), 'cc by');
  assert.equal(normalizeINatLicense('CC-BY-NC'), 'cc by nc');
  assert.equal(normalizeINatLicense('cc0'), 'cc0');
  assert.equal(normalizeINatLicense(''), '');
});

test('iNatLicenseLabel renders a clean display label', () => {
  assert.equal(iNatLicenseLabel('cc0'), 'CC0');
  assert.equal(iNatLicenseLabel('cc-by'), 'CC BY');
  assert.equal(iNatLicenseLabel(''), 'Unknown license');
});

test('licenseNeedsAttribution: CC0/PD free, CC BY requires credit', () => {
  assert.equal(licenseNeedsAttribution('CC0'), false);
  assert.equal(licenseNeedsAttribution('Public domain'), false);
  assert.equal(licenseNeedsAttribution('CC BY'), true);
});

test('parseINaturalistResults keeps only permissive photos, upgrades URL, and credits the author', () => {
  const resp = {
    results: [
      {
        id: 111,
        taxon: { name: 'Bubo bubo', preferred_common_name: 'Eurasian Eagle-Owl' },
        user: { login: 'birder1', name: 'A. Birder' },
        photos: [
          { url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/9/square.jpg', license_code: 'cc-by', original_dimensions: { width: 2048, height: 1365 } },
        ],
      },
      { id: 222, user: { login: 'x' }, photos: [{ url: 'https://x/square.jpg', license_code: 'cc-by-nc' }] }, // non-commercial → dropped
      { id: 333, user: { login: 'y' }, photos: [{ url: 'https://y/square.jpg', license_code: null }] }, // all rights reserved → dropped
      { id: 444, taxon: { name: 'Owl sp.' }, user: { login: 'z' }, photos: [{ url: 'https://z/square.jpg', license_code: 'cc0', original_dimensions: { width: 800, height: 200 } }] }, // too short → dropped
    ],
  };
  const out = parseINaturalistResults(resp, 720);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, 'https://inaturalist-open-data.s3.amazonaws.com/photos/9/original.jpg');
  assert.equal(out[0]!.credit.title, 'Eurasian Eagle-Owl');
  assert.equal(out[0]!.credit.author, 'A. Birder');
  assert.equal(out[0]!.credit.license, 'CC BY');
  assert.match(out[0]!.credit.url, /observations\/111$/);
});

test('parseINaturalistResults accepts a CC0 photo with no dimensions (best-effort)', () => {
  const resp = {
    results: [
      { id: 5, taxon: { name: 'Felis catus' }, user: { login: 'c' }, photos: [{ url: 'https://c/square.jpeg', license_code: 'cc0' }] },
    ],
  };
  const out = parseINaturalistResults(resp, 720);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, 'https://c/original.jpeg');
  assert.equal(out[0]!.credit.license, 'CC0');
  assert.equal(licenseNeedsAttribution(out[0]!.credit.license), false);
});

test('distributes evenly when it divides', () => {
  assert.deepEqual(allocateClipsAcrossBeats(6, 3), [2, 2, 2]);
});

test('gives the remainder to the earliest beats (narration order)', () => {
  assert.deepEqual(allocateClipsAcrossBeats(7, 3), [3, 2, 2]);
  assert.deepEqual(allocateClipsAcrossBeats(8, 3), [3, 3, 2]);
});

test('every beat gets at least one when needed equals beat count', () => {
  assert.deepEqual(allocateClipsAcrossBeats(4, 4), [1, 1, 1, 1]);
});

test('allocation always sums to needed', () => {
  for (const needed of [1, 5, 7, 11, 18]) {
    for (const beats of [1, 2, 3, 4, 6]) {
      const out = allocateClipsAcrossBeats(needed, beats);
      assert.equal(out.length, beats);
      assert.equal(
        out.reduce((a, b) => a + b, 0),
        needed,
        `sum mismatch for needed=${needed} beats=${beats}`,
      );
      assert.ok(
        out.every((n) => n >= 0),
        `negative allocation for needed=${needed} beats=${beats}`,
      );
    }
  }
});

test('zero beats yields an empty allocation', () => {
  assert.deepEqual(allocateClipsAcrossBeats(5, 0), []);
});

// --- backfillSectionClips ----------------------------------------------------

const bclip = (p: string): BrollClip => ({ path: p, duration: 6, width: 1920, height: 1080 });

test('backfillSectionClips cycles the pool to fill the needed count with variety', () => {
  const pool = [bclip('a'), bclip('b'), bclip('c')];
  assert.deepEqual(backfillSectionClips(pool, 5).map((c) => c.path), ['a', 'b', 'c', 'a', 'b']);
});

test('backfillSectionClips returns exactly the pool when needed matches its size', () => {
  const pool = [bclip('a'), bclip('b')];
  assert.deepEqual(backfillSectionClips(pool, 2).map((c) => c.path), ['a', 'b']);
});

test('backfillSectionClips returns [] when the pool is empty (caller then fails loudly)', () => {
  assert.deepEqual(backfillSectionClips([], 4), []);
});

test('backfillSectionClips returns [] for a non-positive needed count', () => {
  const pool = [bclip('a')];
  assert.deepEqual(backfillSectionClips(pool, 0), []);
  assert.deepEqual(backfillSectionClips(pool, -3), []);
});

test('backfillSectionClips degrades to a single pooled clip when only one is available', () => {
  // Degenerate last resort: one on-subject clip held across the section beats
  // beats a crashed run; the renderer's Ken Burns still gives it motion.
  assert.deepEqual(backfillSectionClips([bclip('only')], 3).map((c) => c.path), [
    'only',
    'only',
    'only',
  ]);
});

// --- planSectionShots --------------------------------------------------------

test('planSectionShots expands per-beat slots in narration order', () => {
  assert.deepEqual(planSectionShots([2, 1]), [
    { beatIndex: 0, reuseOrdinal: 0 },
    { beatIndex: 0, reuseOrdinal: 1 },
    { beatIndex: 1, reuseOrdinal: 0 },
  ]);
});

test('planSectionShots marks the first shot of each beat as the hero (ordinal 0)', () => {
  const shots = planSectionShots([3, 2]);
  // Exactly one ordinal-0 (hero) per beat.
  const heroes = shots.filter((s) => s.reuseOrdinal === 0).map((s) => s.beatIndex);
  assert.deepEqual(heroes, [0, 1]);
  // Total shots equals the sum of the slot counts.
  assert.equal(shots.length, 5);
});

test('planSectionShots skips beats with zero (or negative/fractional) slots', () => {
  assert.deepEqual(planSectionShots([0, 2]), [
    { beatIndex: 1, reuseOrdinal: 0 },
    { beatIndex: 1, reuseOrdinal: 1 },
  ]);
  assert.deepEqual(planSectionShots([-1, 1.9]), [{ beatIndex: 1, reuseOrdinal: 0 }]);
});

test('planSectionShots returns empty for an empty allocation', () => {
  assert.deepEqual(planSectionShots([]), []);
});

// --- segmentWindow -----------------------------------------------------------

test('segmentWindow returns null for the hero shot (ordinal 0)', () => {
  assert.equal(segmentWindow(0, 7, 20), null);
});

test('segmentWindow returns null when the clip is no longer than one shot', () => {
  assert.equal(segmentWindow(1, 7, 7), null);
  assert.equal(segmentWindow(1, 7, 5), null);
});

test('segmentWindow cuts a distinct later window that extends to the clip end', () => {
  const win = segmentWindow(1, 7, 20);
  assert.deepEqual(win, { ss: 7, t: 13 });
});

test('segmentWindow returns distinct, non-overlapping starts and null past the clip end', () => {
  // 30s hero / 7s shots: maxStart = 30 - 7 = 23. Ordinals start a full shot
  // apart (7/14/21), each extending to the clip end; ordinal 4 (4*7=28 > 23)
  // has no further distinct window → null (caller drops the slot, never replays).
  assert.deepEqual(segmentWindow(1, 7, 30), { ss: 7, t: 23 });
  assert.deepEqual(segmentWindow(2, 7, 30), { ss: 14, t: 16 });
  assert.deepEqual(segmentWindow(3, 7, 30), { ss: 21, t: 9 });
  assert.equal(segmentWindow(4, 7, 30), null);
});

test('segmentWindow never overlaps and never repeats a start within a hero', () => {
  const dur = 30;
  const perShot = 7;
  const starts = new Set<number>();
  for (let ordinal = 1; ordinal <= 10; ordinal++) {
    const win = segmentWindow(ordinal, perShot, dur);
    if (!win) continue;
    assert.ok(!starts.has(win.ss), `repeated start ${win.ss} at ordinal ${ordinal}`);
    starts.add(win.ss);
    assert.ok(win.t >= perShot, `t<perShot at ordinal ${ordinal}`); // ss ≤ maxStart guarantees this
  }
  // ordinal 4 (28) > maxStart (23) → null, so only 1..3 survive — all distinct.
  assert.deepEqual([...starts].sort((a, b) => a - b), [7, 14, 21]);
});

test('segmentWindow guarantees t >= perShot so a segment never freezes', () => {
  for (const ordinal of [1, 2, 3, 5, 9]) {
    for (const dur of [8, 10, 15, 30]) {
      const win = segmentWindow(ordinal, 7, dur);
      if (win) assert.ok(win.t >= 7, `t<perShot for ordinal=${ordinal} dur=${dur}`);
    }
  }
});

test('segmentWindow rejects non-finite or non-positive inputs', () => {
  assert.equal(segmentWindow(1, 0, 20), null);
  assert.equal(segmentWindow(1, 7, 0), null);
  assert.equal(segmentWindow(1, NaN, 20), null);
  assert.equal(segmentWindow(1, 7, Infinity), null);
});

// --- shotSource --------------------------------------------------------------

test('shotSource maps the first ordinals to distinct downloaded clips', () => {
  assert.deepEqual(shotSource(0, 2), { kind: 'clip', index: 0 });
  assert.deepEqual(shotSource(1, 2), { kind: 'clip', index: 1 });
});

test('shotSource falls back to a hero segment once the distinct clips run out', () => {
  // Beyond distinctCount, segment ordinals restart at 1 so the first reused
  // segment starts at ss = perShot (segmentWindow ordinal 1).
  assert.deepEqual(shotSource(2, 2), { kind: 'segment', ordinal: 1 });
  assert.deepEqual(shotSource(3, 2), { kind: 'segment', ordinal: 2 });
});

test('shotSource with a single distinct clip matches the old one-hero behavior', () => {
  assert.deepEqual(shotSource(0, 1), { kind: 'clip', index: 0 });
  assert.deepEqual(shotSource(1, 1), { kind: 'segment', ordinal: 1 });
  assert.deepEqual(shotSource(2, 1), { kind: 'segment', ordinal: 2 });
});

test('preferredMoods picks the dominant mood from music tags', () => {
  assert.deepEqual(preferredMoods(['dark cinematic suspense underscore']), ['dark']);
  assert.deepEqual(preferredMoods(['tense investigative ambient']), ['dark']);
});

test('preferredMoods returns empty when nothing matches', () => {
  assert.deepEqual(preferredMoods(['underscore documentary']), []);
  assert.deepEqual(preferredMoods([]), []);
});

test('preferredMoods can return a tie of equally-weighted moods', () => {
  const out = preferredMoods(['epic gentle']); // epic->dramatic, gentle->calm
  assert.deepEqual([...out].sort(), ['calm', 'dramatic']);
});

test('moodFromPath reads the mood folder from an assets-relative path', () => {
  assert.equal(moodFromPath('yt_music/Cinematic-Dramatic/Night Falls - Everet Almond.mp3'), 'dramatic');
  assert.equal(moodFromPath('yt_music/Cinematic-Dark/Down - Joey Pecoraro.mp3'), 'dark');
  assert.equal(moodFromPath('yt_music/Classical-Dark/Toccata in D minor - Bach.mp3'), 'dark');
  assert.equal(moodFromPath('yt_music/Ambient-Calm/Lens - Bobby Richards.mp3'), 'calm');
  assert.equal(moodFromPath('yt_music/Classical-Calm/Some Piece - Someone.mp3'), 'calm');
});

test('moodFromPath returns null outside a recognized mood folder', () => {
  assert.equal(moodFromPath('yt_music/Uncategorized/Track - Artist.mp3'), null);
});

test('relaxedQueryVariants broadens most-specific-first by trimming trailing words', () => {
  assert.deepEqual(relaxedQueryVariants('giant cave spider hunting prey'), [
    'giant cave spider hunting prey',
    'giant cave spider hunting',
    'giant cave spider',
    'giant cave',
  ]);
});

test('relaxedQueryVariants keeps the leading subject (never broadens below the floor)', () => {
  // The subject noun leads every anchored beat query, so the last variant still
  // names the subject rather than collapsing to a single generic word.
  const out = relaxedQueryVariants('anglerfish bioluminescent lure glowing deep sea');
  assert.equal(out[0], 'anglerfish bioluminescent lure glowing deep sea');
  assert.equal(out[out.length - 1], 'anglerfish bioluminescent');
  assert.ok(out.every((v) => v.startsWith('anglerfish')));
});

test('relaxedQueryVariants leaves short queries untouched', () => {
  assert.deepEqual(relaxedQueryVariants('cave spider'), ['cave spider']);
  assert.deepEqual(relaxedQueryVariants('spider'), ['spider']);
});

test('relaxedQueryVariants normalizes whitespace and handles empties', () => {
  assert.deepEqual(relaxedQueryVariants('  deep   sea   anglerfish '), [
    'deep sea anglerfish',
    'deep sea',
  ]);
  assert.deepEqual(relaxedQueryVariants('   '), []);
  assert.deepEqual(relaxedQueryVariants(''), []);
});

test('stripHtml unwraps a Commons Artist blob to a clean credit', () => {
  assert.equal(stripHtml('<a href="//x">Jane&nbsp;Doe</a>'), 'Jane Doe');
  assert.equal(stripHtml('<span>Smith &amp; Sons</span>'), 'Smith & Sons');
  assert.equal(stripHtml("O&#39;Brien"), "O'Brien");
  assert.equal(stripHtml('   plain   text  '), 'plain text');
});

test('isPermissiveLicense accepts CC0/PD/plain CC BY and rejects SA/NC/ND/copyleft', () => {
  for (const ok of ['CC0', 'Public domain', 'CC BY 4.0', 'CC BY 2.5', 'PDM 1.0']) {
    assert.ok(isPermissiveLicense(ok), `should accept ${ok}`);
  }
  for (const bad of ['CC BY-SA 4.0', 'CC BY-NC 3.0', 'CC BY-ND 4.0', 'GFDL', 'FAL', '']) {
    assert.equal(isPermissiveLicense(bad), false, `should reject ${bad}`);
  }
});

test('parseCommonsResults keeps landscape JPEG/PNG photos with a permissive CC credit', () => {
  const resp = {
    query: {
      pages: {
        '1': {
          title: 'File:Red-billed chough in flight.jpg',
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/chough.jpg',
              descriptionurl: 'https://commons.wikimedia.org/wiki/File:chough',
              mime: 'image/jpeg',
              width: 4000,
              height: 3000,
              extmetadata: {
                Artist: { value: '<a href="//x">Jane Doe</a>' },
                LicenseShortName: { value: 'CC BY 4.0' },
              },
            },
          ],
        },
      },
    },
  };
  const out = parseCommonsResults(resp, 600);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.url, 'https://upload.wikimedia.org/chough.jpg');
  assert.deepEqual(out[0]!.credit, {
    title: 'Red-billed chough in flight',
    author: 'Jane Doe',
    license: 'CC BY 4.0',
    url: 'https://commons.wikimedia.org/wiki/File:chough',
  });
});

test('parseCommonsResults drops share-alike / non-permissive licenses', () => {
  const resp = {
    query: {
      pages: {
        '1': {
          title: 'File:rare bird.jpg',
          imageinfo: [
            {
              url: 'u',
              mime: 'image/jpeg',
              width: 4000,
              height: 3000,
              extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
            },
          ],
        },
      },
    },
  };
  assert.deepEqual(parseCommonsResults(resp, 600), []);
});

test('parseCommonsResults drops portraits, small images, and non-raster files', () => {
  const resp = {
    query: {
      pages: {
        portrait: {
          title: 'File:tall.jpg',
          imageinfo: [{ url: 'u1', mime: 'image/jpeg', width: 800, height: 1200 }],
        },
        tiny: {
          title: 'File:tiny.jpg',
          imageinfo: [{ url: 'u2', mime: 'image/jpeg', width: 500, height: 300 }],
        },
        svg: {
          title: 'File:diagram.svg',
          imageinfo: [{ url: 'u3', mime: 'image/svg+xml', width: 4000, height: 3000 }],
        },
      },
    },
  };
  assert.deepEqual(parseCommonsResults(resp, 600), []);
});

test('parseCommonsResults keeps a permissive image even when the author is missing', () => {
  const resp = {
    query: {
      pages: {
        '1': {
          title: 'File:moth.png',
          imageinfo: [
            {
              url: 'u',
              mime: 'image/png',
              width: 1920,
              height: 1080,
              extmetadata: { LicenseShortName: { value: 'CC0' } },
            },
          ],
        },
      },
    },
  };
  const out = parseCommonsResults(resp, 600);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.credit.author, 'Unknown author');
  assert.equal(out[0]!.credit.license, 'CC0');
  assert.equal(out[0]!.credit.url, '');
});

test('parseCommonsResults drops an image whose license cannot be confirmed', () => {
  const resp = {
    query: {
      pages: {
        '1': {
          title: 'File:moth.png',
          imageinfo: [{ url: 'u', mime: 'image/png', width: 1920, height: 1080 }],
        },
      },
    },
  };
  assert.deepEqual(parseCommonsResults(resp, 600), []);
});

test('parseCommonsResults handles an empty/error response', () => {
  assert.deepEqual(parseCommonsResults({}, 600), []);
  assert.deepEqual(parseCommonsResults({ query: { pages: {} } }, 600), []);
});

// --- pickBestVideoFile -----------------------------------------------------------

const mp4 = (width: number, height: number) => ({
  link: `f_${width}x${height}`,
  width,
  height,
  file_type: 'video/mp4',
});

test('pickBestVideoFile takes the smallest landscape rendition at or above 1080', () => {
  // 2160 would waste download time; 1080 matches the render output exactly.
  const file = pickBestVideoFile([mp4(3840, 2160), mp4(1920, 1080), mp4(1280, 720)]);
  assert.equal(file?.height, 1080);
});

test('pickBestVideoFile never selects a portrait rendition on a landscape search', () => {
  // The pre-fix condition (height >= width) picked exactly these portrait
  // files first, so the 720p fallback always won on real Pexels responses.
  const file = pickBestVideoFile([mp4(1080, 1920), mp4(1920, 1080)]);
  assert.equal(file?.link, 'f_1920x1080');
});

test('pickBestVideoFile falls back to the largest landscape file above 720 when nothing reaches 1080', () => {
  const file = pickBestVideoFile([mp4(1280, 720), mp4(1706, 960)]);
  assert.equal(file?.height, 960);
});

test('pickBestVideoFile keeps a landscape clip even below 720 (largest rendition)', () => {
  // Resolution never excludes a relevant landscape clip; the pool ordering
  // demotes it instead (orderPoolByPreference).
  const file = pickBestVideoFile([mp4(640, 360), mp4(854, 480)]);
  assert.equal(file?.height, 480);
});

test('pickBestVideoFile returns null when nothing fits (wrong container or orientation)', () => {
  assert.equal(
    pickBestVideoFile([{ link: 'h', width: 1920, height: 1080, file_type: 'video/hls' }]),
    null,
  );
  assert.equal(pickBestVideoFile([]), null);
});

test('pickBestVideoFile portrait mode wants tall files, 1920 first then 1280 fallback', () => {
  const full = pickBestVideoFile([mp4(2160, 3840), mp4(1080, 1920), mp4(1920, 1080)], 'portrait');
  assert.equal(full?.link, 'f_1080x1920');
  const fallback = pickBestVideoFile([mp4(720, 1280), mp4(1920, 1080)], 'portrait');
  assert.equal(fallback?.link, 'f_720x1280');
  assert.equal(pickBestVideoFile([mp4(1920, 1080)], 'portrait'), null);
});

test('pickBestVideoFile portrait keeps the 1280 hard floor (cropped landscape is sharper)', () => {
  assert.equal(pickBestVideoFile([mp4(540, 960)], 'portrait'), null);
});

// --- orderPoolByPreference -------------------------------------------------------

test('orderPoolByPreference demotes short and low-res clips without dropping them', () => {
  const c = (url: string, extra: { duration?: number; height?: number } = {}) => ({
    url,
    source: 'Pexels',
    ...extra,
  });
  const pool = orderPoolByPreference([
    c('short', { duration: 3 }),
    c('good-hd', { duration: 12, height: 1080 }),
    c('low-res', { duration: 12, height: 480 }),
    c('unknown'),
  ]);
  // Relevance order survives within each tier; weak clips go last, never away.
  assert.deepEqual(pool.map((x) => x.url), ['good-hd', 'unknown', 'short', 'low-res']);
});

// --- interleaveRoundRobin --------------------------------------------------------

test('interleaveRoundRobin alternates providers while preserving each ranking', () => {
  assert.deepEqual(
    interleaveRoundRobin([
      ['a1', 'a2', 'a3'],
      ['b1'],
      ['c1', 'c2'],
    ]),
    ['a1', 'b1', 'c1', 'a2', 'c2', 'a3'],
  );
});

test('interleaveRoundRobin handles empty groups and empty input', () => {
  assert.deepEqual(interleaveRoundRobin([[], ['x'], []]), ['x']);
  assert.deepEqual(interleaveRoundRobin([]), []);
});

// --- filterAndRankByRelevance ----------------------------------------------------

const cand = (url: string, meta?: string) => ({ url, source: 'Pexels', meta });

test('filterAndRankByRelevance drops candidates whose metadata shares nothing with the query', () => {
  const out = filterAndRankByRelevance(
    [cand('beach', 'ocean waves sunset beach'), cand('cat', 'cat drinking water')],
    'cat lapping water slow motion',
  );
  assert.deepEqual(out.map((c) => c.url), ['cat']);
});

test('filterAndRankByRelevance keeps candidates without metadata (no evidence either way)', () => {
  const out = filterAndRankByRelevance(
    [cand('unknown'), cand('beach', 'ocean waves sunset')],
    'cat lapping water',
  );
  assert.deepEqual(out.map((c) => c.url), ['unknown']);
});

test('filterAndRankByRelevance drops metadata clips that do NOT name the subject, even on a shared scene word', () => {
  // 'water-only' shares the incidental scene word "water" with the query but
  // never names the subject "cat" → proven off-subject → dropped (the old
  // behavior demoted-but-kept it, letting it become a beat's 2nd distinct shot).
  // 'no-meta' has nothing to judge on → kept, behind any proven subject match.
  const out = filterAndRankByRelevance(
    [
      cand('water-only', 'water droplets macro'),
      cand('no-meta'),
      cand('subject', 'tabby cat closeup'),
    ],
    'cat lapping water',
  );
  assert.deepEqual(out.map((c) => c.url), ['subject', 'no-meta']);
});

test('filterAndRankByRelevance drops an off-subject clip sharing only a scene word with a bee query', () => {
  // The exact field defect: a bee episode where a "seagull ... flower field"
  // clip survived on the shared word "flower". It must now be dropped.
  const out = filterAndRankByRelevance(
    [
      cand('seagull', 'seagull flying over a flower field'),
      cand('bee', 'honeybee on a flower'),
    ],
    'honeybee gathering nectar on a flower',
  );
  assert.deepEqual(out.map((c) => c.url), ['bee']);
});

test('filterAndRankByRelevance keeps a closed-compound subject match (bee ⊂ honeybee)', () => {
  const out = filterAndRankByRelevance(
    [cand('comb', 'bee on honeycomb')],
    'honeybee worker on the comb',
  );
  assert.deepEqual(out.map((c) => c.url), ['comb']);
});

test('filterAndRankByRelevance ranks higher full-query overlap first among subject matches', () => {
  const out = filterAndRankByRelevance(
    [
      cand('low', 'honeybee'),
      cand('high', 'honeybee gathering nectar flower'),
    ],
    'honeybee gathering nectar on a flower',
  );
  assert.deepEqual(out.map((c) => c.url), ['high', 'low']);
});

test('filterAndRankByRelevance folds simple plurals so "cats" matches "cat"', () => {
  const out = filterAndRankByRelevance([cand('cats', 'cats playing garden')], 'cat lapping water');
  assert.deepEqual(out.map((c) => c.url), ['cats']);
});

test('filterAndRankByRelevance passes everything through when the query has no usable tokens', () => {
  const all = [cand('a', 'zebra'), cand('b')];
  assert.deepEqual(filterAndRankByRelevance(all, 'of in'), all);
});

test('filterAndRankByRelevance matches the subject HEAD noun, not a leading modifier', () => {
  // subject "sea otter": a generic "sea waves" clip shares the modifier "sea"
  // but never names the creature "otter" → dropped. (Keying off queryTokens[0]
  // would have kept it on "sea".)
  const out = filterAndRankByRelevance(
    [
      cand('waves', 'ocean sea waves crashing'),
      cand('otter', 'sea otter floating on its back'),
    ],
    'sea otter swimming in kelp',
    'sea otter',
  );
  assert.deepEqual(out.map((c) => c.url), ['otter']);
});

test('filterAndRankByRelevance Shorts path: subject is load-bearing for a multi-word subject', () => {
  // The honey-bee episode class that motivated the fix. anchorVisual prepends the
  // FULL subject "honey bee" when the model's visual omits the head, so the
  // anchored beat query leads with the MODIFIER "honey", not "bee". A portrait
  // clip slugged by the creature ("bee gathering pollen") must survive.
  const candidates = [
    cand('gull', 'seagull soaring over the shore'),
    cand('bee', 'bee gathering pollen on a flower'),
  ];
  const query = 'honey bee landing on a flower';
  // WITHOUT subject (the fetchShortsBroll bug): head falls back to "honey", so the
  // real bee clip is wrongly dropped as off-subject.
  assert.deepEqual(
    filterAndRankByRelevance(candidates, query).map((c) => c.url),
    [],
  );
  // WITH subject threaded (fetchShortsBroll now passes episode.subject): head is
  // "bee", the creature clip is kept and the seagull still dropped.
  assert.deepEqual(
    filterAndRankByRelevance(candidates, query, 'honey bee').map((c) => c.url),
    ['bee'],
  );
});

test('filterAndRankByRelevance drops words that merely END in a short subject token', () => {
  // "plant"/"elephant" must NOT pass as "ant" — the field-failure class the crude
  // endsWith fold re-admitted. Only the real "ant" clip survives.
  const out = filterAndRankByRelevance(
    [
      cand('plant', 'green plant leaves macro'),
      cand('eleph', 'elephant walking in savanna'),
      cand('ant', 'ant carrying a leaf'),
    ],
    'ant colony foraging trail',
  );
  assert.deepEqual(out.map((c) => c.url), ['ant']);
});

// --- isClipOnSubject ------------------------------------------------------------

test('isClipOnSubject matches known closed compounds in both directions', () => {
  assert.equal(isClipOnSubject('bee on comb', 'honeybee'), true); // head honeybee → bee
  assert.equal(isClipOnSubject('honeybee macro', 'bee'), true); // clip honeybee → head bee
  assert.equal(isClipOnSubject('a fly on a leaf', 'dragonfly'), true);
  assert.equal(isClipOnSubject('jellyfish drifting', 'fish'), true);
});

test('isClipOnSubject is false when metadata names none of the subject tokens', () => {
  assert.equal(isClipOnSubject('seagull flying', 'honeybee'), false);
});

test('isClipOnSubject rejects unrelated words that merely END in a short subject token', () => {
  // The crude endsWith fold admitted all of these (overlap 0, wrong footage).
  // A closed compound must be in COMPOUND_HEAD, not any word sharing a suffix.
  assert.equal(isClipOnSubject('scenic mountain landscape', 'ape'), false); // landscape⊅ape
  assert.equal(isClipOnSubject('green plant leaves', 'ant'), false); // plant⊅ant
  assert.equal(isClipOnSubject('elephant in savanna', 'ant'), false); // elephant⊅ant
  assert.equal(isClipOnSubject('a flock of fowl', 'owl'), false); // fowl⊅owl
  assert.equal(isClipOnSubject('ocean water spray', 'ray'), false); // spray⊅ray
  assert.equal(isClipOnSubject('beetle on a leaf', 'bee'), false); // beetle⊅bee
});

test('isClipOnSubject returns undefined when there is nothing to judge on', () => {
  assert.equal(isClipOnSubject(undefined, 'bee'), undefined);
  assert.equal(isClipOnSubject('bee on a flower', undefined), undefined);
  assert.equal(isClipOnSubject('bee', 'of'), undefined); // subject has no usable token
});

// --- pexelsSlugText --------------------------------------------------------------

test('pexelsSlugText extracts the descriptive words from a Pexels page URL', () => {
  assert.equal(
    pexelsSlugText('https://www.pexels.com/video/a-cat-drinking-water-855282/'),
    'a cat drinking water',
  );
  assert.equal(pexelsSlugText('https://www.pexels.com/video/bee-on-flower-99/'), 'bee on flower');
});

test('pexelsSlugText returns undefined when there is no usable slug', () => {
  assert.equal(pexelsSlugText(undefined), undefined);
  assert.equal(pexelsSlugText('https://www.pexels.com/'), undefined);
});

test('pexelsSlugText treats untitled (numeric-only) page URLs as no metadata', () => {
  // Dropping these as "zero overlap" would systematically discard relevant
  // untitled Pexels clips — the relevance filter must see them as evidence-free.
  assert.equal(pexelsSlugText('https://www.pexels.com/video/3045163/'), undefined);
});

// --- pixabayCategoryForSeries ----------------------------------------------------

test('pixabayCategoryForSeries maps all three series; insects share animals', () => {
  assert.equal(pixabayCategoryForSeries('animals'), 'animals');
  assert.equal(pixabayCategoryForSeries('insects'), 'animals');
  assert.equal(pixabayCategoryForSeries('plants'), 'nature');
  assert.equal(pixabayCategoryForSeries('space'), undefined);
});
