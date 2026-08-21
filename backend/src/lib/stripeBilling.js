import { createHash } from "node:crypto";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", ""]);

export class BillingError extends Error {
  constructor(message, { status = 500, code = "billing_error", cause } = {}) {
    super(message, { cause });
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return defaultValue;
}

function parseRequiredBoolean(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function normalizeAppUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Billing is opt-in so a fresh/local checkout still works without Stripe.
 * Once explicitly enabled, every required setting must be present; an
 * incomplete production configuration fails closed instead of granting free
 * access by accident.
 */
export function loadStripeBillingConfig(env = process.env) {
  const requested = parseRequiredBoolean(env.BILLING_ENABLED);
  if (requested === null) {
    return {
      enabled: false,
      state: "misconfigured",
      missing: ["BILLING_ENABLED (must be true or false)"],
      appUrl: normalizeAppUrl(env.APP_URL || env.FRONTEND_URL),
    };
  }
  if (!requested) {
    return {
      enabled: false,
      state: "disabled",
      appUrl: normalizeAppUrl(env.APP_URL || env.FRONTEND_URL),
    };
  }

  const appUrlValue = env.APP_URL || env.FRONTEND_URL;
  const appUrl = normalizeAppUrl(appUrlValue);
  const missing = [];
  if (!env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!env.STRIPE_PRICE_ID) missing.push("STRIPE_PRICE_ID");
  if (!appUrlValue) missing.push("APP_URL");
  else if (!appUrl) missing.push("APP_URL (must be an http(s) URL)");

  return {
    enabled: missing.length === 0,
    state: missing.length === 0 ? "configured" : "misconfigured",
    missing,
    secretKey: env.STRIPE_SECRET_KEY || null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    priceId: env.STRIPE_PRICE_ID || null,
    appUrl,
    allowPromotionCodes: parseBoolean(env.STRIPE_ALLOW_PROMOTION_CODES, false),
  };
}

export function isActiveSubscriptionStatus(status) {
  return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}

function configurationMessage(config) {
  if (config.state === "misconfigured") {
    return `Billing is enabled but misconfigured: ${config.missing.join(", ")}.`;
  }
  return "Billing is not enabled.";
}

function customerId(value) {
  if (typeof value === "string") return value;
  if (value && !value.deleted && typeof value.id === "string") return value.id;
  return null;
}

function subscriptionPriceIds(subscription) {
  return (subscription?.items?.data || [])
    .map((item) => (typeof item?.price === "string" ? item.price : item?.price?.id))
    .filter(Boolean);
}

function subscriptionMatchesPrice(subscription, priceId) {
  return subscriptionPriceIds(subscription).includes(priceId);
}

function checkoutLineItemPriceIds(session) {
  return (session?.line_items?.data || [])
    .map((item) => (typeof item?.price === "string" ? item.price : item?.price?.id))
    .filter(Boolean);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkoutParametersFingerprint(parameters) {
  return createHash("sha256").update(canonicalJson(parameters)).digest("hex");
}

function checkoutIdempotencyKey(uid, previousSessionId, parameters) {
  const digest = createHash("sha256")
    .update(uid)
    .update("\0")
    .update(previousSessionId)
    .update("\0")
    .update(checkoutParametersFingerprint(parameters))
    .digest("hex");
  return `vod-clipper-checkout:${digest}`;
}

function reusableCheckoutSession(
  session,
  { parameters, nowSeconds, expectedExpiresAt = null }
) {
  const uid = parameters.client_reference_id;
  const expectedCustomerId = customerId(parameters.customer);
  const expectedPrices = parameters.line_items.map((item) => item.price);
  const expiresAt = Number(session?.expires_at);
  const sessionCustomerId = customerId(session?.customer);
  const prices = checkoutLineItemPriceIds(session);
  let checkoutUrl;
  try {
    checkoutUrl = new URL(session?.url);
  } catch {
    return false;
  }

  return (
    session?.status === "open" &&
    session?.mode === "subscription" &&
    checkoutUrl.protocol === "https:" &&
    session?.client_reference_id === uid &&
    uidFromMetadata(session) === uid &&
    sessionCustomerId === expectedCustomerId &&
    prices.length === expectedPrices.length &&
    prices.every((priceId, index) => priceId === expectedPrices[index]) &&
    (!("success_url" in session) || session.success_url === parameters.success_url) &&
    (!("cancel_url" in session) || session.cancel_url === parameters.cancel_url) &&
    (!("allow_promotion_codes" in session) ||
      Boolean(session.allow_promotion_codes) === Boolean(parameters.allow_promotion_codes)) &&
    Number.isFinite(expiresAt) &&
    expiresAt > nowSeconds &&
    (expectedExpiresAt == null || expiresAt === expectedExpiresAt)
  );
}

function subscriptionPeriodEnd(subscription) {
  const itemEnds = (subscription?.items?.data || [])
    .map((item) => item?.current_period_end)
    .filter(Number.isFinite);
  return subscription?.current_period_end || (itemEnds.length ? Math.max(...itemEnds) : null);
}

function summarizeSubscription(subscription) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    customerId: customerId(subscription.customer),
    status: subscription.status || "unknown",
    priceIds: subscriptionPriceIds(subscription),
    currentPeriodEnd: subscriptionPeriodEnd(subscription),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  };
}

function publicSubscriptionSummary(subscription) {
  const summary = summarizeSubscription(subscription);
  if (!summary) return null;
  const { customerId: _customerId, ...publicSummary } = summary;
  return publicSummary;
}

function planFromPrice(price) {
  const product = price?.product && typeof price.product === "object" ? price.product : null;
  return {
    planName: product?.deleted ? price.nickname || "Subscription" : product?.name || price.nickname || "Subscription",
    price: {
      id: price.id,
      unitAmount: Number.isFinite(price.unit_amount) ? price.unit_amount : null,
      currency: price.currency,
      interval: price.recurring?.interval || null,
      intervalCount: price.recurring?.interval_count || 1,
    },
  };
}

function billingClaims(userRecord) {
  const value = userRecord?.customClaims?.billing;
  return value && typeof value === "object" ? value : {};
}

function uidFromMetadata(object) {
  const uid = object?.metadata?.firebaseUid;
  return typeof uid === "string" && uid.length > 0 && uid.length <= 128 ? uid : null;
}

function identityFromRequest(req) {
  const uid = req?.uid || req?.auth?.uid;
  if (typeof uid !== "string" || !uid) {
    throw new BillingError("Authentication is required.", {
      status: 401,
      code: "authentication_required",
    });
  }
  return { uid, email: req?.userEmail || req?.auth?.email || null };
}

function safeRequestError(error, res, logger) {
  if (error instanceof BillingError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logger.error?.("Stripe billing request failed:", error);
  return res.status(502).json({
    error: "The billing service is temporarily unavailable.",
    code: "billing_unavailable",
  });
}

function isMissingStripeResource(error) {
  return error?.code === "resource_missing" || error?.statusCode === 404;
}

/**
 * Creates Stripe billing operations and ready-to-mount Express handlers.
 * `stripe` and Firebase Admin `auth` are injected so this module can be tested
 * without network access. `getAuth` may be used instead for lazy Firebase init.
 */
export function createStripeBilling({
  stripe = null,
  auth = null,
  getAuth = null,
  config = loadStripeBillingConfig(),
  logger = console,
  now = () => Date.now(),
} = {}) {
  if (config.enabled && !stripe) {
    throw new Error("A Stripe client is required when billing is enabled.");
  }
  if (config.enabled && !auth && typeof getAuth !== "function") {
    throw new Error("A Firebase Auth client is required when billing is enabled.");
  }

  const firebaseAuth = () => {
    const client = auth || getAuth?.();
    if (!client) throw new Error("Firebase Auth is unavailable.");
    return client;
  };
  const checkoutRequests = new Map();

  let planPromise = null;
  async function getPlan() {
    if (!config.enabled) return { planName: null, price: null };
    if (!planPromise) {
      planPromise = stripe.prices
        .retrieve(config.priceId, { expand: ["product"] })
        .then((price) => {
          if (!price?.active || !price?.recurring) {
            throw new BillingError("STRIPE_PRICE_ID must reference an active recurring price.", {
              status: 503,
              code: "billing_misconfigured",
            });
          }
          return planFromPrice(price);
        })
        .catch((error) => {
          planPromise = null;
          throw error;
        });
    }
    return planPromise;
  }

  async function updateBillingClaims(userRecordOrUid, nextBilling) {
    const authClient = firebaseAuth();
    const uid = typeof userRecordOrUid === "string" ? userRecordOrUid : userRecordOrUid.uid;
    // Re-read immediately before every claim write so unrelated claims added
    // by another request are preserved as well as the caller's snapshot.
    const userRecord = await authClient.getUser(uid);
    const existingClaims = userRecord.customClaims || {};
    const existingBilling = billingClaims(userRecord);
    const mergedBilling = Object.fromEntries(
      Object.entries({ ...existingBilling, ...nextBilling }).filter(([, value]) => value !== undefined)
    );

    if (JSON.stringify(existingBilling) !== JSON.stringify(mergedBilling)) {
      await authClient.setCustomUserClaims(userRecord.uid, {
        ...existingClaims,
        billing: mergedBilling,
      });
    }
    return { ...userRecord, customClaims: { ...existingClaims, billing: mergedBilling } };
  }

  async function retrieveSubscription(id) {
    if (!id) return null;
    try {
      return await stripe.subscriptions.retrieve(id);
    } catch (error) {
      if (isMissingStripeResource(error)) return null;
      throw error;
    }
  }

  function selectConfiguredSubscription(subscriptions) {
    const matches = subscriptions.filter((subscription) =>
      subscriptionMatchesPrice(subscription, config.priceId)
    );
    return (
      matches.find((subscription) => isActiveSubscriptionStatus(subscription.status)) ||
      matches.sort((a, b) => (b.created || 0) - (a.created || 0))[0] ||
      null
    );
  }

  async function liveConfiguredSubscription(userRecord) {
    const claims = billingClaims(userRecord);
    const claimedSubscription = await retrieveSubscription(claims.subscriptionId);
    const claimedMatches =
      claimedSubscription && subscriptionMatchesPrice(claimedSubscription, config.priceId);
    if (claimedMatches && isActiveSubscriptionStatus(claimedSubscription.status)) {
      return claimedSubscription;
    }

    const mappedCustomerId = claims.customerId || customerId(claimedSubscription?.customer);
    if (!mappedCustomerId) return claimedMatches ? claimedSubscription : null;
    const result = await stripe.subscriptions.list({ customer: mappedCustomerId, status: "all", limit: 100 });
    // An inactive cached subscription can be stale after retries, upgrades,
    // or out-of-order webhooks. Always list the customer in that case so an
    // active same-price subscription wins before access or Checkout decisions.
    return selectConfiguredSubscription(result?.data || []) || (claimedMatches ? claimedSubscription : null);
  }

  async function syncSubscriptionClaims(userRecordOrUid, subscription, { clearCheckout = false } = {}) {
    const summary = summarizeSubscription(subscription);
    return updateBillingClaims(userRecordOrUid, {
      customerId: summary.customerId,
      subscriptionId: summary.id,
      status: summary.status,
      priceId: summary.priceIds[0] || null,
      currentPeriodEnd: summary.currentPeriodEnd,
      cancelAtPeriodEnd: summary.cancelAtPeriodEnd,
      ...(clearCheckout
        ? { checkoutSessionId: undefined, checkoutSessionExpiresAt: undefined }
        : {}),
    });
  }

  async function getStatusForUser(uid) {
    if (config.state === "disabled") {
      return {
        enabled: false,
        active: true,
        status: "disabled",
        canManageBilling: false,
        planName: null,
        price: null,
      };
    }
    if (!config.enabled) {
      throw new BillingError(configurationMessage(config), {
        status: 503,
        code: "billing_misconfigured",
      });
    }

    let userRecord = await firebaseAuth().getUser(uid);
    const [plan, subscription] = await Promise.all([getPlan(), liveConfiguredSubscription(userRecord)]);
    if (subscription) userRecord = await syncSubscriptionClaims(userRecord, subscription);
    const status = subscription?.status || "none";
    return {
      enabled: true,
      active: isActiveSubscriptionStatus(status),
      status,
      canManageBilling: Boolean(billingClaims(userRecord).customerId),
      ...plan,
      subscription: publicSubscriptionSummary(subscription),
    };
  }

  async function ensureStripeCustomer(uid, email) {
    const authClient = firebaseAuth();
    let userRecord = await authClient.getUser(uid);
    const mappedCustomerId = billingClaims(userRecord).customerId;
    if (mappedCustomerId) return { customerId: mappedCustomerId, userRecord };

    const customer = await stripe.customers.create(
      {
        ...(email || userRecord.email ? { email: email || userRecord.email } : {}),
        metadata: { firebaseUid: uid },
      },
      { idempotencyKey: `firebase-customer:${uid}` }
    );
    userRecord = await updateBillingClaims(userRecord, { customerId: customer.id });
    return { customerId: customer.id, userRecord };
  }

  async function retrieveCheckoutSession(id) {
    try {
      return await stripe.checkout.sessions.retrieve(id, { expand: ["line_items"] });
    } catch (error) {
      if (isMissingStripeResource(error)) return null;
      throw error;
    }
  }

  async function clearCheckoutSessionClaims(userRecordOrUid) {
    return updateBillingClaims(userRecordOrUid, {
      checkoutSessionId: undefined,
      checkoutSessionExpiresAt: undefined,
    });
  }

  async function createCheckoutSessionForUser(uid, email) {
    await getPlan();
    let { customerId: mappedCustomerId, userRecord } = await ensureStripeCustomer(uid, email);
    const existing = await liveConfiguredSubscription(userRecord);
    if (existing && !TERMINAL_SUBSCRIPTION_STATUSES.has(existing.status)) {
      const active = isActiveSubscriptionStatus(existing.status);
      throw new BillingError(
        active
          ? "This account already has an active subscription."
          : "This account already has a subscription that needs attention. Manage it in the billing portal.",
        {
          status: 409,
          code: active ? "already_subscribed" : "subscription_needs_attention",
        }
      );
    }

    const successUrl = new URL(config.appUrl);
    successUrl.searchParams.set("checkout", "success");
    const cancelUrl = new URL(config.appUrl);
    cancelUrl.searchParams.set("checkout", "cancel");
    const checkoutParameters = {
      mode: "subscription",
      customer: mappedCustomerId,
      client_reference_id: uid,
      line_items: [{ price: config.priceId, quantity: 1 }],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      allow_promotion_codes: config.allowPromotionCodes,
      metadata: { firebaseUid: uid },
      subscription_data: { metadata: { firebaseUid: uid } },
      expand: ["line_items"],
    };

    const cached = billingClaims(userRecord);
    const cachedSessionId = cached.checkoutSessionId;
    const cachedExpiresAt = Number(cached.checkoutSessionExpiresAt);
    if (cachedSessionId) {
      const cachedSession = await retrieveCheckoutSession(cachedSessionId);
      if (
        Number.isFinite(cachedExpiresAt) &&
        reusableCheckoutSession(cachedSession, {
          parameters: checkoutParameters,
          nowSeconds: Math.floor(now() / 1000),
          expectedExpiresAt: cachedExpiresAt,
        })
      ) {
        return { url: cachedSession.url };
      }
      userRecord = await clearCheckoutSessionClaims(userRecord);
    }

    // The previous session ID advances the idempotency generation. All
    // processes observing the same Firebase claim therefore submit the same
    // Stripe request and receive the same Checkout Session. If Stripe still
    // remembers an older, now-closed idempotent response, its returned ID
    // deterministically advances the generation once more.
    let idempotencySeed = cachedSessionId || "initial";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = await stripe.checkout.sessions.create(checkoutParameters, {
        idempotencyKey: checkoutIdempotencyKey(uid, idempotencySeed, checkoutParameters),
      });
      if (
        reusableCheckoutSession(session, {
          parameters: checkoutParameters,
          nowSeconds: Math.floor(now() / 1000),
        })
      ) {
        await updateBillingClaims(userRecord, {
          checkoutSessionId: session.id,
          checkoutSessionExpiresAt: session.expires_at,
        });
        return { url: session.url };
      }
      idempotencySeed = session?.id || `${idempotencySeed}:retry:${attempt + 1}`;
    }
    throw new Error("Stripe Checkout did not return a reusable open session.");
  }

  async function createCheckoutForUser(uid, email = null) {
    if (!config.enabled) {
      throw new BillingError(configurationMessage(config), {
        status: 503,
        code: config.state === "misconfigured" ? "billing_misconfigured" : "billing_disabled",
      });
    }

    const inFlight = checkoutRequests.get(uid);
    if (inFlight) return inFlight;
    const request = createCheckoutSessionForUser(uid, email).finally(() => {
      if (checkoutRequests.get(uid) === request) checkoutRequests.delete(uid);
    });
    checkoutRequests.set(uid, request);
    return request;
  }

  async function createPortalForUser(uid) {
    if (!config.enabled) {
      throw new BillingError(configurationMessage(config), {
        status: 503,
        code: config.state === "misconfigured" ? "billing_misconfigured" : "billing_disabled",
      });
    }
    const userRecord = await firebaseAuth().getUser(uid);
    const mappedCustomerId = billingClaims(userRecord).customerId;
    if (!mappedCustomerId) {
      throw new BillingError("No Stripe billing account exists for this user yet.", {
        status: 409,
        code: "billing_account_missing",
      });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: mappedCustomerId,
      return_url: config.appUrl,
    });
    if (!session?.url) throw new Error("Stripe Billing Portal did not return a URL.");
    return { url: session.url };
  }

