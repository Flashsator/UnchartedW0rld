import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { ROOT } from './config.js';
import type { RenderManifest, ShortsManifest } from './types.js';
import { ensureDir, log } from './utils.js';

// Remotion's default (concurrency: null) uses ~half the available cores. On a
// 2-vCPU CI runner that means 1 worker — the single biggest reason a long video
// render crawls. Use every core instead. Override with REMOTION_CONCURRENCY.
const RENDER_CONCURRENCY = (() => {
  const envVal = Number(process.env.REMOTION_CONCURRENCY);
  if (Number.isInteger(envVal) && envVal > 0) return envVal;
  return Math.max(1, os.cpus().length);
})();

export async function renderVideo(
  manifest: RenderManifest,
  outPath: string,
  publicDir: string,
): Promise<string> {
  ensureDir(path.dirname(outPath));

  log('Bundling Remotion project...');
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'remotion', 'index.ts'),
    publicDir,
    webpackOverride: (c) => c,
  });

  const composition = await selectComposition({
    serveUrl,
    id: 'MainVideo',
    inputProps: { manifest },
  });

  log(
    `Rendering ${composition.durationInFrames} frames @ ${composition.fps}fps (concurrency=${RENDER_CONCURRENCY})...`,
  );

  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: { manifest },
    concurrency: RENDER_CONCURRENCY,
    chromiumOptions: { gl: 'angle' },
    imageFormat: 'jpeg',
    jpegQuality: 88,
  });

  log(`Render complete: ${outPath}`);
  return outPath;
}

export async function renderShorts(
  manifest: ShortsManifest,
  outPath: string,
  publicDir: string,
): Promise<string> {
  ensureDir(path.dirname(outPath));

  log('Bundling Remotion project (shorts)...');
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'remotion', 'index.ts'),
    publicDir,
    webpackOverride: (c) => c,
  });

  const composition = await selectComposition({
    serveUrl,
    id: 'ShortsVideo',
    inputProps: { manifest },
  });

  log(`Rendering shorts ${composition.durationInFrames} frames @ ${composition.fps}fps...`);

  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: { manifest },
    concurrency: RENDER_CONCURRENCY,
    chromiumOptions: { gl: 'angle' },
    imageFormat: 'jpeg',
    jpegQuality: 88,
  });

  log(`Shorts render complete: ${outPath}`);
  return outPath;
}
