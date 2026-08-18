/**
 * Groups word-level {word, start, end} timestamps (from Whisper) into
 * readable phrase-like chunks, similar to how a human would break a
 * transcript into subtitle lines: break on a natural pause, a sentence
 * ending, or once a chunk gets too long/long-running.
 *
 * Used both to build the transcript we hand to the clip picker,
 * and the per-clip "scene analysis" transcript shown in the UI.
 */
export function groupWordsIntoPhrases(
  words,
  { maxWords = 14, maxGapSec = 0.8, maxDurationSec = 10 } = {}
) {
  const phrases = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    phrases.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current
        .map((w) => w.word)
        .join(" ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .trim(),
    });
    current = [];
  };

  for (const w of words) {
    if (current.length) {
      const prev = current[current.length - 1];
      const gap = w.start - prev.end;
      const duration = w.end - current[0].start;
      if (gap > maxGapSec || current.length >= maxWords || duration > maxDurationSec) {
        flush();
      }
    }
    current.push(w);
    if (/[.!?]$/.test(w.word) && current.length >= 4) {
      flush();
    }
  }
  flush();

  return phrases;
}

function formatTimestamp(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Renders phrase segments as a compact, LLM-friendly timestamped transcript. */
export function phrasesToPromptText(phrases) {
  return phrases.map((p) => `[${formatTimestamp(p.start)}] ${p.text}`).join("\n");
}