  async function uidForStripeObject(object, hint = null) {
    if (hint) {
      const validatedHint = uidFromMetadata({ metadata: { firebaseUid: hint } });
      if (validatedHint) return validatedHint;
    }
    const metadataUid = uidFromMetadata(object);
    if (metadataUid) return metadataUid;
    const mappedCustomerId = customerId(object?.customer);
    if (!mappedCustomerId) return null;
    const customer = await stripe.customers.retrieve(mappedCustomerId);
    return uidFromMetadata(customer);
  }

  async function processWebhookEvent(event) {
    const object = event?.data?.object;
    if (!object) return { handled: false };

    if (event.type === "checkout.session.completed") {
      const metadataUid = uidFromMetadata(object);
      const referenceUid =
        typeof object.client_reference_id === "string" ? object.client_reference_id : null;
      const subscriptionId =
        typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
      if (
        object.mode !== "subscription" ||
        !metadataUid ||
        metadataUid !== referenceUid ||
        !subscriptionId
      ) {
        return { handled: true, synced: false, ignored: true };
      }

      const subscription = await retrieveSubscription(subscriptionId);
      const sessionCustomerId = customerId(object.customer);
      const subscriptionCustomerId = customerId(subscription?.customer);
      if (
        !subscription ||
        !subscriptionMatchesPrice(subscription, config.priceId) ||
        uidFromMetadata(subscription) !== metadataUid ||
        !sessionCustomerId ||
        sessionCustomerId !== subscriptionCustomerId
      ) {
        return { handled: true, synced: false, ignored: true };
      }

      await syncSubscriptionClaims(metadataUid, subscription, { clearCheckout: true });
      return { handled: true, synced: true };
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      if (!subscriptionMatchesPrice(object, config.priceId)) {
        // A customer can have unrelated Stripe products. Those events must not
        // change this app's customer or subscription mapping.
        return { handled: true, synced: false, ignored: true };
      }
      const uid = await uidForStripeObject(object);
      if (!uid) {
        logger.warn?.(`Stripe subscription event ${event.id || "(unknown)"} has no Firebase uid.`);
        return { handled: true, synced: false };
      }
      const mappedCustomerId = customerId(object.customer);
      let userRecord = await updateBillingClaims(uid, {
        ...(mappedCustomerId ? { customerId: mappedCustomerId } : {}),
      });

      let subscriptionToSync = object;
      if (!isActiveSubscriptionStatus(object.status)) {
        const reconciled = await liveConfiguredSubscription(userRecord);
        if (reconciled) subscriptionToSync = reconciled;
      }
      await syncSubscriptionClaims(userRecord, subscriptionToSync, {
        clearCheckout: isActiveSubscriptionStatus(subscriptionToSync.status),
      });
      return { handled: true, synced: true };
    }

    return { handled: false };
  }

