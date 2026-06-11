import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateClipsAcrossBeats,
  filterAndRankByRelevance,
  interleaveRoundRobin,
  isPermissiveLicense,
  orderPoolByPreference,
  pexelsSlugText,
  pickBestVideoFile,
  pixabayCategoryForSeries,
  preferredMoods,
  moodFromPath,
  parseCommonsResults,
  relaxedQueryVariants,
  stripHtml,
} from '../src/stock.js';

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

test('filterAndRankByRelevance floats subject (leading token) matches to the front', () => {
  const out = filterAndRankByRelevance(
    [
      cand('water-only', 'water droplets macro'),
      cand('no-meta'),
      cand('subject', 'tabby cat closeup'),
    ],
    'cat lapping water',
  );
  assert.equal(out[0]!.url, 'subject');
  // Non-subject keepers retain their original relative order behind it.
  assert.deepEqual(out.map((c) => c.url), ['subject', 'water-only', 'no-meta']);
});

test('filterAndRankByRelevance folds simple plurals so "cats" matches "cat"', () => {
  const out = filterAndRankByRelevance([cand('cats', 'cats playing garden')], 'cat lapping water');
  assert.deepEqual(out.map((c) => c.url), ['cats']);
});

test('filterAndRankByRelevance passes everything through when the query has no usable tokens', () => {
  const all = [cand('a', 'zebra'), cand('b')];
  assert.deepEqual(filterAndRankByRelevance(all, 'of in'), all);
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
