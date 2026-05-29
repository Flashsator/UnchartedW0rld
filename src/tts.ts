import fs from 'node:fs';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { TTS_RATE, TTS_VOICE_FALLBACK } from './config.js';
import type { Episode, SectionAudio, WordTiming } from './types.js';
import { ensureDir, ffprobeDuration, log } from './utils.js';

type RawBoundary = {
  Metadata?: Array<{
    Type?: string;
    Data?: { Offset?: number; Duration?: number; text?: { Text?: string } };
  }>;
};

export type Prosody = { rate?: string; pitch?: string };

async function synthOne(
  text: string,
  outPath: string,
  voice: string,
  prosody?: Prosody,
): Promise<{ audioPath: string; words: WordTiming[] }> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: true,
    sentenceBoundaryEnabled: true,
  });

  const streamOpts: { rate: string; pitch?: string } = {
    rate: prosody?.rate ?? TTS_RATE,
  };
  if (prosody?.pitch) streamOpts.pitch = prosody.pitch;
  const { audioStream, metadataStream } = await tts.toStream(text, streamOpts);

  const sentenceSpans: Array<{ start: number; end: number; text: string }> = [];
  const wordTimings: WordTiming[] = [];

  metadataStream?.on('data', (chunk: Buffer | string) => {
    try {
      const payload: RawBoundary = JSON.parse(
        typeof chunk === 'string' ? chunk : chunk.toString('utf-8'),
      );
      const meta = payload.Metadata ?? [];
      for (const m of meta) {
        const type = m.Type;
        const data = m.Data;
        if (!type || !data) continue;
        const start = (data.Offset ?? 0) / 1e7;
        const dur = (data.Duration ?? 0) / 1e7;
        const t = data.text?.Text ?? '';
        if (type === 'WordBoundary') {
          wordTimings.push({ start, end: start + dur, text: t });
        } else if (type === 'SentenceBoundary') {
          sentenceSpans.push({ start, end: start + dur, text: t });
        }
      }
    } catch {
      /* ignore non-JSON frames */
    }
  });

  ensureDir(path.dirname(outPath));
  const fileStream = fs.createWriteStream(outPath);

  await new Promise<void>((resolve, reject) => {
    audioStream.pipe(fileStream);
    audioStream.on('end', () => resolve());
    audioStream.on('error', reject);
    fileStream.on('error', reject);
  });

  const stat = fs.statSync(outPath);
  if (stat.size < 1024) {
    throw new Error(`TTS produced empty/tiny mp3 (${stat.size} bytes) — voice may be unavailable`);
  }

  if (wordTimings.length > 0) {
    return { audioPath: outPath, words: wordTimings };
  }

  // Sentence-boundary fallback
  if (sentenceSpans.length > 0) {
    const expanded: WordTiming[] = [];
    for (const span of sentenceSpans) {
      const tokens = span.text.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const per = (span.end - span.start) / tokens.length;
      tokens.forEach((tok, j) => {
        expanded.push({
          start: span.start + j * per,
          end: span.start + (j + 1) * per,
          text: tok,
        });
      });
    }
    return { audioPath: outPath, words: expanded };
  }

  return { audioPath: outPath, words: [] };
}

export async function synthesize(
  episode: Episode,
  workDir: string,
  voiceIds: string[],
  prosody?: Prosody,
): Promise<SectionAudio[]> {
  if (voiceIds.length === 0) throw new Error('synthesize: voiceIds must be non-empty');
  const audioDir = ensureDir(path.join(workDir, 'audio'));

  const results: SectionAudio[] = [];

  for (let i = 0; i < episode.sections.length; i++) {
    const sec = episode.sections[i]!;
    const outPath = path.join(audioDir, `section_${String(i).padStart(2, '0')}.mp3`);

    const primary = voiceIds[i % voiceIds.length]!;
    const tried = new Set<string>();
    const order: string[] = [];
    const push = (v: string): void => {
      if (!tried.has(v)) {
        tried.add(v);
        order.push(v);
      }
    };
    push(primary);
    for (const v of voiceIds) push(v);
    push(TTS_VOICE_FALLBACK);

    let synth: { audioPath: string; words: WordTiming[] } | null = null;
    let used = primary;
    let lastErr: unknown = null;
    for (const voice of order) {
      try {
        synth = await synthOne(sec.narration, outPath, voice, prosody);
        used = voice;
        break;
      } catch (e) {
        lastErr = e;
        log(`TTS voice ${voice} failed for section ${i}: ${(e as Error).message}`);
      }
    }
    if (!synth) throw new Error(`All TTS voices failed: ${String(lastErr)}`);

    const duration = await ffprobeDuration(synth.audioPath);

    let words = synth.words;
    if (words.length === 0) {
      const tokens = sec.narration.split(/\s+/).filter(Boolean);
      if (tokens.length > 0) {
        const per = duration / tokens.length;
        words = tokens.map((t, j) => ({
          start: j * per,
          end: (j + 1) * per,
          text: t,
        }));
        log(`Section ${i}: no boundaries — synthesized ${words.length} uniform timings`);
      }
    }

    results.push({
      index: i,
      narration: sec.narration,
      heading: sec.heading,
      visual: sec.visual,
      mp3Path: synth.audioPath,
      duration,
      words,
      voiceId: used,
    });

    log(
      `Section ${i} [${used}]: ${duration.toFixed(2)}s (${sec.narration.split(/\s+/).length} words, ${words.length} boundaries)`,
    );
  }

  const total = results.reduce((acc, r) => acc + r.duration, 0);
  log(`Total narration: ${total.toFixed(1)}s (${(total / 60).toFixed(1)} min)`);
  return results;
}
