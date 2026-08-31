import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldSyncSourceChannelDraft,
  sourceChannelSnapshot,
} from "../src/sourceChannelDraft.js";

const saved = sourceChannelSnapshot({
  provider: "public",
  id: "UC1234567890123456789012",
  url: "https://www.youtube.com/channel/UC1234567890123456789012",
});

test("preserves a dirty main-channel draft across background status updates", () => {
  assert.equal(shouldSyncSourceChannelDraft({
    initialized: true,
    dirty: true,
    previousSignature: saved.signature,
    nextSignature: saved.signature,
    previousAction: null,
    action: null,
    error: null,
  }), false);
});

test("synchronizes after a real channel change or successful source save", () => {
  const changed = sourceChannelSnapshot({
    provider: "public",
    id: "UCabcdefghijklmnopqrstuv",
    url: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
  });

  assert.equal(shouldSyncSourceChannelDraft({
    initialized: true,
    dirty: true,
    previousSignature: saved.signature,
    nextSignature: changed.signature,
    previousAction: null,
    action: null,
    error: null,
  }), true);

  assert.equal(shouldSyncSourceChannelDraft({
    initialized: true,
    dirty: true,
    previousSignature: saved.signature,
    nextSignature: saved.signature,
    previousAction: "saving-source",
    action: null,
    error: null,
  }), true);
});

test("keeps the attempted main-channel draft when saving fails", () => {
  assert.equal(shouldSyncSourceChannelDraft({
    initialized: true,
    dirty: true,
    previousSignature: saved.signature,
    nextSignature: saved.signature,
    previousAction: "saving-source",
    action: null,
    error: "Ravi could not verify that channel.",
  }), false);
});
