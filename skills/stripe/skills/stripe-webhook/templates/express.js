// Stripe webhook handler for Express 4/5 (ESM). Zero dependencies beyond express.
//
// Mount this router BEFORE any global body parser:
//   import { router as stripeWebhook } from "./webhooks/stripe.js";
//   app.use(stripeWebhook);        // first
//   app.use(express.json());       // after
// Env: STRIPE_WEBHOOK_SECRET  (whsec_..., from the Dashboard endpoint or `stripe listen`)
// Prefer the official SDK if you already use it: stripe.webhooks.constructEvent(rawBody, sig, secret)
// is equivalent to verifyStripeSignature() below.
import express from "express";
import crypto from "node:crypto";

const TOLERANCE_SECONDS = 300; // Stripe SDK default

export function verifyStripeSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  let t = null; const v1 = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1.push(v); // ignore v0 (test-mode legacy) and unknown schemes
  }
  if (!t || !/^\d+$/.test(t) || v1.length === 0) return { ok: false, reason: "malformed Stripe-Signature header" };
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  if (!v1.some((sig) => timingSafeEqualStr(sig, expected))) return { ok: false, reason: "no signature matches (wrong secret or modified body)" };
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };
  return { ok: true };
}
function timingSafeEqualStr(a, b) {
  const A = Buffer.from(a, "utf8"), B = Buffer.from(b, "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Idempotency. In-memory is fine for a single process in dev; in production use a table with a
// UNIQUE constraint on event id (INSERT ... ON CONFLICT DO NOTHING) or Redis SET NX with a TTL > retry window (3 days).
// `seen` records deliveries as RECEIVED. Mark an event PROCESSED (in your DB) only after the job succeeds, so a failed job can be retried.
const seen = new Set();
async function processEvent(event) {
  switch (event.type) {
    case "checkout.session.completed": /* fulfil the order */ break;
    case "invoice.paid": break;
    case "customer.subscription.deleted": break;
    default: break; // ignore unhandled types; still 2xx so Stripe stops retrying
  }
}
function enqueue(event) {
  // Ack fast, work later. Replace with a durable queue (BullMQ, SQS, Cloudflare Queues, a jobs table)
  // so work survives a crash after the 2xx has been sent.
  setImmediate(() => processEvent(event).catch((err) => console.error("stripe webhook job failed", event.id, err)));
}

export const router = express.Router();
router.post("/webhooks/stripe", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET not set" });
  if (!Buffer.isBuffer(req.body)) return res.status(500).json({ error: "raw body unavailable: mount this router before express.json()" });

  const result = verifyStripeSignature(req.body, req.get("stripe-signature"), secret);
  if (!result.ok) return res.status(401).json({ error: result.reason });

  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).json({ error: "invalid JSON" }); }
  if (!event || typeof event.id !== "string") return res.status(400).json({ error: "missing event id" });

  if (seen.has(event.id)) return res.status(200).json({ received: true, duplicate: true });
  seen.add(event.id);
  enqueue(event);
  return res.status(200).json({ received: true });
});

export function createApp() { const app = express(); app.use(router); return app; }
export default createApp;
