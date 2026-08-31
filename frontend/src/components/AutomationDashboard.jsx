import { useEffect, useMemo, useRef, useState } from "react";
import {
  shouldSyncSourceChannelDraft,
  sourceChannelSnapshot,
} from "../sourceChannelDraft.js";
import { isValidYouTubeChannelUrl, normalizeYouTubeChannelUrl } from "../youtube.js";
import YouTubeIcon from "./YouTubeIcon.jsx";

const SUBTITLE_COLORS = ["#FFFFFF", "#FFE94A", "#72F1B8", "#64B5FF"];

const DEFAULT_SETTINGS = {
  numClips: 3,
  clipLengthSec: 45,
  cropMode: "pad",
  subtitleColor: "#FFFFFF",
  privacyStatus: "private",
  madeForKids: false,
};

const DEFAULT_CERTIFICATIONS = {
  ownsSourceContent: false,
  acceptsCommunityGuidelines: false,
};

function formatTime(value, fallback = "Not yet") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function channelName(channel, fallback) {
  return channel?.title || channel?.name || fallback;
}

function channelAccountIdentity(channel) {
  return channel?.channelId || channel?.id || channel?.externalId || channel?.providerAccountId || channel?.url || null;
}

function normalizeChannelLabel(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function normalizeChannelUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLocaleLowerCase().replace(/^www\./, "");
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, "").toLocaleLowerCase();
    return `${host}${path}`;
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "").toLocaleLowerCase();
  }
}

function channelsMatch(mainChannel, clipsChannel) {
  const mainIdentity = channelAccountIdentity(mainChannel);
  const clipsIdentity = channelAccountIdentity(clipsChannel);
  if (mainIdentity && clipsIdentity && mainIdentity === clipsIdentity) return true;

  const mainUrl = normalizeChannelUrl(mainChannel?.url || mainChannel?.profileUrl);
  const clipsUrl = normalizeChannelUrl(clipsChannel?.url || clipsChannel?.profileUrl);
  if (mainUrl && clipsUrl && mainUrl === clipsUrl) return true;

  const mainUsername = normalizeChannelLabel(mainChannel?.username || mainChannel?.handle);
  const clipsUsername = normalizeChannelLabel(clipsChannel?.username || clipsChannel?.handle);
  if (mainUsername && clipsUsername && mainUsername === clipsUsername) return true;

  const mainName = normalizeChannelLabel(channelName(mainChannel, ""));
  const clipsName = normalizeChannelLabel(channelName(clipsChannel, ""));
  return Boolean(mainName && clipsName && mainName === clipsName);
}

function activityLinks(activity) {
  const links = activity?.publishedUrls || activity?.youtubeUrls || [];
  return (Array.isArray(links) ? links : [links]).filter(Boolean).map((link) => {
    if (typeof link === "string") return { url: link, label: "View on YouTube" };
    return {
      url: link.url || link.youtubeUrl,
      label: link.title || link.label || "View on YouTube",
    };
  }).filter((link) => link.url);
}

function statusInfo(automation) {
  if (
    automation?.lastError
    || automation?.status === "error"
    || automation?.clipsChannel?.needsReauth
    || (automation?.sourceChannel && automation?.clipsChannel && channelsMatch(automation.sourceChannel, automation.clipsChannel))
  ) {
    return { label: "Needs attention", tone: "error" };
  }
  if (automation?.enabled) return { label: "Watching", tone: "active" };
  if (automation?.sourceChannel?.provider === "public" && automation?.clipsChannel) {
    return { label: "Paused", tone: "paused" };
  }
  return { label: "Setup needed", tone: "setup" };
}

function ChannelAvatar({ channel, type }) {
  if (channel?.thumbnailUrl) {
    return <img src={channel.thumbnailUrl} alt="" />;
  }
  return <YouTubeIcon className={type === "clips" ? "youtube-clips-mark" : "youtube-main-mark"} />;
}

