import { useState } from "react";

// Where clips go beyond the YouTube clips channel.
//
// The list of platforms comes from the backend rather than being hardcoded
// here, so adding one is a server-side catalog entry and this screen picks it
// up without a frontend change.

const INTERVALS = [
  { hours: 1, label: "hour" },
  { hours: 3, label: "3 hours" },
  { hours: 6, label: "6 hours" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "day" },
  { hours: 48, label: "2 days" },
  { hours: 168, label: "week" },
];

export default function Destinations({
  automation,
  action,
  onConnectDestination,
  onDisconnectDestination,
  onScheduleChange,
}) {
  const [confirmingRemoval, setConfirmingRemoval] = useState(null);

  const connected = automation?.destinations || [];
  const available = automation?.availablePlatforms || [];
  const connectedPlatforms = new Set(connected.map((entry) => entry.platform));
  // YouTube is the clips channel, set up in its own section above; showing it
  // here as well would imply two separate YouTube connections.
  const connectable = available.filter(
    (platform) => platform.id !== "youtube" && !connectedPlatforms.has(platform.id)
  );
  const busy = action !== null;
  const schedule = automation?.settings?.postingSchedule === "spread" ? "spread" : "immediate";
  const interval = Number(automation?.settings?.postingIntervalHours) || 24;
  const clipCount = Number(automation?.settings?.numClips) || 3;

  return (
    <section className="automation-card destinations-card">
      <div className="destinations-head">
        <h2>Post anywhere</h2>
        <p className="destinations-lede">
          Every clip Ravi makes is posted to each connected account, with the clip's title as
          the caption.
        </p>
      </div>

      {connected.length > 0 && (
        <ul className="destination-list">
          {connected.map((destination) => (
            <li className="destination-row" key={destination.platform}>
              <span className={`destination-badge platform-${destination.platform}`} aria-hidden="true">
                {destination.label.slice(0, 2)}
              </span>
              <span className="destination-identity">
                <span className="destination-name">{destination.label}</span>
                <span className="destination-account">
                  {destination.username || destination.title}
                </span>
              </span>

              {destination.needsReauth && (
                <span className="destination-warning" role="status">
                  Reconnect needed
                </span>
              )}

              {confirmingRemoval === destination.platform ? (
                <span className="destination-confirm">
                  <button
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => {
                      setConfirmingRemoval(null);
                      onDisconnectDestination(destination.platform);
                    }}
                  >
                    Remove
                  </button>
                  <button className="btn-quiet" onClick={() => setConfirmingRemoval(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="btn-quiet"
                  disabled={busy}
                  onClick={() => setConfirmingRemoval(destination.platform)}
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {connectable.length > 0 && (
        <div className="destination-add">
          <span className="destination-add-label">
            {connected.length ? "Add another" : "Connect an account"}
          </span>
          <div className="destination-options">
            {connectable.map((platform) => (
              <button
                key={platform.id}
                className="destination-option"
                disabled={busy}
                onClick={() => onConnectDestination(platform.id)}
              >
                {action === `connecting-${platform.id}` ? "Opening…" : platform.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {connectable.length === 0 && connected.length > 0 && (
        <p className="destinations-note">Every supported platform is connected.</p>
      )}

      <div className="schedule-block">
        <span className="destination-add-label">When to post</span>
        <div className="schedule-choices">
          <label className={`schedule-choice ${schedule === "immediate" ? "selected" : ""}`}>
            <input
              type="radio"
              name="posting-schedule"
              value="immediate"
              checked={schedule === "immediate"}
              disabled={busy}
              onChange={() => onScheduleChange({ postingSchedule: "immediate" })}
            />
            <span className="schedule-choice-body">
              <span className="schedule-choice-name">All at once</span>
              <span className="schedule-choice-help">
                Every clip goes out as soon as it is ready.
              </span>
            </span>
          </label>

          <label className={`schedule-choice ${schedule === "spread" ? "selected" : ""}`}>
            <input
              type="radio"
              name="posting-schedule"
              value="spread"
              checked={schedule === "spread"}
              disabled={busy}
              onChange={() => onScheduleChange({ postingSchedule: "spread" })}
            />
            <span className="schedule-choice-body">
              <span className="schedule-choice-name">Spread them out</span>
              <span className="schedule-choice-help">
                The first clip posts right away and the rest follow on a timer, so one
                episode does not arrive all at once.
              </span>
            </span>
          </label>
        </div>

        {schedule === "spread" && (
          <label className="schedule-interval">
            <span>Post the next clip every</span>
            <select
              value={String(interval)}
              disabled={busy}
              onChange={(event) =>
                onScheduleChange({ postingIntervalHours: Number(event.target.value) })
              }
            >
              {INTERVALS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <p className="destinations-note">{describeSchedule(schedule, interval, clipCount)}</p>
      </div>
    </section>
  );
}

/**
 * Says when the last clip of a set actually lands. "Every 12 hours" does not
 * make it obvious that three clips means a day and a half.
 */
function describeSchedule(schedule, intervalHours, clipCount) {
  if (schedule !== "spread") return "All clips from an episode post together.";
  const gaps = Math.max(0, clipCount - 1);
  if (gaps === 0) return "One clip per episode, so nothing is held back.";
  const totalHours = gaps * intervalHours;
  const span =
    totalHours % 24 === 0
      ? `${totalHours / 24} day${totalHours / 24 === 1 ? "" : "s"}`
      : `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
  return `${clipCount} clips per episode, so the last one posts about ${span} after the first.`;
}
