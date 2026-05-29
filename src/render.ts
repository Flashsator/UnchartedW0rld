import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { ROOT } from './config.js';
import type { RenderManifest, ShortsManifest } from './types.js';
import { ensureDir, log } from './utils.js';

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

  log(`Rendering ${composition.durationInFrames} frames @ ${composition.fps}fps...`);

  await renderMedia({
    serveUrl,
    composition,
    codec: 'h264',
    outputLocation: outPath,
    inputProps: { manifest },
    concurrency: null,
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
    concurrency: null,
    chromiumOptions: { gl: 'angle' },
    imageFormat: 'jpeg',
    jpegQuality: 88,
  });

  log(`Shorts render complete: ${outPath}`);
  return outPath;
}
