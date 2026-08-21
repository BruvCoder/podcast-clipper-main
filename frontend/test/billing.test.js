import assert from "node:assert/strict";
import test from "node:test";

import {
  billingNeedsPortal,
  priceDetails,
  subscriptionIsActive,
} from "../src/billing.js";

test("recognizes active access and routes recoverable billing states to the portal", () => {
  assert.equal(subscriptionIsActive({ enabled: true, status: "trialing" }), true);
  assert.equal(subscriptionIsActive({ enabled: true, status: "past_due" }), false);
  assert.equal(
    billingNeedsPortal({ enabled: true, status: "past_due", canManageBilling: true }),
    true
  );
  assert.equal(
    billingNeedsPortal({ enabled: true, status: "canceled", canManageBilling: true }),
    false
  );
});

test("formats Stripe minor units including zero-decimal and compatibility currencies", () => {
  assert.equal(priceDetails({ price: { unitAmount: 1_200, currency: "usd" } }).majorAmount, 12);
  assert.equal(priceDetails({ price: { unitAmount: 500, currency: "jpy" } }).majorAmount, 500);
  assert.equal(priceDetails({ price: { unitAmount: 500, currency: "isk" } }).majorAmount, 5);
  assert.equal(priceDetails({ price: { unitAmount: 500, currency: "ugx" } }).majorAmount, 5);
});
