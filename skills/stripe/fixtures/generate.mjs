#!/usr/bin/env node
// Generates signed test deliveries for every provider in this pack.
//
//   node fixtures/generate.mjs                 # writes fixtures/<provider>.json, signed "now"
//   node fixtures/generate.mjs --now 1800000000 --out /tmp/fx
//   node fixtures/generate.mjs --only stripe,github
//
// Every secret below is a fake, test-only value. Timestamped providers (Stripe, Paddle)
// go stale quickly: regenerate right before replaying a fixture with curl.
// Signatures are computed here with node:crypto, independently of the templates under test.
import { createHmac, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRETS = {
  stripe: "whsec_test_fixture_secret_not_real",
  shopify: "shopify_test_fixture_secret_not_real",
  github: "github_test_fixture_secret_not_real",
  paddle: "pdl_ntfset_test_fixture_secret_not_real",
  lemonsqueezy: "lemonsqueezy_test_fixture_secret",
};
export const ENV = {
  stripe: "STRIPE_WEBHOOK_SECRET",
  shopify: "SHOPIFY_API_SECRET",
  github: "GITHUB_WEBHOOK_SECRET",
  paddle: "PADDLE_WEBHOOK_SECRET",
  lemonsqueezy: "LEMONSQUEEZY_WEBHOOK_SECRET",
};

const hmac = (alg, key, data, enc) => createHmac(alg, key).update(data).digest(enc);

// ---- signers (the spec, written once) ----
export const sign = {
  // Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
  stripe: (body, secret, t) => `t=${t},v1=${hmac("sha256", secret, `${t}.${body}`, "hex")}`,
  // X-Shopify-Hmac-Sha256: base64 HMAC-SHA256(app client secret, rawBody)
  shopify: (body, secret) => hmac("sha256", secret, body, "base64"),
  // X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256(webhook secret, rawBody)
  github: (body, secret) => "sha256=" + hmac("sha256", secret, body, "hex"),
  // Paddle-Signature: ts=<unix>;h1=<hex HMAC-SHA256(secret, `${ts}:${rawBody}`)>
  paddle: (body, secret, ts) => `ts=${ts};h1=${hmac("sha256", secret, `${ts}:${body}`, "hex")}`,
  // X-Signature: hex HMAC-SHA256(signing secret, rawBody)
  lemonsqueezy: (body, secret) => hmac("sha256", secret, body, "hex"),
};

const json = o => JSON.stringify(o);
const c = (name, headers, body, expect, note) => ({ name, headers, body, expect, ...(note ? { note } : {}) });

export function build(now = Math.floor(Date.now() / 1000)) {
  const out = {};

  { // ---------- Stripe ----------
    const s = SECRETS.stripe, id = `evt_fixture_${now}`;
    const body = json({ id, object: "event", type: "checkout.session.completed", created: now,
      data: { object: { id: "cs_test_fixture", object: "checkout.session", amount_total: 1900, currency: "usd" } } });
    const h = (sig) => ({ "content-type": "application/json; charset=utf-8", "stripe-signature": sig });
    const v1 = sign.stripe(body, s, now).split("v1=")[1];
    out.stripe = { provider: "stripe", env: ENV.stripe, secret: s, generated_at: now, event_id: id, cases: [
      c("valid", h(sign.stripe(body, s, now)), body, 200),
      c("valid_multiple_v1_secret_rotation", h(`t=${now},v1=${"0".repeat(64)},v1=${v1},v0=deadbeef`), body, 200),
      c("tampered_body", h(sign.stripe(body, s, now)), body.replace("1900", "1"), 401),
      c("wrong_secret", h(sign.stripe(body, "whsec_test_some_other_secret", now)), body, 401),
      c("missing_header", { "content-type": "application/json" }, body, 401),
      c("stale_timestamp_600s", h(sign.stripe(body, s, now - 600)), body, 401, "outside 300 s tolerance"),
      c("future_timestamp_600s", h(sign.stripe(body, s, now + 600)), body, 401),
      c("reserialized_json", h(sign.stripe(body, s, now)), JSON.stringify(JSON.parse(body), null, 2), 401, "pretty-printed body = what a JSON parser + re-stringify would produce"),
    ] };
  }
  { // ---------- Shopify ----------
    const s = SECRETS.shopify, wid = `b54557e4-fixture-${now}`;
    const body = json({ id: 820982911946154500, email: "jon@example.com", total_price: "9.00" });
    const h = (sig, extra = {}) => ({ "content-type": "application/json", "x-shopify-hmac-sha256": sig,
      "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "fixture.myshopify.com", "x-shopify-webhook-id": wid,
      "x-shopify-event-id": `evt-${wid}`, "x-shopify-triggered-at": new Date(now * 1000).toISOString(), ...extra });
    out.shopify = { provider: "shopify", env: ENV.shopify, secret: s, generated_at: now, event_id: wid, cases: [
      c("valid", h(sign.shopify(body, s)), body, 200),
      c("tampered_body", h(sign.shopify(body, s)), body.replace("9.00", "0.00"), 401),
      c("wrong_secret", h(sign.shopify(body, "other_secret")), body, 401),
      c("missing_header", (({ "x-shopify-hmac-sha256": _, ...r }) => r)(h("")), body, 401),
      c("hex_instead_of_base64", h(hmac("sha256", s, body, "hex")), body, 401, "Shopify sends base64, not hex"),
    ] };
  }
  { // ---------- GitHub ----------
    const s = SECRETS.github, did = `72d3162e-cc78-11e3-81ab-${String(now).padStart(12, "0")}`;
    const body = json({ action: "opened", number: 1, repository: { full_name: "octo/fixture" } });
    const h = (sig, name = "x-hub-signature-256") => ({ "content-type": "application/json", [name]: sig,
      "x-github-event": "pull_request", "x-github-delivery": did, "x-github-hook-id": "1" });
    const good = sign.github(body, s);
    out.github = { provider: "github", env: ENV.github, secret: s, generated_at: now, event_id: did, cases: [
      c("valid", h(good), body, 200),
      c("tampered_body", h(good), body.replace("opened", "closed"), 401),
      c("wrong_secret", h(sign.github(body, "other")), body, 401),
      c("missing_header", (({ "x-hub-signature-256": _, ...r }) => r)(h(good)), body, 401),
      c("missing_sha256_prefix", h(good.slice(7)), body, 401),
      c("legacy_sha1_only", h("sha1=" + hmac("sha1", s, body, "hex"), "x-hub-signature"), body, 401, "X-Hub-Signature (SHA-1) alone is not accepted"),
    ] };
  }
  { // ---------- Paddle Billing ----------
    const s = SECRETS.paddle, id = `evt_01fixture${now}`;
    const body = json({ event_id: id, event_type: "transaction.completed", occurred_at: new Date(now * 1000).toISOString(),
      notification_id: `ntf_01fixture${now}`, data: { id: "txn_01fixture", status: "completed" } });
    const h = sig => ({ "content-type": "application/json", "paddle-signature": sig });
    const h1 = sign.paddle(body, s, now).split("h1=")[1];
    out.paddle = { provider: "paddle", env: ENV.paddle, secret: s, generated_at: now, event_id: id, cases: [
      c("valid", h(sign.paddle(body, s, now)), body, 200),
      c("valid_multiple_h1_secret_rotation", h(`ts=${now};h1=${"0".repeat(64)};h1=${h1}`), body, 200),
      c("tampered_body", h(sign.paddle(body, s, now)), body.replace("completed", "canceled"), 401),
      c("wrong_secret", h(sign.paddle(body, "pdl_ntfset_test_other", now)), body, 401),
      c("missing_header", { "content-type": "application/json" }, body, 401),
      c("stale_timestamp_60s", h(sign.paddle(body, s, now - 60)), body, 401, "outside 5 s default tolerance"),
      c("body_only_signed", h(`ts=${now};h1=${hmac("sha256", s, body, "hex")}`), body, 401, "common mistake: signing body without ts:"),
    ] };
  }
  { // ---------- Lemon Squeezy ----------
    const s = SECRETS.lemonsqueezy;
    const body = json({ meta: { event_name: "order_created", custom_data: { user_id: "42" } },
      data: { type: "orders", id: String(now), attributes: { status: "paid", total: 1900 } } });
    const h = sig => ({ "content-type": "application/json", "x-event-name": "order_created", "x-signature": sig });
    out.lemonsqueezy = { provider: "lemonsqueezy", env: ENV.lemonsqueezy, secret: s, generated_at: now,
      event_id: "sha256:" + createHash("sha256").update(body).digest("hex"), cases: [
      c("valid", h(sign.lemonsqueezy(body, s)), body, 200),
      c("tampered_body", h(sign.lemonsqueezy(body, s)), body.replace("1900", "19"), 401),
      c("wrong_secret", h(sign.lemonsqueezy(body, "other_secret")), body, 401),
      c("missing_header", { "content-type": "application/json", "x-event-name": "order_created" }, body, 401),
      c("base64_instead_of_hex", h(hmac("sha256", s, body, "base64")), body, 401),
    ] };
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const now = arg("--now") ? Number(arg("--now")) : undefined;
  const dir = arg("--out") || dirname(fileURLToPath(import.meta.url));
  mkdirSync(dir, { recursive: true });
  const only = arg("--only");
  const all = build(now), names = only ? only.split(",") : Object.keys(all);
  for (const p of names) writeFileSync(join(dir, `${p}.json`), JSON.stringify(all[p], null, 2) + "\n");
  console.log(`wrote ${names.length} fixture file(s) to ${dir}`);
}
