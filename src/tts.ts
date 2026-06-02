import fs from 'node:fs';
import path from 'node:path';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import {
  AZURE_SPEECH_KEY,
  AZURE_SPEECH_REGION,
  TTS_RATE,
  TTS_VOICE_FALLBACK,
} from './config.js';
import type { Episode, SectionAudio, WordTiming } from './types.js';
import { ensureDir, ffprobeDuration, log } from './utils.js';

export type Prosody = { rate?: string; pitch?: string };

// Escape the five XML special characters so narration text is safe inside SSML.
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Derive the SSML locale from the voice id, e.g. "en-GB-RyanNeural" -> "en-GB".
function localeFromVoice(voice: string): string {
  const m = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  return m?.[1] ?? 'en-US';
}

function buildSsml(text: string, voice: string, prosody?: Prosody): string {
  const rate = prosody?.rate ?? TTS_RATE;
  const pitch = prosody?.pitch;
  const inner = escapeXml(text);
  const prosodyOpen = `<prosody rate="${rate}"${pitch ? ` pitch="${pitch}"` : ''}>`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${localeFromVoice(voice)}">` +
    `<voice name="${voice}">${prosodyOpen}${inner}</prosody></voice>` +
    `</speak>`
  );
}

// Synthesizes one narration block to an MP3 via the licensed Azure Speech API.
// Azure's wordBoundary event uses the same 100ns-tick offset convention as the
// old msedge metadata, so the WordTiming contract (and everything downstream:
// subtitles, cut times, overlays) is unchanged.
async function synthOne(
  text: string,
  outPath: string,
  voice: string,
  prosody?: Prosody,
): Promise<{ audioPath: string; words: WordTiming[] }> {
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    throw new Error('AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set for TTS');
  }

  ensureDir(path.dirname(outPath));

  const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

  const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outPath);
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

  const wordTimings: WordTiming[] = [];
  synthesizer.wordBoundary = (_s, e) => {
    // Only spoken words drive timings; punctuation boundaries are skipped so the
    // token stream lines up with the narration's words.
    if (e.boundaryType === sdk.SpeechSynthesisBoundaryType.Punctuation) return;
    const start = e.audioOffset / 1e7;
    const dur = (e.duration ?? 0) / 1e7;
    wordTimings.push({ start, end: start + dur, text: e.text });
  };

  const ssml = buildSsml(text, voice, prosody);

  try {
    await new Promise<void>((resolve, reject) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve();
          } else {
            reject(
              new Error(
                `Azure TTS did not complete (reason ${result.reason}): ${result.errorDetails ?? 'unknown'}`,
              ),
            );
          }
        },
        (err) => reject(new Error(String(err))),
      );
    });
  } finally {
    synthesizer.close();
  }

  const stat = fs.statSync(outPath);
  if (stat.size < 1024) {
    throw new Error(`TTS produced empty/tiny mp3 (${stat.size} bytes) — voice may be unavailable`);
  }

  // wordTimings may be empty if the service returned no boundaries; synthesize()
  // then falls back to uniform timings derived from the audio duration.
  return { audioPath: outPath, words: wordTimings };
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
