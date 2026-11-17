# Transcript Guide

In this pipeline, transcription is performed by the system — the transcript arrives as an input file (or data block) alongside the audio; you cannot run `transcribe` or call external APIs yourself. This file covers what to do with that transcript when authoring captions: input formats, mandatory quality checks, cleaning code.

## Supported Input Formats

The CLI auto-detects and normalizes these formats:

| Format                | Extension | Source                                                                      | Word-level?       |
| --------------------- | --------- | --------------------------------------------------------------------------- | ----------------- |
| whisper.cpp JSON      | `.json`   | `hyperframes init --video`, `hyperframes transcribe`                        | Yes               |
| OpenAI Whisper API    | `.json`   | `openai.audio.transcriptions.create({ timestamp_granularities: ["word"] })` | Yes               |
| SRT subtitles         | `.srt`    | Video editors, subtitle tools, YouTube                                      | No (phrase-level) |
| VTT subtitles         | `.vtt`    | Web players, YouTube, transcription services                                | No (phrase-level) |
| Normalized word array | `.json`   | Pre-processed by any tool                                                   | Yes               |

**Word-level timestamps produce better captions.** SRT/VTT give phrase-level timing, which works but can't do per-word animation effects.

## Transcript Quality Check (Mandatory)

After every transcription, **read the transcript and check for quality issues before proceeding.** Bad transcripts produce nonsensical captions. Never skip this step.

### What to look for

| Signal                       | Example                                | Cause                                                                        |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| Music note tokens (`♪`, `�`) | `{ "text": "♪" }` or `{ "text": "�" }` | Whisper detected music, not speech                                           |
| Garbled / nonsense words     | "Do a chin", "Get so gay", "huh"       | Model misheard lyrics or background noise                                    |
| Long gaps with no words      | 20+ seconds of only `♪` tokens         | Instrumental section — expected, but high ratio means speech is being missed |
| Repeated filler              | Many "huh", "uh", "oh" entries         | Model is hallucinating on music                                              |
| Very short word spans        | Words with `end - start < 0.05`        | Unreliable timestamp alignment                                               |

### If the transcript fails the quality check

**If more than 20% of entries are `♪`/`�` tokens, or the transcript contains obvious nonsense words, the transcription failed.** Do not build captions from the bad entries. You cannot re-run transcription in this environment, so:

1. **Clean aggressively** — filter out `♪`/`�` tokens, garbled fragments, and entries where `text` is a single non-word character (see below). Only real words should reach the caption composition.
2. **If too little survives cleaning** to caption meaningfully, skip word-level caption effects for the affected span (or omit captions for it) rather than rendering nonsense on screen, and note the transcript quality problem in your final output.

### Cleaning a transcript

After transcription (even with a good model), strip non-word entries:

```js
var raw = JSON.parse(transcriptJson);
var words = raw.filter(function (w) {
  if (!w.text || w.text.trim().length === 0) return false;
  if (/^[♪�\u266a\u266b\u266c\u266d\u266e\u266f]+$/.test(w.text)) return false;
  if (/^(huh|uh|um|ah|oh)$/i.test(w.text) && w.end - w.start < 0.1) return false;
  return true;
});
```

## If No Transcript Exists

1. Check the project root for `transcript.json`, `.srt`, or `.vtt` files.
2. If none exists, you cannot generate one in this environment — transcription (and any external API use) happens outside this pipeline. Do not invent word timings. Either build captions only where timing data exists, or note in your final output that no transcript was provided for the audio.
3. When a transcript IS present, **read it and run the quality check** (see above) before building captions.
