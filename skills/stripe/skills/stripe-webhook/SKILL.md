---
name: stripe-webhook
description: Write or fix a Stripe webhook endpoint (Stripe-Signature verification, raw body, 300 s replay window, idempotency by event.id, fast 2xx). Use when adding, debugging or reviewing any route that receives Stripe events in Express, Next.js App Router or FastAPI, or when you see "No signatures found matching the expected signature".
---

# Stripe webhooks

Working templates (tested against signed fixtures) are in `templates/` next to this file:
`express.js`, `nextjs-route.ts` (save as `app/api/webhooks/stripe/route.ts`), `fastapi.py`. Start from them.

## Non-negotiables
1. **Raw body.** Verify the exact bytes Stripe sent, before any JSON parsing.
   - Express: `express.raw({ type: "*/*" })` on this route, registered **before** `app.use(express.json())`. Parsing then re-stringifying changes the bytes.
   - Next.js App Router: `Buffer.from(await request.arrayBuffer())`, never `request.json()` first. `export const runtime = "nodejs"`.
   - FastAPI: `raw = await request.body()`; no Pydantic model parameter on this route.
2. **Signature.** Header `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`.
   `expected = hex(HMAC-SHA256(key=STRIPE_WEBHOOK_SECRET, msg = t + "." + rawBody))`.
   Accept if **any** `v1` matches (several appear during secret rotation). Ignore `v0`.
   Or use the SDK: `stripe.webhooks.constructEvent(raw, sig, secret)` (pass the raw Buffer) / `stripe.Webhook.construct_event(...)`.
3. **Timing-safe compare:** `crypto.timingSafeEqual` (check lengths first) / `hmac.compare_digest`. Never `===`/`==`.
4. **Replay window:** reject if `|now - t| > 300` s (the SDK default). Keep server clocks on NTP.
5. **Secret:** `STRIPE_WEBHOOK_SECRET` from env (`whsec_...`). Each Dashboard endpoint and each `stripe listen` session has its **own** secret. Never hard-code it or paste a live one into files.
6. **Idempotency:** dedupe on `event.id` with a DB unique constraint (or Redis SET NX, TTL > 3 days). Duplicates must still get 2xx. Mark an event **processed** only after the job succeeds (dedupe records it as *received*; a failed job must stay unprocessed so it can be retried).
7. **Fast 2xx, async work:** verify, store/enqueue, return 200; do fulfilment in a worker/queue. Failed signature: 401. Missing secret: 500 (fail closed, never 2xx).
8. **Retries:** live mode retries with exponential backoff for up to 3 days; sandbox only a few times over a few hours. Events can arrive out of order: re-fetch the object from the API if ordering matters.

## Common errors
- "No signatures found matching the expected signature for payload": body was parsed/modified, or wrong secret (CLI vs Dashboard). https://webhook-relay.gmitchell-relay.workers.dev/errors/no-signatures-found , https://webhook-relay.gmitchell-relay.workers.dev/errors/express-raw-body , https://webhook-relay.gmitchell-relay.workers.dev/errors/nextjs-stripe-webhook-signature
- "Timestamp outside the tolerance zone": clock skew or a replayed/old request. https://webhook-relay.gmitchell-relay.workers.dev/errors/timestamp-outside-tolerance
- Redirect 307/308 (trailing slash, http to https, auth middleware): Stripe treats it as failure. Point the endpoint at the final URL and exclude it from auth/i18n middleware. https://webhook-relay.gmitchell-relay.workers.dev/errors/stripe-webhook-redirect-307-308
- Timeouts / duplicate events: https://webhook-relay.gmitchell-relay.workers.dev/errors/stripe-webhook-timeout , https://webhook-relay.gmitchell-relay.workers.dev/errors/stripe-webhook-duplicate-events
- `checkout.session.completed` never arrives: endpoint not subscribed to that event, or wrong mode/account. https://webhook-relay.gmitchell-relay.workers.dev/errors/stripe-checkout-session-completed-not-received

## Done checklist
raw body, v1 HMAC over `t.body`, any-v1 match, constant-time compare, 300 s window, env secret, event.id dedupe, 2xx before slow work, processed only after the job succeeds, 401 on bad signature, test with `stripe listen --forward-to` + `stripe trigger checkout.session.completed`.
