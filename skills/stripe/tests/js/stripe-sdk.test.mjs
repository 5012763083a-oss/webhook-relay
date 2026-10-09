// Stripe publishes no fixed vector, so cross-check against the official stripe-node SDK in both directions.
import test from "node:test";
import assert from "node:assert/strict";
import { sign } from "../../fixtures/generate.mjs";
import { verifyStripeSignature } from "../../templates/express/stripe.js";

test("stripe: official stripe-node SDK agrees with the template and the fixture signer", async () => {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe("sk_test_placeholder_for_offline_use");
  const secret = "whsec_test_fixture_secret_not_real", payload = '{"id":"evt_x","object":"event","type":"invoice.paid"}';
  const t = Math.floor(Date.now() / 1000), B = (s) => Buffer.from(s, "utf8");
  assert.equal(verifyStripeSignature(B(payload), stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: t }), secret).ok, true);
  assert.equal(stripe.webhooks.constructEvent(payload, sign.stripe(payload, secret, t), secret).id, "evt_x");
  assert.throws(() => stripe.webhooks.constructEvent(payload, sign.stripe(payload, secret, t - 600), secret), /tolerance/i);
  assert.equal(verifyStripeSignature(B(payload), sign.stripe(payload, secret, t - 600), secret).ok, false);
});
