import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_IDS,
  SHORT_CAPTION_LIMIT,
  buildPlatformTargets,
  captionForPlatform,
  isSupportedPlatform,
  listPlatforms,
  shortCaption,
  titleForPlatform,
} from "../src/lib/socialPlatforms.js";

test("only clip-capable platforms are offered as destinations", () => {
  assert.equal(isSupportedPlatform("tiktok"), true);
  assert.equal(isSupportedPlatform("youtube"), true);
  // Zernio brokers these too, but a vertical clip is not what they are for.
  assert.equal(isSupportedPlatform("slack"), false);
  assert.equal(isSupportedPlatform("whatsapp"), false);
  assert.equal(isSupportedPlatform(""), false);
  assert.equal(isSupportedPlatform(undefined), false);
});

test("prototype keys are not mistaken for platforms", () => {
  // PLATFORMS is a plain object, so a naive `in` check would accept these.
  assert.equal(isSupportedPlatform("constructor"), false);
  assert.equal(isSupportedPlatform("toString"), false);
  assert.equal(isSupportedPlatform("__proto__"), false);
});

test("the public catalog carries what the connect screen needs", () => {
  const catalog = listPlatforms();
  assert.equal(catalog.length, PLATFORM_IDS.length);
  const x = catalog.find((entry) => entry.id === "twitter");
  assert.equal(x.label, "X");
  assert.equal(x.captionLimit, 280);
});

test("a caption within the limit is passed through untouched", () => {
  assert.equal(captionForPlatform("youtube", "  A short caption  "), "A short caption");
  assert.equal(captionForPlatform("twitter", "Fits fine"), "Fits fine");
});

test("a long caption is cut to each platform's own limit", () => {
  // One caption fans out to nine limits at once. Sending the full text would
  // have X reject the post outright.
  const caption = `${"word ".repeat(200)}end`;
  const forX = captionForPlatform("twitter", caption);
  const forYouTube = captionForPlatform("youtube", caption);

  assert.ok(forX.length <= 280, `X caption was ${forX.length}`);
  assert.ok(forX.endsWith("…"));
  // YouTube's 5000 is well clear of this caption, so nothing is lost there.
  assert.equal(forYouTube.includes("…"), false);
  assert.ok(forYouTube.length > forX.length);
});

test("truncation lands on a word boundary, not mid-word", () => {
  const caption = `${"alpha ".repeat(60)}omega`;
  const trimmed = captionForPlatform("twitter", caption);
  assert.ok(trimmed.length <= 280);
  // The body before the ellipsis should be whole words.
  assert.equal(/alph…$|alp…$/.test(trimmed), false);
  assert.ok(trimmed.endsWith("…"));
});

test("a single unbroken word is still cut to the limit", () => {
  // No space to fall back to, so the word-boundary rule must not win and
  // return something over the limit.
  const trimmed = captionForPlatform("bluesky", "x".repeat(1000));
  assert.ok(trimmed.length <= 300, `got ${trimmed.length}`);
});

test("titles are capped where a platform caps them", () => {
  assert.equal(titleForPlatform("youtube", "Short title"), "Short title");
  const long = titleForPlatform("youtube", "t".repeat(300));
  assert.ok(long.length <= 100);
  // TikTok has no separate title field, so nothing is imposed.
  assert.equal(titleForPlatform("tiktok", "t".repeat(300)).length, 300);
});

test("the clip title is the caption, identical on every platform", () => {
  const targets = buildPlatformTargets({
    destinations: [
      { platform: "twitter", accountId: "acc-x" },
      { platform: "youtube", accountId: "acc-yt" },
      { platform: "tiktok", accountId: "acc-tt" },
    ],
    title: "The moment he realised he was wrong",
  });

  assert.equal(targets.length, 3);
  const captions = new Set(targets.map((target) => target.customContent));
  // A short title clears every limit, so fan-out says the same thing
  // everywhere rather than a different truncation per platform.
  assert.equal(captions.size, 1);
  assert.equal([...captions][0], "The moment he realised he was wrong");
});

test("model-written titles are cleaned before they are posted", () => {
  // Clip titles come from the moment picker and arrive with these artefacts.
  assert.equal(shortCaption('"The moment he realised he was wrong"'), "The moment he realised he was wrong");
  assert.equal(shortCaption("“Curly quoted title”"), "Curly quoted title");
  assert.equal(shortCaption("  Doubled   spaces\nand a newline  "), "Doubled spaces and a newline");
  // Quotation inside the line is meaningful and left alone.
  assert.equal(shortCaption('He said "no" twice'), 'He said "no" twice');
});

test("an over-long title is cut to a postable length", () => {
  const caption = shortCaption(`${"word ".repeat(60)}end`);
  assert.ok(caption.length <= SHORT_CAPTION_LIMIT, `got ${caption.length}`);
  assert.ok(caption.endsWith("…"));
  // Still comfortably inside the tightest platform limit.
  assert.ok(caption.length < 280);
});

test("YouTube targets carry an explicit title", () => {
  const [target] = buildPlatformTargets({
    destinations: [{ platform: "youtube", accountId: "acc-yt" }],
    title: "Episode highlight",
  });
  assert.equal(target.platformSpecificData.title, "Episode highlight");
  assert.equal(target.platformSpecificData.visibility, "public");
  assert.equal(target.platformSpecificData.madeForKids, false);
});

test("platforms without a title field get no platformSpecificData title", () => {
  const [tiktok] = buildPlatformTargets({
    destinations: [{ platform: "tiktok", accountId: "acc-tt" }],
    title: "Episode highlight",
  });
  assert.equal(tiktok.platformSpecificData, undefined);
});

test("unusable destinations are dropped rather than sent", () => {
  const targets = buildPlatformTargets({
    destinations: [
      { platform: "slack", accountId: "acc-slack" },
      { platform: "tiktok", accountId: "" },
      { platform: "", accountId: "acc" },
      null,
      { platform: "tiktok", accountId: "acc-tt" },
    ],
    title: "hi",
  });
  assert.deepEqual(targets.map((target) => target.platform), ["tiktok"]);
});
