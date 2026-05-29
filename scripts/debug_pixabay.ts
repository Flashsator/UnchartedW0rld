import fs from 'node:fs';
import path from 'node:path';
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
    if (/\.mp3/i.test(url) || /audio/i.test(url)) {
      audioUrls.add(url);
    }
  });

  await page.goto('https://pixabay.com/music/search/cinematic/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const html = await page.content();
  fs.writeFileSync('work/pixabay_debug.html', html);
  fs.writeFileSync('work/pixabay_requests.txt', allRequests.join('\n'));

  // Look for any data structures with mp3 in script tags
  const scriptData = await page.$$eval('script', (scripts) =>
    scripts
      .map((s) => s.textContent ?? '')
      .filter((t) => t.length > 200 && (t.includes('mp3') || t.includes('audio')))
      .map((t) => t.slice(0, 5000)),
  );
  fs.writeFileSync('work/pixabay_scripts.txt', scriptData.join('\n---\n'));

  console.log('Audio URLs found:', audioUrls.size);
  for (const u of audioUrls) console.log('  ', u);

  // Look for music card elements
  const cards = await page.$$eval('[data-id], [data-audio-id]', (els) =>
    els.slice(0, 5).map((el) => ({
      tag: el.tagName,
      id: el.getAttribute('data-id') ?? el.getAttribute('data-audio-id'),
      cls: el.className,
    })),
  );
  console.log('Cards (data-id):', JSON.stringify(cards, null, 2));

  // Try clicking the first play button
  try {
    const playBtn = await page.locator('button[aria-label*="lay"]').first();
    if (await playBtn.count()) {
      console.log('Clicking first play button...');
      await playBtn.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } else {
      console.log('No play button found via aria-label');
    }
  } catch (e) {
    console.log('Play click failed:', (e as Error).message);
  }

  console.log('\nAudio URLs after click:', audioUrls.size);
  for (const u of audioUrls) console.log('  ', u);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
