import assert from "node:assert/strict";
import test from "node:test";

import {
  createStripeBilling,
  isActiveSubscriptionStatus,
  loadStripeBillingConfig,
} from "../src/lib/stripeBilling.js";

function configured(overrides = {}) {
  return loadStripeBillingConfig({
    BILLING_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_PRICE_ID: "price_pro",
    APP_URL: "https://clipper.example/app",
    ...overrides,
  });
}

function createAuth({
  uid = "firebase-user-1",
  email = "user@example.test",
  customClaims = { role: "editor" },
} = {}) {
  let user = { uid, email, customClaims: structuredClone(customClaims) };
  const writes = [];
  return {
    writes,
    get user() {
      return structuredClone(user);
    },
    async getUser(requestedUid) {
      assert.equal(requestedUid, uid);
      return structuredClone(user);
    },
    async setCustomUserClaims(requestedUid, claims) {
      assert.equal(requestedUid, uid);
      writes.push(structuredClone(claims));
      user = { ...user, customClaims: structuredClone(claims) };
    },
  };
}

function recurringPrice(overrides = {}) {
  return {
    id: "price_pro",
    active: true,
    currency: "usd",
    unit_amount: 1900,
    recurring: { interval: "month", interval_count: 1 },
    product: { id: "prod_pro", name: "VOD Clipper Pro" },
    ...overrides,
  };
}

function subscription(overrides = {}) {
  return {
    id: "sub_pro",
    customer: "cus_user",
    status: "active",
    created: 100,
    current_period_end: 2_000_000_000,
    cancel_at_period_end: false,
    metadata: { firebaseUid: "firebase-user-1" },
    items: { data: [{ price: { id: "price_pro" } }] },
    ...overrides,
  };
}

function checkoutSession(overrides = {}) {
  return {
    id: "cs_cached",
    url: "https://checkout.stripe.test/cached",
    status: "open",
    mode: "subscription",
    customer: "cus_user",
    client_reference_id: "firebase-user-1",
    metadata: { firebaseUid: "firebase-user-1" },
    success_url: "https://clipper.example/app?checkout=success",
    cancel_url: "https://clipper.example/app?checkout=cancel",
    allow_promotion_codes: false,
    expires_at: 2_000_000_000,
    line_items: { data: [{ price: { id: "price_pro" } }] },
    ...overrides,
  };
}

