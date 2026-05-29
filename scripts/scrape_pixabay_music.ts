/**
 * Pixabay music scraper (Playwright).
 *
 * Pixabay sits behind Cloudflare which blocks plain HTTP clients at the TLS
 * fingerprint level, and the MP3 URL is not present in the search results
 * page — only thumbnails are. We therefore use real Chromium via Playwright
 * and a two-stage flow:
 *   1. Visit /music/search/<tag>/, collect /music/<slug>-<id> detail-page
 *      links from the rendered HTML.
 *   2. Visit each detail page; the MP3 URL is present in the static HTML as
 *      `cdn.pixabay.com/download/audio/.../audio_<hash>.mp3?filename=...`.
 * The download is then made through the same BrowserContext so Cloudflare
 * cookies stay attached.
 *
 * Usage:
 *   tsx scripts/scrape_pixabay_music.ts            # default tag set
 *   tsx scripts/scrape_pixabay_music.ts cinematic ambient
 *   PIXABAY_PER_TAG=4 tsx scripts/scrape_pixabay_music.ts
 *   PIXABAY_HEADFUL=1 tsx scripts/scrape_pixabay_music.ts cinematic
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { ASSETS_DIR } from '../src/config.js';
import { ensureDir, log, safeFilename, sleep } from '../src/utils.js';

const MUSIC_FALLBACK_DIR = path.join(ASSETS_DIR, 'music_fallback');

const DEFAULT_TAGS = [
  'cinematic',
  'ambient',
  'mysterious',
  'epic',
  'documentary',
  'dark',
  'suspense',
  'space',
  'underwater',
  'nature',
];

const DETAIL_RE = /\/music\/([a-z0-9-]+-\d+)\/?/gi;
const MP3_RE = /https?:\/\/cdn\.pixabay\.com\/download\/audio\/[^"'\s<>)]+\.mp3(?:\?[^"'\s<>)]*)?/i;

type Track = { id: string; detailPath: string; mp3Url: string };

function idFromSlug(slug: string): string {
  const m = slug.match(/(\d+)$/);
  return m ? m[1]! : slug;
}

async function collectDetailLinks(page: Page, tag: string, want: number): Promise<string[]> {
  const seen = new Set<string>();
  for (let pageNum = 1; pageNum <= 3 && seen.size < want * 2; pageNum++) {
    const url =
      pageNum === 1
        ? `https://pixabay.com/music/search/${encodeURIComponent(tag)}/`
        : `https://pixabay.com/music/search/${encodeURIComponent(tag)}/?pagi=${pageNum}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      // Trigger lazy hydration.
      for (let s = 0; s < 3; s++) {
        await page.mouse.wheel(0, 1500);
        await sleep(400);
      }
      const html = await page.content();
      let m: RegExpExecArray | null;
      DETAIL_RE.lastIndex = 0;
      while ((m = DETAIL_RE.exec(html)) !== null) {
        seen.add(m[1]!);
      }
    } catch (e) {
      log(`  search page ${pageNum} failed: ${(e as Error).message}`);
    }
    await sleep(500 + Math.random() * 400);
  }
  return Array.from(seen).slice(0, want * 2);
}

async function resolveMp3(page: Page, slug: string): Promise<string | null> {
  const url = `https://pixabay.com/music/${slug}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const html = await page.content();
    const m = html.match(MP3_RE);
    return m ? m[0] : null;
  } catch (e) {
    log(`  detail "${slug}" failed: ${(e as Error).message}`);
    return null;
  }
}

async function scrapeTag(
  context: BrowserContext,
  tag: string,
  perTag: number,
): Promise<Track[]> {
  const searchPage = await context.newPage();
  let links: string[] = [];
  try {
    links = await collectDetailLinks(searchPage, tag, perTag);
  } finally {
    await searchPage.close();
  }
  log(`  search yielded ${links.length} detail link(s)`);

  const detailPage = await context.newPage();
  const tracks: Track[] = [];
  try {
    for (const slug of links) {
      if (tracks.length >= perTag) break;
      const id = idFromSlug(slug);
      const mp3Url = await resolveMp3(detailPage, slug);
      if (mp3Url) {
        tracks.push({ id, detailPath: `/music/${slug}/`, mp3Url });
        log(`  resolved ${id} → ${mp3Url.split('?')[0]}`);
      }
      await sleep(400 + Math.random() * 500);
    }
  } finally {
    await detailPage.close();
  }
  return tracks;
}

async function downloadViaContext(
  context: BrowserContext,
  url: string,
  dest: string,
): Promise<void> {
  const res = await context.request.get(url, { timeout: 60000 });
  if (!res.ok()) {
    throw new Error(`HTTP ${res.status()} ${url}`);
  }
  const body = await res.body();
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, body);
}

async function main(): Promise<void> {
  const cliTags = process.argv.slice(2).filter(Boolean);
  const tags = cliTags.length > 0 ? cliTags : DEFAULT_TAGS;
  const perTag = Number(process.env.PIXABAY_PER_TAG ?? '5');
  const headless = process.env.PIXABAY_HEADFUL !== '1';

  ensureDir(MUSIC_FALLBACK_DIR);
  log(`Pixabay music scrape: ${tags.length} tag(s) × ${perTag} track(s) — headless=${headless}`);

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
  });

  let total = 0;
  try {
    for (const tag of tags) {
      const tagDir = ensureDir(path.join(MUSIC_FALLBACK_DIR, safeFilename(tag)));
      const existing = new Set(fs.readdirSync(tagDir));
      log(`Tag "${tag}": scraping...`);
      const tracks = await scrapeTag(context, tag, perTag);
      log(`Tag "${tag}": resolved ${tracks.length} track(s)`);
      for (const t of tracks) {
        const name = safeFilename(`${tag}_${t.id}.mp3`);
        if (existing.has(name)) {
          log(`  skip (cached): ${name}`);
          continue;
        }
        const dest = path.join(tagDir, name);
        try {
          await downloadViaContext(context, t.mp3Url, dest);
          const size = fs.statSync(dest).size;
          if (size < 16 * 1024) {
            fs.unlinkSync(dest);
            log(`  rejected (too small ${size}B): ${name}`);
            continue;
          }
          log(`  saved: ${name} (${(size / 1024).toFixed(0)} KB)`);
          total += 1;
        } catch (e) {
          log(`  download failed: ${(e as Error).message}`);
        }
        await sleep(500 + Math.random() * 500);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  log(`Done. ${total} new track(s) saved to ${MUSIC_FALLBACK_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
