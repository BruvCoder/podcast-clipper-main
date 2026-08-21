import Waveform from "./Waveform.jsx";
import { useAuth } from "../AuthContext.jsx";
import { billingNeedsPortal, priceDetails, subscriptionIsActive } from "../billing.js";

export default function BillingGate({
  billing,
  loading,
  error,
  notice,
  action,
  checkoutConfirmationPending,
  onCheckout,
  onManageBilling,
  onRetry,
}) {
  const { user, signOut } = useAuth();
  const price = priceDetails(billing);
  const active = subscriptionIsActive(billing);
  const needsPortal = billingNeedsPortal(billing);
  const needsConfirmation = checkoutConfirmationPending && !needsPortal;
  const planName = billing?.planName || billing?.price?.nickname || "VOD Clipper Pro";

  return (
    <div className="billing-shell">
      <div className="billing-header">
        <div className="brand">
          <Waveform className="brand-mark" bars={5} />
          <span className="brand-name">
            VOD<span className="brand-accent">Clipper</span>
          </span>
        </div>
        <button className="billing-signout" onClick={signOut}>Sign out</button>
      </div>

      <div className="billing-card">
        <div className="billing-orbit" aria-hidden="true">
          <Waveform className="billing-waveform" bars={11} />
        </div>

        {loading ? (
          <div className="billing-state" role="status">
            <span className="billing-kicker">Subscription</span>
            <h1>Checking your plan…</h1>
            <p>Verifying access for {user?.email || "your account"}.</p>
          </div>
        ) : error && !billing ? (
          <div className="billing-state">
            <span className="billing-kicker">Subscription</span>
            <h1>We couldn’t verify your plan</h1>
            <p>{error}</p>
            <button className="btn-primary billing-cta" onClick={onRetry}>Try again</button>
          </div>
        ) : (
          <>
            <div className="billing-copy">
              <span className="billing-kicker">Unlock the clip studio</span>
              <h1>Turn every long-form video into clips worth posting.</h1>
              <p>
                Subscribe to create, caption, and download polished vertical clips from your VODs.
                Checkout is securely handled by Stripe.
              </p>
            </div>

            <div className="billing-plan">
              <div className="billing-plan-head">
                <div>
                  <span className="billing-plan-label">{planName}</span>
                  {price ? (
                    <div className="billing-price">
                      <strong>{price.formatted}</strong>
                      <span>{price.cadence}</span>
                    </div>
                  ) : (
                    <div className="billing-price billing-price-fallback">Subscription plan</div>
                  )}
                </div>
                <span className="billing-plan-badge">Pro</span>
              </div>

              <ul className="billing-features">
                <li><CheckIcon /> AI-selected highlight moments</li>
                <li><CheckIcon /> Vertical reframing and animated captions</li>
                <li><CheckIcon /> Ready-to-post MP4 downloads</li>
                <li><CheckIcon /> Cancel or update billing in Stripe</li>
              </ul>

              {notice && <div className={`billing-notice ${notice.type || "info"}`}>{notice.text}</div>}
              {error && billing && <div className="error-box billing-error">{error}</div>}

              <button
                className="btn-primary billing-cta"
                onClick={needsPortal ? onManageBilling : needsConfirmation ? onRetry : onCheckout}
                disabled={Boolean(action) || active}
              >
                {action
                  ? needsPortal
                    ? "Opening billing settings…"
                    : "Opening secure checkout…"
                  : needsPortal
                    ? "Fix payment in billing"
                    : needsConfirmation
                      ? "Check subscription status"
                      : "Continue to secure checkout"}
              </button>
              <span className="billing-fineprint">You’ll review the price and renewal terms before paying.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="7.5" fill="currentColor" opacity=".16" />
      <path d="m5 8.7 2.25 2.2L12.2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
