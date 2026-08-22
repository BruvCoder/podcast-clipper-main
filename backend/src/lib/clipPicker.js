import { groqPostWithRetry } from "./groqClient.js";

const MODEL = process.env.CLIP_PICKER_MODEL || "openai/gpt-oss-120b";
const TIMEOUT_MS = Number.parseInt(process.env.CLIP_PICKER_TIMEOUT_MS, 10) || 120_000;

const CLIP_PICK_SCHEMA = {
  type: "object",
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: {
            type: "number",
            description:
              "Clip start time in seconds. Must exactly match the start timestamp of a line in the transcript.",
          },
          end: {
            type: "number",
            description:
              "Clip end time in seconds. Must exactly match the end timestamp of a line in the transcript.",
          },
          title: { type: "string", description: "A short, punchy, clickable title for this clip (under 60 chars)." },
          hook: {
            type: "string",
            description:
              "The exact opening line or moment (quoted or closely paraphrased) that makes the first 2 seconds grab attention.",
          },
          viralityScore: {
            type: "number",
            description: "Predicted viral/engagement potential from 0-100, relative to the other clips chosen.",
          },
          reason: {
            type: "string",
            description:
              "One or two sentences on why this moment was chosen (hook, emotion, payoff, controversy, humor, insight, etc).",
          },
        },
        required: ["start", "end", "title", "hook", "viralityScore", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["clips"],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTION = `You are an expert short-form video producer for a channel that re-cuts clips out \
of long-form podcast interviews in the style of the biggest podcast-clip channels on TikTok/Reels/Shorts \
(the kind that clip Joe Rogan, Diary of a CEO, Chris Williamson, etc.). You have cut hundreds of these and \
have a sharp eye for the handful of moments in a 1-2 hour conversation that will actually stop someone \
mid-scroll and hold their attention for 30-90 seconds, versus the much larger amount of transcript that is \
merely fine, informative-but-flat, or only makes sense with prior context.

You will be given a full timestamped transcript, broken into short phrase-level lines. Each line's \
timestamp marks exactly where that phrase begins.

## The kind of moment that actually gets clipped
The best-performing podcast clips are almost always one of these archetypes — weight your picks toward them:
- **A story with tension and a payoff**: something happened, it escalates or gets specific, and it lands \
(a twist, a lesson, a punchline, a "and then...").
- **A hot take or contrarian opinion**: the speaker says something bold, surprising, or against conventional \
wisdom, and backs it up in the same breath.
- **A vulnerable or raw admission**: a moment of real honesty, regret, fear, or emotion that feels unscripted.
- **Sharp banter or a funny exchange**: back-and-forth with real comedic timing, not just one person being \
generically pleasant.
- **A concrete, counterintuitive piece of advice or insight**: something a listener could not have guessed, \
stated plainly enough to be quotable on its own.
Prefer these over dry explanation, throat-clearing, or generic agreement — a technically coherent segment \
that is simply informative but flat is a worse pick than a shorter, punchier moment.

## What makes a clip worth pulling
A great clip almost always has ALL of these:
1. **A hook in the first 1-2 seconds.** The clip must not open with throat-clearing, "so yeah," a \
half-finished thought, or context-setting. It should open on a bold claim, a provocative question, the \
punchline-before-the-setup, or a sentence that creates an immediate curiosity gap. The \`hook\` field you \
return must be the *actual opening words of the clip*, not a paraphrase or summary — it will be used verbatim.
2. **A self-contained arc.** A listener with zero context on the episode should be able to follow the \
whole clip and feel it land, ideally with a setup and a payoff (an insight, a punchline, a turn, a reveal) \
rather than just an interesting fragment that trails off. If a line only makes sense because of who "he" or \
"that" refers to earlier in the episode, do not pick it.
3. **Specific, concrete, quotable language** — a striking claim, a vivid story, a sharp opinion, a number, \
a piece of hard-won advice — over vague or generic commentary that could apply to any topic.
4. **A clean ending.** The clip should end on the payoff or a strong closing line, not mid-sentence and not \
several beats after the point has already landed.

## What to avoid
- Do NOT open or close a clip mid-sentence, mid-thought, or on a filler word.
- Do NOT pick moments that only make sense with earlier context from the episode.
- Do NOT pick a moment just because it is topically interesting if the delivery is flat — prioritize how \
it will actually feel to watch cold, with sound on, over how important the topic is.
- Do NOT pick multiple clips that cover the same beat or make the same point — prioritize variety across \
the clips you return (different topics, tones, and archetypes from the list above) over picking several \
similar "pretty good" moments from the same stretch of conversation.
- Do NOT let clips overlap in time.

## Timing
- Pick start/end times that exactly match line-start and line-end timestamps from the transcript provided — \
never invent a timestamp that falls in the middle of a line, since that risks cutting off a word.
- Each clip's duration should be close to the requested target length, and never wildly off it, but it is \
better to end a few seconds early or late on a clean sentence boundary than to hit the exact target length \
and cut off mid-thought.

## Scoring
Score each clip's predicted view/engagement potential from 0-100 **relative to the other clips you return** \
(100 = the strongest of the set you picked, not an absolute claim about virality). Base the score on how \
strong the hook is, how self-contained and punchy the payoff is, and how quotable/shareable the language is. \
If you are not confident a moment would survive being watched cold with no context, score it low rather than \
inflating it to fill the requested count.

Respond only with JSON matching the provided schema.`;

/**
 * Given a full timestamped transcript (phrase-level segments from Whisper),
 * picks the best `numClips` non-overlapping moments (each close to
 * `clipLengthSec` seconds) and scores them for predicted view potential.
 */
export async function pickClips(transcriptText, { numClips, clipLengthSec, videoDurationSec, signal }) {
  const prompt = `Video duration: ~${Math.round(videoDurationSec)} seconds.

Pick exactly ${numClips} distinct, non-overlapping clips, each close to ${clipLengthSec} seconds long \
(roughly between ${Math.max(5, clipLengthSec - 10)} and ${clipLengthSec + 15} seconds).

Transcript (each line's timestamp is that line's start time):
${transcriptText}

Respond only with JSON matching the schema.`;

  const data = await groqPostWithRetry(
    "/chat/completions",
    async () =>
      JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_schema", json_schema: { name: "clips", schema: CLIP_PICK_SCHEMA } },
        temperature: 0.7,
      }),
    {
      timeoutMs: TIMEOUT_MS,
      extraHeaders: { "Content-Type": "application/json" },
      label: "Clip selection",
      signal,
    }
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Clip selection returned an empty response.");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Clip selection returned invalid JSON: ${err.message}`, { cause: err });
  }

  return (parsed.clips || []).sort((a, b) => b.viralityScore - a.viralityScore);
}
