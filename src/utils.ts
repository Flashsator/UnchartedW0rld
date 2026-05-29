import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function log(...args: unknown[]): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Retries a flaky async op with exponential backoff + jitter. Used to harden the
// unattended daily pipeline against transient network/HTTP-5xx failures, which
// would otherwise kill the whole run on a single hiccup.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 600;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * 2 ** i + Math.floor(Math.random() * 250);
      log(`Retry ${i + 1}/${attempts - 1}${opts.label ? ` (${opts.label})` : ''} after error: ${(e as Error).message} — waiting ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${url}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    },
    { label: `fetchJson ${url.split('?')[0]}` },
  );
}

export async function downloadFile(url: string, dest: string): Promise<string> {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Download failed ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      return dest;
    },
    { label: `download ${dest}` },
  );
}

export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

export function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
  });
}

export async function ffprobeDuration(file: string): Promise<number> {
  const out = await runCapture('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  return Number(out);
}

export function pickRandom<T>(items: T[]): T {
  if (items.length === 0) throw new Error('pickRandom on empty array');
  return items[Math.floor(Math.random() * items.length)]!;
}

export function shuffle<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export function safeFilename(s: string): string {
  const m = s.match(/^(.*?)(\.[a-zA-Z0-9]{1,5})?$/);
  const base = (m?.[1] ?? s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  const ext = (m?.[2] ?? '').replace(/[^a-zA-Z0-9.]+/g, '');
  return base + ext;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
