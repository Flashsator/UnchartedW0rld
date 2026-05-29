import fs from 'node:fs';
import { chromium } from 'playwright';

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  const audioUrls = new Set<string>();
  const allRequests: string[] = [];
  page.on('response', (res) => {
    const url = res.url();
    allRequests.push(`${res.status()} ${url}`);
    if (/\.mp3/i.test(url) || /cdn\.pixabay\.com\/(audio|download)/i.test(url)) {
      audioUrls.add(url);
    }
  });

  const target = 'https://pixabay.com/music/main-title-inspiring-cinematic-music-409347/';
  console.log('Navigating to detail page:', target);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // Sweep audio/source elements
  const liveUrls = await page.$$eval('audio, source', (els) =>
    els.map((el) => (el as HTMLAudioElement | HTMLSourceElement).src).filter(Boolean),
  );
  console.log('audio/source src:', liveUrls);

  // Try clicking play
  try {
    const playSelectors = [
      'button[aria-label*="lay" i]',
      'button[aria-label*="Play" i]',
      'button.play',
      '[role="button"][aria-label*="lay" i]',
      'svg.play',
      'button:has-text("Play")',
    ];
    for (const sel of playSelectors) {
      const loc = page.locator(sel).first();
      const n = await loc.count();
      if (n > 0) {
        console.log(`Selector "${sel}" found ${n} — clicking`);
        await loc.click({ timeout: 4000 }).catch((e) => console.log('  click err:', e.message));
        await page.waitForTimeout(2500);
        break;
      }
    }
  } catch (e) {
    console.log('click block:', (e as Error).message);
  }

  // Snapshot HTML
  const html = await page.content();
  fs.writeFileSync('work/pixabay_detail.html', html);
  fs.writeFileSync('work/pixabay_detail_requests.txt', allRequests.join('\n'));

  console.log('\nCaptured audio URLs:', audioUrls.size);
  for (const u of audioUrls) console.log('  ', u);

  // Search the page HTML for MP3 patterns
  const mp3InHtml = html.match(/https?:\/\/cdn\.pixabay\.com\/[^"'\s)<>]+\.mp3/gi) ?? [];
  console.log('\nMP3 URLs in HTML:', mp3InHtml.length);
  for (const u of mp3InHtml.slice(0, 5)) console.log('  ', u);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
