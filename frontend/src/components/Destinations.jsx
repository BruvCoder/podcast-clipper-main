import { useState } from "react";

// Where clips go beyond the YouTube clips channel.
//
// The list of platforms comes from the backend rather than being hardcoded
// here, so adding one is a server-side catalog entry and this screen picks it
// up without a frontend change.

export default function Destinations({
  automation,
  action,
  onConnectDestination,
  onDisconnectDestination,
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

  return (
    <section className="card destinations-card">
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
    </section>
  );
}