  const handleStatus = async (req, res) => {
    try {
      const { uid } = identityFromRequest(req);
      return res.json(await getStatusForUser(uid));
    } catch (error) {
      return safeRequestError(error, res, logger);
    }
  };

  const handleCheckout = async (req, res) => {
    try {
      const { uid, email } = identityFromRequest(req);
      return res.json(await createCheckoutForUser(uid, email));
    } catch (error) {
      return safeRequestError(error, res, logger);
    }
  };

  const handlePortal = async (req, res) => {
    try {
      const { uid } = identityFromRequest(req);
      return res.json(await createPortalForUser(uid));
    } catch (error) {
      return safeRequestError(error, res, logger);
    }
  };

  const handleWebhook = async (req, res) => {
    if (!config.enabled) {
      return res.status(503).json({
        error: configurationMessage(config),
        code: config.state === "misconfigured" ? "billing_misconfigured" : "billing_disabled",
      });
    }
    const signature = req.headers?.["stripe-signature"];
    if (!signature || !(Buffer.isBuffer(req.body) || typeof req.body === "string")) {
      return res.status(400).json({
        error: "Stripe webhook requires a signature and an unparsed request body.",
        code: "invalid_webhook",
      });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, config.webhookSecret);
    } catch {
      return res.status(400).json({
        error: "Stripe webhook signature verification failed.",
        code: "invalid_webhook_signature",
      });
    }

