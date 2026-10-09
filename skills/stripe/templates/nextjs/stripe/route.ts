// Stripe webhook route for the Next.js App Router.
// Save as: app/api/webhooks/stripe/route.ts   ->  POST https://your-app/api/webhooks/stripe
// Env: STRIPE_WEBHOOK_SECRET (whsec_...). Read the body with request.arrayBuffer(), NEVER request.json()
// before verifying. Make sure middleware does not redirect this path (307/308 = failed delivery).
// SDK alternative: stripe.webhooks.constructEvent(Buffer.from(await request.arrayBuffer()), sig, secret).
import crypto from "node:crypto";

export const runtime = "nodejs";          // node:crypto; not the Edge runtime
export const dynamic = "force-dynamic";

const TOLERANCE_SECONDS = 300; // Stripe SDK default

type Verdict = { ok: true } | { ok: false; reason: string };

function timingSafeEqualStr(a: string, b: string): boolean {
  const A = Buffer.from(a, "utf8"), B = Buffer.from(b, "utf8");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Not exported on purpose: a route.ts may only export route fields (POST, GET, runtime, dynamic, ...); `next build` rejects others.
function verifyStripeSignature(rawBody: Buffer, header: string | null, secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)): Verdict {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  let t: string | null = null; const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("="); if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") v1.push(v);
  }
  if (!t || !/^\d+$/.test(t) || v1.length === 0) return { ok: false, reason: "malformed Stripe-Signature header" };
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  if (!v1.some((sig) => timingSafeEqualStr(sig, expected))) return { ok: false, reason: "no signature matches (wrong secret or modified body)" };
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };
  return { ok: true };
}

// Idempotency: in-memory only survives one warm instance. On Vercel/serverless use your DB
// (UNIQUE event id, INSERT ... ON CONFLICT DO NOTHING) or Redis SET NX with a TTL > 3 days.
// `seen` records deliveries as RECEIVED. Mark an event PROCESSED (in your DB) only after the job succeeds, so a failed job can be retried.
const seen = new Set<string>();

async function processEvent(event: { id: string; type: string; data?: unknown }): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": break;
    case "invoice.paid": break;
    default: break;
  }
}
function enqueue(event: { id: string; type: string }): void {
  // Ack fast, work later. On Next.js 15.1+ you can use `after(() => processEvent(event))` from "next/server";
  // on serverless, prefer a durable queue (Inngest, QStash, SQS, a jobs table) so work survives the response.
  void Promise.resolve().then(() => processEvent(event)).catch((err) => console.error("stripe webhook job failed", event.id, err));
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "STRIPE_WEBHOOK_SECRET not set" }, { status: 500 });

  const rawBody = Buffer.from(await request.arrayBuffer());
  const verdict = verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), secret);
  if (verdict.ok === false) return Response.json({ error: verdict.reason }, { status: 401 });

  let event: { id: string; type: string };
  try { event = JSON.parse(rawBody.toString("utf8")); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!event || typeof event.id !== "string") return Response.json({ error: "missing event id" }, { status: 400 });

  if (seen.has(event.id)) return Response.json({ received: true, duplicate: true }, { status: 200 });
  seen.add(event.id);
  enqueue(event);
  return Response.json({ received: true }, { status: 200 });
}