export default function AutomationDashboard({
  automation,
  loading,
  error,
  notice,
  action,
  onConnect,
  onSetSource,
  onUpdate,
  onCheckNow,
  onDisconnect,
}) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [certifications, setCertifications] = useState(DEFAULT_CERTIFICATIONS);
  const [disconnectArmed, setDisconnectArmed] = useState(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceDraftDirty, setSourceDraftDirty] = useState(false);
  const sourceSignatureRef = useRef();
  const previousActionRef = useRef(action);

  useEffect(() => {
    setSettings({
      ...DEFAULT_SETTINGS,
      ...(automation?.settings || {}),
    });
    setCertifications({ ...DEFAULT_CERTIFICATIONS, ...(automation?.certifications || {}) });
  }, [automation]);

  const savedSource = sourceChannelSnapshot(automation?.sourceChannel);

  useEffect(() => {
    const shouldSync = shouldSyncSourceChannelDraft({
      initialized: sourceSignatureRef.current !== undefined,
      dirty: sourceDraftDirty,
      previousSignature: sourceSignatureRef.current,
      nextSignature: savedSource.signature,
      previousAction: previousActionRef.current,
      action,
      error,
    });

    if (shouldSync) {
      setSourceUrl(savedSource.url);
      setSourceDraftDirty(false);
    }
    sourceSignatureRef.current = savedSource.signature;
    previousActionRef.current = action;
  }, [action, error, savedSource.signature, savedSource.url, sourceDraftDirty]);

  const sourceConnected = Boolean(automation?.sourceChannel);
  const clipsConnected = Boolean(automation?.clipsChannel);
  const sourceReady = sourceConnected && automation?.sourceChannel?.provider === "public";
  const clipsReady = clipsConnected && !automation?.clipsChannel?.needsReauth;
  const connectionsDistinct = sourceConnected && clipsConnected && !channelsMatch(automation.sourceChannel, automation.clipsChannel);
  const certified = certifications.ownsSourceContent && certifications.acceptsCommunityGuidelines;
  const canEnable = sourceReady && clipsReady && connectionsDistinct && certified && action === null;
  const status = useMemo(() => statusInfo(automation), [automation]);
  const normalizedSourceUrl = normalizeYouTubeChannelUrl(sourceUrl);
  const sourceUrlValid = isValidYouTubeChannelUrl(sourceUrl);

  function saveSourceChannel(event) {
    event.preventDefault();
    if (!normalizedSourceUrl || action !== null) return;
    onSetSource(normalizedSourceUrl);
  }

  function payload(enabled = automation?.enabled || false) {
    return {
      enabled,
      settings: {
        numClips: Number(settings.numClips),
        clipLengthSec: Number(settings.clipLengthSec),
        cropMode: settings.cropMode,
        subtitleColor: settings.subtitleColor,
        privacyStatus: settings.privacyStatus,
        madeForKids: Boolean(settings.madeForKids),
      },
      certifications,
    };
  }

  if (loading) {
    return (
      <div className="automation-loading" role="status">
        <span className="automation-spinner" />
        <p>Loading your Ravi setup…</p>
      </div>
    );
  }

  if (automation?.available === false) {
    return (
      <div className="automation-page">
        <div className="automation-heading">
          <div>
            <h1>Connect your clips channel</h1>
            <p>Channel automation is not available on this deployment yet.</p>
          </div>
        </div>
        <div className="automation-alert error" role="alert">
          {automation.message || "Channel connections are not available on this deployment yet."}
        </div>
      </div>
    );
  }

  return (
    <div className="automation-page">
      <div className="automation-heading">
        <div>
          <h1>Ravi overview</h1>
          <p>Ravi watches your main channel and posts the most viral-ready moments to your clips channel.</p>
        </div>
        <span className={`automation-status ${status.tone}`}>
          <i aria-hidden="true" /> {status.label}
        </span>
      </div>

      {notice && <div className="automation-alert success" role="status">{notice}</div>}
      {(error || automation?.lastError) && (
        <div className="automation-alert error" role="alert">{error || automation.lastError}</div>
      )}

      <section className="automation-card channel-map" aria-labelledby="channel-map-title">
        <div className="automation-card-head">
          <div>
            <h2 id="channel-map-title">Where Ravi watches and posts</h2>
          </div>
          {automation?.enabled && (
            <button className="automation-text-btn" type="button" onClick={onCheckNow} disabled={action !== null}>
              {action === "checking" ? "Checking…" : "Check now"}
            </button>
          )}
        </div>

        <div className="channel-route">
          <div
            className={`channel-node ${sourceReady ? "connected" : ""}`}
            onMouseLeave={() => disconnectArmed === "main" && setDisconnectArmed(null)}
          >
            <div className="channel-avatar main">
              <ChannelAvatar channel={automation?.sourceChannel} type="main" />
            </div>
            <div>
              <span className="channel-role">Main channel</span>
              {sourceConnected && automation?.sourceChannel?.url ? (
                <a
                  className="channel-name-link"
                  href={automation.sourceChannel.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {channelName(automation.sourceChannel, "Main channel")} <span aria-hidden="true">↗</span>
                </a>
              ) : (
                <strong>{channelName(automation?.sourceChannel, "Add a channel link")}</strong>
              )}
              <small>{sourceReady
                ? "Ravi will watch this public channel"
                : "Add the public channel Ravi should watch"}</small>
            </div>
            <form className="channel-main-link-form" onSubmit={saveSourceChannel} noValidate>
              <label htmlFor="main-channel-url">Main channel link or @handle</label>
              <div className="channel-main-link-control">
                <input
                  id="main-channel-url"
                  type="text"
                  inputMode="url"
                  autoComplete="url"
                  value={sourceUrl}
                  disabled={action === "saving-source"}
                  onChange={(event) => {
                    setSourceUrl(event.target.value);
                    setSourceDraftDirty(true);
                  }}
                  placeholder="https://youtube.com/@yourchannel"
                  aria-invalid={Boolean(sourceUrl.trim()) && !sourceUrlValid}
                  aria-describedby="main-channel-url-help"
                />
                <button
                  className="channel-connect-btn"
                  type="submit"
                  disabled={action !== null || !sourceUrlValid}
                >
                  {action === "saving-source" ? "Saving…" : sourceConnected ? "Update" : "Save"}
                </button>
              </div>
              <small
                id="main-channel-url-help"
                className={sourceUrl.trim() && !sourceUrlValid ? "channel-link-error" : ""}
              >
                {sourceUrl.trim() && !sourceUrlValid
                  ? "Enter a YouTube channel link or @handle."
                  : "No sign-in needed for your public main channel."}
              </small>
              {sourceConnected && (
                <button
                  className="channel-disconnect-btn"
                  type="button"
                  disabled={action !== null}
                  onClick={() => {
                    if (disconnectArmed !== "main") setDisconnectArmed("main");
                    else onDisconnect("main");
                  }}
                >
                  {action === "disconnecting-main"
                    ? "Disconnecting…"
                    : disconnectArmed === "main"
                    ? "Confirm remove"
                    : "Remove link"}
                </button>
              )}
            </form>
          </div>

          <div className="channel-route-agent" aria-label="Ravi creates and publishes clips">
            <span className="route-line" />
            <span className="route-agent-badge">R</span>
            <span className="route-line" />
          </div>

          <div
            className={`channel-node ${clipsReady ? "connected" : ""}`}
            onMouseLeave={() => disconnectArmed === "clips" && setDisconnectArmed(null)}
          >
            <div className="channel-avatar clips">
              <ChannelAvatar channel={automation?.clipsChannel} type="clips" />
            </div>
            <div>
              <span className="channel-role">Clips channel</span>
              <strong>{channelName(automation?.clipsChannel, "Not connected")}</strong>
              <small>{automation?.clipsChannel?.needsReauth
                ? "Reconnect to resume publishing"
                : clipsConnected
                ? "Ready for Ravi to publish"
                : "Connect the channel where Ravi should post"}</small>
            </div>
            <div className="channel-node-actions">
              <button
                className="channel-connect-btn"
                type="button"
                onClick={() => onConnect("clips")}
                disabled={action !== null}
              >
                {action === "connecting-clips" ? "Connecting…" : clipsConnected ? "Reconnect clips channel" : "Connect your clips channel"}
              </button>
              {clipsConnected && (
                <button
                  className="channel-disconnect-btn"
                  type="button"
                  disabled={action !== null}
                  onClick={() => {
                    if (disconnectArmed !== "clips") setDisconnectArmed("clips");
                    else onDisconnect("clips");
                  }}
                >
                  {action === "disconnecting-clips"
                    ? "Disconnecting…"
                    : disconnectArmed === "clips"
                    ? "Confirm disconnect"
                    : "Disconnect"}
                </button>
              )}
            </div>
          </div>
        </div>

        <p className={`channel-route-help ${sourceConnected && clipsConnected && !connectionsDistinct ? "error" : ""}`}>
          {sourceConnected && clipsConnected && !connectionsDistinct
            ? "Your main and clips channels must be different. Change your main link or reconnect your clips channel."
            : "Add your main channel and connect a different clips channel. Ravi starts with the next public upload after you turn watching on; existing videos are not backfilled."}
        </p>
      </section>

      <div className="automation-columns">
        <section className="automation-card" aria-labelledby="clip-settings-title">
          <div className="automation-card-head">
            <div>
              <h2 id="clip-settings-title">Default output</h2>
            </div>
          </div>

          <div className="automation-field">
            <label htmlFor="automation-clip-count">
              Clips per upload <strong>{settings.numClips}</strong>
            </label>
            <input
              id="automation-clip-count"
              type="range"
              min="1"
              max="5"
              value={settings.numClips}
              onChange={(event) => setSettings((value) => ({ ...value, numClips: Number(event.target.value) }))}
            />
            <div className="range-labels"><span>1</span><span>5</span></div>
          </div>

          <div className="automation-field-grid">
            <label className="automation-select-field">
              <span>Clip length</span>
              <select
                value={settings.clipLengthSec}
                onChange={(event) => setSettings((value) => ({ ...value, clipLengthSec: Number(event.target.value) }))}
              >
                <option value="15">About 15 seconds</option>
                <option value="30">About 30 seconds</option>
                <option value="45">About 45 seconds</option>
                <option value="60">About 60 seconds</option>
              </select>
            </label>
            <label className="automation-select-field">
              <span>YouTube visibility</span>
              <select
                value={settings.privacyStatus}
                onChange={(event) => setSettings((value) => ({ ...value, privacyStatus: event.target.value }))}
              >
                <option value="private">Private — recommended</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </label>
          </div>

          <div className="automation-field">
            <span className="automation-label">Framing</span>
            <div className="automation-segmented">
              <button
                type="button"
                className={settings.cropMode === "pad" ? "selected" : ""}
                onClick={() => setSettings((value) => ({ ...value, cropMode: "pad" }))}
              >
                Fit with background
              </button>
              <button
                type="button"
                className={settings.cropMode === "crop" ? "selected" : ""}
                onClick={() => setSettings((value) => ({ ...value, cropMode: "crop" }))}
              >
                Zoomed crop
              </button>
            </div>
          </div>

          <div className="automation-field">
            <span className="automation-label">Subtitle color</span>
            <div className="automation-swatches" role="radiogroup" aria-label="Subtitle color">
              {SUBTITLE_COLORS.map((color) => (
                <button
                  type="button"
                  key={color}
                  className={settings.subtitleColor === color ? "selected" : ""}
                  style={{ "--swatch-color": color }}
                  onClick={() => setSettings((value) => ({ ...value, subtitleColor: color }))}
                  role="radio"
                  aria-checked={settings.subtitleColor === color}
                  aria-label={`Use ${color} subtitles`}
                />
              ))}
            </div>
          </div>

          <div className="automation-warning">
            <strong>No manual review step</strong>
            <span>Ravi uploads automatically. Start with Private visibility, review a few results, then switch to Public when you are ready.</span>
          </div>

          <label className="automation-check-row">
            <input
              type="checkbox"
              checked={settings.madeForKids}
              onChange={(event) => setSettings((value) => ({ ...value, madeForKids: event.target.checked }))}
            />
            <span>
              <strong>This content is made for kids</strong>
              <small>Applied to every clip Ravi uploads.</small>
            </span>
          </label>

        </section>

        <section className="automation-card automation-control-card" aria-labelledby="ravi-control-title">
          <div className="automation-card-head">
            <div>
              <h2 id="ravi-control-title">Let Ravi run</h2>
            </div>
          </div>

          <div className="automation-control-summary">
            <span className={`control-orb ${status.tone}`} aria-hidden="true"><i /></span>
            <div>
              <strong>{automation?.enabled ? "Ravi is watching" : "Ravi is standing by"}</strong>
              <p>{automation?.enabled
                ? "New public uploads will be clipped and posted automatically."
                : "Finish the setup below, then turn watching on."}</p>
            </div>
          </div>

          <dl className="automation-metrics">
            <div><dt>Last checked</dt><dd>{formatTime(automation?.lastCheckedAt)}</dd></div>
            <div><dt>Latest upload found</dt><dd>{automation?.lastDetectedVideo?.title || formatTime(automation?.lastDetectedVideo?.publishedAt, "None yet")}</dd></div>
            <div><dt>Last clip posted</dt><dd>{formatTime(automation?.lastPublishedAt)}</dd></div>
          </dl>

          <div className="certification-box">
            <span className="automation-label">Before Ravi can publish</span>
            <label className="automation-check-row">
              <input
                type="checkbox"
                checked={certifications.ownsSourceContent}
                onChange={(event) => setCertifications((value) => ({ ...value, ownsSourceContent: event.target.checked }))}
              />
              <span>I own or have permission to repurpose every video on this main channel.</span>
            </label>
            <label className="automation-check-row">
              <input
                type="checkbox"
                checked={certifications.acceptsCommunityGuidelines}
                onChange={(event) => setCertifications((value) => ({ ...value, acceptsCommunityGuidelines: event.target.checked }))}
              />
              <span>I understand every uploaded clip must follow YouTube’s Community Guidelines.</span>
            </label>
          </div>

          <button
            className="automation-primary-btn"
            type="button"
            disabled={automation?.enabled ? action !== null : !canEnable}
            onClick={() => onUpdate(payload(!automation?.enabled))}
          >
            {action === "saving"
              ? "Saving…"
              : automation?.enabled
              ? "Pause Ravi"
              : "Turn on Ravi"}
          </button>
          <button
            className="automation-secondary-btn"
            type="button"
            disabled={action !== null}
            onClick={() => onUpdate(payload(automation?.enabled || false))}
          >
            Save setup
          </button>
          {!canEnable && !automation?.enabled && (
            <p className="automation-requirements">Add your main channel, connect a different clips channel, and confirm both certifications to turn Ravi on.</p>
          )}
        </section>
      </div>

      <section className="automation-card activity-card" aria-labelledby="activity-title">
        <div className="automation-card-head">
          <div>
            <h2 id="activity-title">What Ravi has been doing</h2>
          </div>
        </div>
        {(!automation?.recentActivity || automation.recentActivity.length === 0) ? (
          <div className="activity-empty">
            <span>R</span>
            <div>
              <strong>No channel activity yet</strong>
              <p>When your next public video goes live, Ravi’s progress will appear here.</p>
            </div>
          </div>
        ) : (
          <div className="activity-list">
            {automation.recentActivity.map((item, index) => (
              <article className="activity-item" key={`${item.at || "activity"}-${index}`}>
                <span className={`activity-dot ${item.status || item.type || "info"}`} />
                <div className="activity-copy">
                  <strong>{item.sourceTitle || item.message || "Ravi checked your channel"}</strong>
                  {item.sourceTitle && item.message && <p>{item.message}</p>}
                  {activityLinks(item).length > 0 && (
                    <div className="activity-links">
                      {activityLinks(item).map((link, linkIndex) => (
                        <a key={`${link.url}-${linkIndex}`} href={link.url} target="_blank" rel="noreferrer">
                          {link.label} ↗
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <time>{formatTime(item.at, "Recently")}</time>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