    try {
      const result = await processWebhookEvent(event);
      return res.json({ received: true, ...result });
    } catch (error) {
      logger.error?.("Stripe webhook processing failed:", error);
      return res.status(500).json({
        error: "Stripe webhook processing failed.",
        code: "webhook_processing_failed",
      });
    }
  };

  const requireActiveSubscription = async (req, res, next) => {
    if (config.state === "disabled") {
      req.billing = { enabled: false, active: true, status: "disabled" };
      return next();
    }
    try {
      const { uid } = identityFromRequest(req);
      const status = await getStatusForUser(uid);
      req.billing = status;
      if (!status.active) {
        return res.status(402).json({
          error: "An active subscription is required to create clips.",
          code: "subscription_required",
          status: status.status,
        });
      }
      return next();
    } catch (error) {
      return safeRequestError(error, res, logger);
    }
  };

  return {
    config,
    getStatusForUser,
    createCheckoutForUser,
    createPortalForUser,
    processWebhookEvent,
    handleStatus,
    handleCheckout,
    handlePortal,
    handleWebhook,
    requireActiveSubscription,
    handlers: {
      status: handleStatus,
      checkout: handleCheckout,
      portal: handlePortal,
      webhook: handleWebhook,
      requireActiveSubscription,
    },
  };
}

export const __testing = {
  customerId,
  planFromPrice,
  subscriptionMatchesPrice,
  summarizeSubscription,
};
