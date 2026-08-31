export function sourceChannelSnapshot(channel) {
  const url = channel?.url || channel?.profileUrl || "";
  return {
    url,
    signature: [channel?.provider || "", channel?.id || "", url].join("\u0000"),
  };
}

export function shouldSyncSourceChannelDraft({
  initialized,
  dirty,
  previousSignature,
  nextSignature,
  previousAction,
  action,
  error,
}) {
  if (!initialized || !dirty) return true;
  if (previousSignature !== nextSignature) return true;

  const sourceSaveFinished = previousAction === "saving-source" && action !== "saving-source";
  return sourceSaveFinished && !error;
}