function createStripe({
  price = recurringPrice(),
  subscriptionsById = {},
  listedSubscriptions = [],
  checkoutSessionsById = {},
  checkoutSessionFactory = null,
  webhookEvent = null,
} = {}) {
  const createdCheckoutSessions = new Map();
  const idempotentCheckoutSessions = new Map();
  const calls = {
    priceRetrieve: [],
    subscriptionRetrieve: [],
    subscriptionList: [],
    customerCreate: [],
    customerRetrieve: [],
    checkoutCreate: [],
    checkoutCreateOptions: [],
    checkoutRetrieve: [],
    portalCreate: [],
    constructEvent: [],
  };
  const stripe = {
    calls,
    prices: {
      async retrieve(...args) {
        calls.priceRetrieve.push(args);
        return structuredClone(price);
      },
    },
    subscriptions: {
      async retrieve(id) {
        calls.subscriptionRetrieve.push(id);
        const value = subscriptionsById[id];
        if (value instanceof Error) throw value;
        if (!value) {
          throw Object.assign(new Error("missing"), { code: "resource_missing" });
        }
        return structuredClone(value);
      },
      async list(args) {
        calls.subscriptionList.push(structuredClone(args));
        return { data: structuredClone(listedSubscriptions) };
      },
    },
    customers: {
      async create(...args) {
        calls.customerCreate.push(structuredClone(args));
        return { id: "cus_created" };
      },
      async retrieve(id) {
        calls.customerRetrieve.push(id);
        return { id, metadata: { firebaseUid: "firebase-user-1" } };
      },
    },
    checkout: {
      sessions: {
        async create(args, options = {}) {
          calls.checkoutCreate.push(structuredClone(args));
          calls.checkoutCreateOptions.push(structuredClone(options));
          if (options.idempotencyKey && idempotentCheckoutSessions.has(options.idempotencyKey)) {
            return structuredClone(await idempotentCheckoutSessions.get(options.idempotencyKey));
          }
          const callNumber = calls.checkoutCreate.length;
          const creation = Promise.resolve().then(() =>
            checkoutSessionFactory
              ? checkoutSessionFactory(args, options, callNumber)
              : {
                  id: callNumber === 1 ? "cs_test" : `cs_test_${callNumber}`,
                  url: "https://checkout.stripe.test/session",
                  status: "open",
                  mode: args.mode,
                  customer: args.customer,
                  client_reference_id: args.client_reference_id,
                  metadata: structuredClone(args.metadata),
                  success_url: args.success_url,
                  cancel_url: args.cancel_url,
                  allow_promotion_codes: args.allow_promotion_codes,
                  expires_at: 2_000_000_000,
                  line_items: {
                    data: args.line_items.map((item) => ({ price: { id: item.price } })),
                  },
                }
          );
          if (options.idempotencyKey) idempotentCheckoutSessions.set(options.idempotencyKey, creation);
          const value = await creation;
          createdCheckoutSessions.set(value.id, structuredClone(value));
          return structuredClone(value);
        },
        async retrieve(id, args) {
          calls.checkoutRetrieve.push([id, structuredClone(args)]);
          const value = checkoutSessionsById[id] || createdCheckoutSessions.get(id);
          if (value instanceof Error) throw value;
          if (!value) throw Object.assign(new Error("missing"), { code: "resource_missing" });
          return structuredClone(value);
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(args) {
          calls.portalCreate.push(structuredClone(args));
          return { id: "bps_test", url: "https://billing.stripe.test/session" };
        },
      },
    },
    webhooks: {
      constructEvent(...args) {
        calls.constructEvent.push(args);
        if (webhookEvent instanceof Error) throw webhookEvent;
        return webhookEvent;
      },
    },
  };
  return stripe;
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("billing is opt-in, but malformed BILLING_ENABLED fails closed", () => {
  assert.deepEqual(loadStripeBillingConfig({}), {
    enabled: false,
    state: "disabled",
    appUrl: null,
  });

  const malformed = loadStripeBillingConfig({ BILLING_ENABLED: "maybe" });
  assert.equal(malformed.enabled, false);
  assert.equal(malformed.state, "misconfigured");
  assert.match(malformed.missing[0], /BILLING_ENABLED/);

  const partial = loadStripeBillingConfig({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test" });
  assert.equal(partial.enabled, false);
  assert.equal(partial.state, "misconfigured");
  assert.deepEqual(partial.missing, ["STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "APP_URL"]);

  const credentialRedirect = configured({ APP_URL: "https://user:secret@clipper.example" });
  assert.equal(credentialRedirect.state, "misconfigured");
  assert.match(credentialRedirect.missing[0], /APP_URL/);
});

test("only active and trialing Stripe statuses grant access", () => {
  assert.equal(isActiveSubscriptionStatus("active"), true);
  assert.equal(isActiveSubscriptionStatus("trialing"), true);
  for (const status of ["past_due", "unpaid", "paused", "canceled", "incomplete", null]) {
    assert.equal(isActiveSubscriptionStatus(status), false);
  }
});

test("disabled billing reports local access and lets job middleware continue", async () => {
  const billing = createStripeBilling({ config: loadStripeBillingConfig({}) });
  assert.deepEqual(await billing.getStatusForUser("any-user"), {
    enabled: false,
    active: true,
    status: "disabled",
    canManageBilling: false,
    planName: null,
    price: null,
  });

  const req = {};
  const res = createResponse();
  let nextCalled = false;
  await billing.requireActiveSubscription(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.billing, { enabled: false, active: true, status: "disabled" });
});

test("billing status handler still requires an authenticated Firebase identity", async () => {
  const billing = createStripeBilling({ config: loadStripeBillingConfig({}) });
  const res = createResponse();
  await billing.handleStatus({}, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "authentication_required");
});

test("an explicitly enabled but incomplete configuration blocks job creation", async () => {
  const billing = createStripeBilling({
    config: loadStripeBillingConfig({ BILLING_ENABLED: "true" }),
  });
  const res = createResponse();
  let nextCalled = false;
  await billing.requireActiveSubscription(
    { uid: "firebase-user-1" },
    res,
    () => (nextCalled = true)
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "billing_misconfigured");
});

test("status is based on a live matching Stripe subscription and returns dynamic plan data", async () => {
  const auth = createAuth({
    customClaims: {
      role: "editor",
      billing: { customerId: "cus_user", subscriptionId: "sub_pro", status: "past_due" },
    },
  });
  const live = subscription({ status: "trialing" });
  const stripe = createStripe({ subscriptionsById: { sub_pro: live } });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const status = await billing.getStatusForUser("firebase-user-1");
  assert.equal(status.enabled, true);
  assert.equal(status.active, true);
  assert.equal(status.status, "trialing");
  assert.equal(status.canManageBilling, true);
  assert.equal(status.planName, "VOD Clipper Pro");
  assert.deepEqual(status.price, {
    id: "price_pro",
    unitAmount: 1900,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
  });
  assert.equal(status.subscription.id, "sub_pro");
  assert.equal("customerId" in status.subscription, false, "Stripe customer IDs are not public status data");
  assert.equal(stripe.calls.subscriptionRetrieve.length, 1);
  assert.equal(auth.writes.at(-1).role, "editor", "unrelated Firebase claims must be preserved");
  assert.equal(auth.writes.at(-1).billing.status, "trialing");
});

test("an active subscription for a different price never grants access", async () => {
  const wrongPlan = subscription({
    id: "sub_other",
    items: { data: [{ price: { id: "price_other" } }] },
  });
  const auth = createAuth({
    customClaims: { billing: { customerId: "cus_user", subscriptionId: "sub_other" } },
  });
  const stripe = createStripe({
    subscriptionsById: { sub_other: wrongPlan },
    listedSubscriptions: [wrongPlan],
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const status = await billing.getStatusForUser("firebase-user-1");
  assert.equal(status.active, false);
  assert.equal(status.status, "none");
  assert.equal(status.subscription, null);
  assert.deepEqual(stripe.calls.subscriptionList[0], {
    customer: "cus_user",
    status: "all",
    limit: 100,
  });
});

test("status recovers a configured subscription from the customer when cached claims are stale", async () => {
  const configuredPlan = subscription({ id: "sub_found", status: "active", created: 200 });
  const auth = createAuth({ customClaims: { billing: { customerId: "cus_user" } } });
  const stripe = createStripe({ listedSubscriptions: [configuredPlan] });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const status = await billing.getStatusForUser("firebase-user-1");
  assert.equal(status.active, true);
  assert.equal(status.subscription.id, "sub_found");
  assert.equal(auth.user.customClaims.billing.subscriptionId, "sub_found");
});

test("an active same-price subscription wins over an inactive claimed subscription", async () => {
  const oldCanceled = subscription({ id: "sub_old", status: "canceled", created: 100 });
  const currentActive = subscription({ id: "sub_current", status: "active", created: 200 });
  const auth = createAuth({
    customClaims: {
      billing: {
        customerId: "cus_user",
        subscriptionId: "sub_old",
        status: "canceled",
      },
    },
  });
  const stripe = createStripe({
    subscriptionsById: { sub_old: oldCanceled },
    listedSubscriptions: [oldCanceled, currentActive],
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const status = await billing.getStatusForUser("firebase-user-1");
  assert.equal(status.active, true);
  assert.equal(status.status, "active");
  assert.equal(status.subscription.id, "sub_current");
  assert.equal(auth.user.customClaims.billing.subscriptionId, "sub_current");
});

test("status computes billing-management access from the post-sync Firebase record", async () => {
  const auth = createAuth({
    customClaims: { billing: { subscriptionId: "sub_pro" } },
  });
  const stripe = createStripe({ subscriptionsById: { sub_pro: subscription() } });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const status = await billing.getStatusForUser("firebase-user-1");
  assert.equal(status.canManageBilling, true);
  assert.equal(auth.user.customClaims.billing.customerId, "cus_user");
});

test("checkout creates a mapped Stripe customer and a server-selected subscription session", async () => {
  const auth = createAuth();
  const stripe = createStripe();
  const billing = createStripeBilling({
    stripe,
    auth,
    config: configured({ STRIPE_ALLOW_PROMOTION_CODES: "true" }),
  });

  const result = await billing.createCheckoutForUser("firebase-user-1", "verified@example.test");
  assert.deepEqual(result, { url: "https://checkout.stripe.test/session" });
  assert.deepEqual(stripe.calls.customerCreate[0], [
    { email: "verified@example.test", metadata: { firebaseUid: "firebase-user-1" } },
    { idempotencyKey: "firebase-customer:firebase-user-1" },
  ]);
  assert.equal(auth.user.customClaims.role, "editor");
  assert.equal(auth.user.customClaims.billing.customerId, "cus_created");

  const checkout = stripe.calls.checkoutCreate[0];
  assert.equal(checkout.mode, "subscription");
  assert.equal(checkout.customer, "cus_created");
  assert.deepEqual(checkout.line_items, [{ price: "price_pro", quantity: 1 }]);
  assert.equal(checkout.allow_promotion_codes, true);
  assert.equal(checkout.client_reference_id, "firebase-user-1");
  assert.deepEqual(checkout.subscription_data.metadata, { firebaseUid: "firebase-user-1" });
  assert.equal(new URL(checkout.success_url).searchParams.get("checkout"), "success");
  assert.equal(new URL(checkout.cancel_url).searchParams.get("checkout"), "cancel");
  assert.match(stripe.calls.checkoutCreateOptions[0].idempotencyKey, /^vod-clipper-checkout:/);
  assert.equal(auth.user.customClaims.billing.checkoutSessionId, "cs_test");
  assert.equal(auth.user.customClaims.billing.checkoutSessionExpiresAt, 2_000_000_000);
  assert.equal("checkoutSessionUrl" in auth.user.customClaims.billing, false);
});

test("same-process concurrent checkout requests share one Stripe operation", async () => {
  const auth = createAuth();
  let releases;
  const waitForRelease = new Promise((resolve) => {
    releases = resolve;
  });
  let factoryCalls = 0;
  const stripe = createStripe({
    checkoutSessionFactory: async (args) => {
      factoryCalls += 1;
      await waitForRelease;
      return checkoutSession({
        id: "cs_concurrent",
        customer: args.customer,
        client_reference_id: args.client_reference_id,
        metadata: args.metadata,
        line_items: { data: [{ price: { id: args.line_items[0].price } }] },
      });
    },
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const requests = Array.from({ length: 5 }, () =>
    billing.createCheckoutForUser("firebase-user-1")
  );
  releases();
  const results = await Promise.all(requests);

  assert.equal(factoryCalls, 1);
  assert.equal(stripe.calls.checkoutCreate.length, 1);
  assert.deepEqual(new Set(results.map((result) => result.url)), new Set(["https://checkout.stripe.test/cached"]));
});

test("separate billing instances converge on one idempotent Checkout Session", async () => {
  const auth = createAuth();
  let factoryCalls = 0;
  const stripe = createStripe({
    checkoutSessionFactory: async (args) => {
      factoryCalls += 1;
      await Promise.resolve();
      return checkoutSession({
        id: "cs_cross_process",
        customer: args.customer,
        client_reference_id: args.client_reference_id,
        metadata: args.metadata,
        line_items: { data: [{ price: { id: args.line_items[0].price } }] },
      });
    },
  });
  const firstProcess = createStripeBilling({ stripe, auth, config: configured() });
  const secondProcess = createStripeBilling({ stripe, auth, config: configured() });

  const [first, second] = await Promise.all([
    firstProcess.createCheckoutForUser("firebase-user-1"),
    secondProcess.createCheckoutForUser("firebase-user-1"),
  ]);

  assert.equal(factoryCalls, 1, "Stripe idempotency creates only one underlying session");
  assert.equal(first.url, second.url);
  const keys = new Set(stripe.calls.checkoutCreateOptions.map((options) => options.idempotencyKey));
  assert.equal(keys.size, 1);
  assert.equal(auth.user.customClaims.billing.checkoutSessionId, "cs_cross_process");
});

test("a new process retrieves and reuses the open session cached in Firebase claims", async () => {
  const auth = createAuth();
  const stripe = createStripe();
  const firstProcess = createStripeBilling({ stripe, auth, config: configured() });
  const first = await firstProcess.createCheckoutForUser("firebase-user-1");
  assert.equal(stripe.calls.checkoutCreate.length, 1);

  const restartedProcess = createStripeBilling({ stripe, auth, config: configured() });
  const afterRestart = await restartedProcess.createCheckoutForUser("firebase-user-1");

  assert.deepEqual(afterRestart, first);
  assert.equal(stripe.calls.checkoutCreate.length, 1, "restart must not create another session");
  assert.deepEqual(stripe.calls.checkoutRetrieve[0], ["cs_test", { expand: ["line_items"] }]);
});

test("an APP_URL change invalidates the cached session and changes the idempotency key", async () => {
  const auth = createAuth();
  const stripe = createStripe();
  const original = createStripeBilling({ stripe, auth, config: configured() });
  await original.createCheckoutForUser("firebase-user-1");
  const originalKey = stripe.calls.checkoutCreateOptions[0].idempotencyKey;

  const movedApp = createStripeBilling({
    stripe,
    auth,
    config: configured({ APP_URL: "https://new-origin.example/studio" }),
  });
  await movedApp.createCheckoutForUser("firebase-user-1");

  assert.equal(stripe.calls.checkoutCreate.length, 2);
  assert.equal(auth.user.customClaims.billing.checkoutSessionId, "cs_test_2");
  assert.notEqual(stripe.calls.checkoutCreateOptions[1].idempotencyKey, originalKey);
  assert.equal(
    stripe.calls.checkoutCreate[1].success_url,
    "https://new-origin.example/studio?checkout=success"
  );
  assert.equal(
    stripe.calls.checkoutCreate[1].cancel_url,
    "https://new-origin.example/studio?checkout=cancel"
  );
});

test("a promotion-code config change invalidates reuse and changes the idempotency key", async () => {
  const auth = createAuth();
  const stripe = createStripe();
  const promotionsOff = createStripeBilling({ stripe, auth, config: configured() });
  await promotionsOff.createCheckoutForUser("firebase-user-1");
  const originalKey = stripe.calls.checkoutCreateOptions[0].idempotencyKey;

  const promotionsOn = createStripeBilling({
    stripe,
    auth,
    config: configured({ STRIPE_ALLOW_PROMOTION_CODES: "true" }),
  });
  await promotionsOn.createCheckoutForUser("firebase-user-1");

  assert.equal(stripe.calls.checkoutCreate.length, 2);
  assert.equal(stripe.calls.checkoutCreate[0].allow_promotion_codes, false);
  assert.equal(stripe.calls.checkoutCreate[1].allow_promotion_codes, true);
  assert.notEqual(stripe.calls.checkoutCreateOptions[1].idempotencyKey, originalKey);
  assert.equal(auth.user.customClaims.billing.checkoutSessionId, "cs_test_2");
});

test("an invalid cached session is cleared before a fresh session is cached", async () => {
  const auth = createAuth({
    customClaims: {
      role: "editor",
      billing: {
        customerId: "cus_user",
        checkoutSessionId: "cs_wrong_price",
        checkoutSessionExpiresAt: 2_000_000_000,
      },
    },
  });
  const stripe = createStripe({
    checkoutSessionsById: {
      cs_wrong_price: checkoutSession({
        id: "cs_wrong_price",
        line_items: { data: [{ price: { id: "price_other" } }] },
      }),
    },
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  await billing.createCheckoutForUser("firebase-user-1");

  assert.equal(auth.writes.length >= 2, true);
  const cleared = auth.writes.find(
    (claims) => !Object.hasOwn(claims.billing, "checkoutSessionId")
  );
  assert.ok(cleared, "the invalid pointer is removed before replacement");
  assert.equal(cleared.role, "editor");
  assert.equal(auth.user.customClaims.billing.checkoutSessionId, "cs_test");
});

test("an expired cached session advances the idempotency generation", async () => {
  const auth = createAuth({
    customClaims: {
      billing: {
        customerId: "cus_user",
        checkoutSessionId: "cs_expired",
        checkoutSessionExpiresAt: 1_700_000_000,
      },
    },
  });
  const stripe = createStripe({
    checkoutSessionsById: {
      cs_expired: checkoutSession({
        id: "cs_expired",
        status: "expired",
        expires_at: 1_700_000_000,
      }),
    },
  });
  const billing = createStripeBilling({
    stripe,
    auth,
    config: configured(),
    now: () => 1_800_000_000_000,
  });

  await billing.createCheckoutForUser("firebase-user-1");
  assert.equal(auth.user.customClaims.billing.checkoutSessionId, "cs_test");
  assert.notEqual(
    stripe.calls.checkoutCreateOptions[0].idempotencyKey,
    "vod-clipper-checkout:initial"
  );
});

test("checkout refuses to create a duplicate active subscription", async () => {
  const auth = createAuth({
    customClaims: { billing: { customerId: "cus_user", subscriptionId: "sub_pro" } },
  });
  const stripe = createStripe({ subscriptionsById: { sub_pro: subscription() } });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  await assert.rejects(
    billing.createCheckoutForUser("firebase-user-1"),
    (error) => error.code === "already_subscribed" && error.status === 409
  );
  assert.equal(stripe.calls.checkoutCreate.length, 0);
});

test("checkout gate finds an active same-price subscription behind a stale canceled claim", async () => {
  const oldCanceled = subscription({ id: "sub_old", status: "canceled", created: 100 });
  const currentActive = subscription({ id: "sub_current", status: "active", created: 200 });
  const auth = createAuth({
    customClaims: {
      billing: { customerId: "cus_user", subscriptionId: "sub_old", status: "canceled" },
    },
  });
  const stripe = createStripe({
    subscriptionsById: { sub_old: oldCanceled },
    listedSubscriptions: [oldCanceled, currentActive],
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  await assert.rejects(
    billing.createCheckoutForUser("firebase-user-1"),
    (error) => error.code === "already_subscribed" && error.status === 409
  );
  assert.equal(stripe.calls.checkoutCreate.length, 0);
});

test("checkout sends a nonterminal inactive subscription to billing management instead of duplicating it", async () => {
  const auth = createAuth({
    customClaims: { billing: { customerId: "cus_user", subscriptionId: "sub_pro" } },
  });
  const stripe = createStripe({
    subscriptionsById: { sub_pro: subscription({ status: "past_due" }) },
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  await assert.rejects(
    billing.createCheckoutForUser("firebase-user-1"),
    (error) => error.code === "subscription_needs_attention" && error.status === 409
  );
  assert.equal(stripe.calls.checkoutCreate.length, 0);
});

test("portal session uses only the authenticated user's mapped customer", async () => {
  const auth = createAuth({ customClaims: { billing: { customerId: "cus_user" } } });
  const stripe = createStripe();
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  assert.deepEqual(await billing.createPortalForUser("firebase-user-1"), {
    url: "https://billing.stripe.test/session",
  });
  assert.deepEqual(stripe.calls.portalCreate[0], {
    customer: "cus_user",
    return_url: "https://clipper.example/app",
  });
});

test("signed subscription webhooks sync billing claims without replacing existing claims", async () => {
  const auth = createAuth();
  const event = {
    id: "evt_subscription",
    type: "customer.subscription.updated",
    data: { object: subscription({ status: "past_due" }) },
  };
  const stripe = createStripe({ webhookEvent: event });
  const billing = createStripeBilling({ stripe, auth, config: configured() });
  const req = {
    headers: { "stripe-signature": "t=1,v1=signature" },
    body: Buffer.from('{"id":"evt_subscription"}'),
  };
  const res = createResponse();

  await billing.handleWebhook(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true, handled: true, synced: true });
  assert.equal(stripe.calls.constructEvent[0][0], req.body);
  assert.equal(stripe.calls.constructEvent[0][1], "t=1,v1=signature");
  assert.equal(stripe.calls.constructEvent[0][2], "whsec_example");
  assert.equal(auth.user.customClaims.role, "editor");
  assert.equal(auth.user.customClaims.billing.status, "past_due");
});

test("an out-of-order canceled webhook cannot displace the active subscription mapping", async () => {
  const currentActive = subscription({ id: "sub_current", status: "active", created: 200 });
  const oldCanceled = subscription({ id: "sub_old", status: "canceled", created: 100 });
  const auth = createAuth({
    customClaims: {
      role: "editor",
      billing: {
        customerId: "cus_user",
        subscriptionId: "sub_current",
        status: "active",
      },
    },
  });
  const stripe = createStripe({ subscriptionsById: { sub_current: currentActive } });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const result = await billing.processWebhookEvent({
    id: "evt_old_cancel",
    type: "customer.subscription.deleted",
    data: { object: oldCanceled },
  });

  assert.deepEqual(result, { handled: true, synced: true });
  assert.equal(auth.user.customClaims.billing.subscriptionId, "sub_current");
  assert.equal(auth.user.customClaims.billing.status, "active");
  assert.equal(auth.user.customClaims.role, "editor");
});

test("a wrong-price subscription webhook cannot replace another product's customer mapping", async () => {
  const auth = createAuth({
    customClaims: {
      role: "editor",
      billing: {
        customerId: "cus_vod",
        subscriptionId: "sub_vod",
        status: "active",
        priceId: "price_pro",
      },
    },
  });
  const before = auth.user.customClaims;
  const stripe = createStripe();
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const result = await billing.processWebhookEvent({
    id: "evt_other_product",
    type: "customer.subscription.updated",
    data: {
      object: subscription({
        id: "sub_other",
        customer: "cus_other_product",
        items: { data: [{ price: { id: "price_other" } }] },
      }),
    },
  });

  assert.deepEqual(result, { handled: true, synced: false, ignored: true });
  assert.deepEqual(auth.user.customClaims, before);
  assert.equal(auth.writes.length, 0);
});

test("a wrong-product Checkout completion preserves every existing Firebase claim", async () => {
  const auth = createAuth({
    customClaims: {
      role: "editor",
      billing: {
        customerId: "cus_vod",
        subscriptionId: "sub_vod",
        status: "active",
        priceId: "price_pro",
        checkoutSessionId: "cs_vod",
        checkoutSessionExpiresAt: 2_000_000_000,
      },
    },
  });
  const before = auth.user.customClaims;
  const otherSubscription = subscription({
    id: "sub_other",
    customer: "cus_other_product",
    items: { data: [{ price: { id: "price_other" } }] },
  });
  const stripe = createStripe({ subscriptionsById: { sub_other: otherSubscription } });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const result = await billing.processWebhookEvent({
    id: "evt_other_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_other",
        mode: "subscription",
        customer: "cus_other_product",
        client_reference_id: "firebase-user-1",
        metadata: { firebaseUid: "firebase-user-1" },
        subscription: "sub_other",
      },
    },
  });

  assert.deepEqual(result, { handled: true, synced: false, ignored: true });
  assert.deepEqual(auth.user.customClaims, before);
  assert.equal(auth.writes.length, 0);
});

test("completed Checkout webhook clears the persisted open-session pointer", async () => {
  const auth = createAuth({
    customClaims: {
      role: "editor",
      billing: {
        customerId: "cus_user",
        checkoutSessionId: "cs_completed",
        checkoutSessionExpiresAt: 2_000_000_000,
      },
    },
  });
  const stripe = createStripe({ subscriptionsById: { sub_pro: subscription() } });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const result = await billing.processWebhookEvent({
    id: "evt_checkout",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_completed",
        mode: "subscription",
        customer: "cus_user",
        client_reference_id: "firebase-user-1",
        metadata: { firebaseUid: "firebase-user-1" },
        subscription: "sub_pro",
      },
    },
  });

  assert.deepEqual(result, { handled: true, synced: true });
  assert.equal(Object.hasOwn(auth.user.customClaims.billing, "checkoutSessionId"), false);
  assert.equal(Object.hasOwn(auth.user.customClaims.billing, "checkoutSessionExpiresAt"), false);
  assert.equal(auth.user.customClaims.role, "editor");
});

test("webhook handler rejects parsed bodies and invalid signatures", async () => {
  const auth = createAuth();
  const stripe = createStripe({ webhookEvent: new Error("bad signature") });
  const billing = createStripeBilling({ stripe, auth, config: configured() });

  const parsedResponse = createResponse();
  await billing.handleWebhook(
    { headers: { "stripe-signature": "signature" }, body: { already: "parsed" } },
    parsedResponse
  );
  assert.equal(parsedResponse.statusCode, 400);
  assert.equal(parsedResponse.body.code, "invalid_webhook");

  const signedResponse = createResponse();
  await billing.handleWebhook(
    { headers: { "stripe-signature": "bad" }, body: Buffer.from("{}") },
    signedResponse
  );
  assert.equal(signedResponse.statusCode, 400);
  assert.equal(signedResponse.body.code, "invalid_webhook_signature");
});

test("job middleware fails closed for inactive configured subscriptions", async () => {
  const auth = createAuth({
    customClaims: { billing: { customerId: "cus_user", subscriptionId: "sub_pro" } },
  });
  const stripe = createStripe({
    subscriptionsById: { sub_pro: subscription({ status: "past_due" }) },
  });
  const billing = createStripeBilling({ stripe, auth, config: configured() });
  const res = createResponse();
  let nextCalled = false;

  await billing.requireActiveSubscription(
    { uid: "firebase-user-1" },
    res,
    () => (nextCalled = true)
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.code, "subscription_required");
  assert.equal(res.body.status, "past_due");
});
