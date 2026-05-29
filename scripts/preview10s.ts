import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { ROOT } from '../src/config.js';
import type { RenderManifest } from '../src/types.js';

async function main(): Promise<void> {
  const runDir = path.join(ROOT, 'work', '2026-05-28_ocean');
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest at ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RenderManifest;
  const outPath = path.join(ROOT, 'out', 'preview10s.mp4');

  console.log('Bundling Remotion project...');
  const serveUrl = await bundle({
    entryPoint: path.join(ROOT, 'remotion', 'index.ts'),
    publicDir: runDir,
    webpackOverride: (c) => c,
  });

  const composition = await selectComposition({
    serveUrl,
    id: 'MainVideo',
    inputProps: { manifest },
  });

  console.log(`Rendering 300 frames (10s)...`);
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
    frameRange: [0, 299],
  });

  console.log(`Done: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
