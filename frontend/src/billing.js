const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["none", "canceled", "incomplete_expired"]);

// Stripe treats these charge currencies as zero-decimal. ISK and UGX are
// intentionally excluded because Stripe's backwards-compatible API amounts
// still use two trailing zeroes for them.
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const STRIPE_TWO_DECIMAL_COMPATIBILITY_CURRENCIES = new Set(["isk", "ugx"]);

export function subscriptionStatus(billing) {
  return billing?.status || billing?.subscriptionStatus || "none";
}

export function subscriptionIsActive(billing) {
  return billing?.active === true || ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus(billing));
}

export function billingNeedsPortal(billing) {
  return (
    billing?.enabled === true &&
    billing?.canManageBilling === true &&
    !subscriptionIsActive(billing) &&
    !TERMINAL_SUBSCRIPTION_STATUSES.has(subscriptionStatus(billing))
  );
}

function stripeAmountDivisor(currency, formatter) {
  const normalized = currency.toLowerCase();
  if (STRIPE_TWO_DECIMAL_COMPATIBILITY_CURRENCIES.has(normalized)) return 100;
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(normalized)) return 1;
  return 10 ** formatter.resolvedOptions().maximumFractionDigits;
}

export function priceDetails(billing) {
  const price = billing?.price || billing?.plan?.price || {};
  const amount = price.unitAmount ?? price.unit_amount ?? billing?.unitAmount;
  const currency = price.currency || billing?.currency;
  const interval = price.interval || price.recurring?.interval || billing?.interval;
  const intervalCount =
    price.intervalCount ?? price.interval_count ?? price.recurring?.interval_count ?? 1;

  if (!Number.isFinite(amount) || typeof currency !== "string" || !currency) return null;

  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    });
    const majorAmount = amount / stripeAmountDivisor(currency, formatter);
    const formatted = formatter.format(majorAmount);
    const cadence = interval
      ? intervalCount > 1
        ? `every ${intervalCount} ${interval}s`
        : `/${interval}`
      : "";
    return { formatted, cadence, majorAmount };
  } catch {
    return null;
  }
}
