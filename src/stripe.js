// Stripe source: verify Stripe-Signature, then fan each event out to Discord + Google Sheets.
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
function safeEq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
export const EVENTS = ["checkout.session.completed", "invoice.paid", "charge.refunded", "invoice.payment_failed"];

export async function verifyStripe(rawBody, header, secret, now = Date.now() / 1000, tolerance = 300) {
  if (!header || !secret) return false;
  let t, v1 = [];
  for (const kv of header.split(",")) { const [k, v] = kv.split("="); if (k === "t") t = Number(v); if (k === "v1") v1.push(v); }
  if (!t || !v1.length || Math.abs(now - t) > tolerance) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${new TextDecoder().decode(rawBody)}`)));
  return v1.some(s => safeEq(s, want));
}
const money = (amt, cur) => `${(Number(amt || 0) / 100).toFixed(2)} ${String(cur || "usd").toUpperCase()}`;
function summary(ev) {
  const o = ev.data?.object || {};
  const amt = o.amount_total ?? o.amount_paid ?? o.amount_refunded ?? o.amount_due ?? o.amount;
  const who = o.customer_details?.email || o.customer_email || o.billing_details?.email || o.customer || "unknown";
  return { amount: money(amt, o.currency), who };
}
export function discordMessage(ev) {
  const { amount, who } = summary(ev);
  const label = { "checkout.session.completed": "💰 New payment", "invoice.paid": "💰 Invoice paid",
    "charge.refunded": "↩️ Refund", "invoice.payment_failed": "⚠️ Payment failed" }[ev.type] || ev.type;
  return { content: `${label}: **${amount}** from ${who} (\`${ev.id}\`)` };
}
export function sheetsRow(ev) {
  const { amount, who } = summary(ev);
  return { row: [new Date(ev.created * 1000).toISOString(), ev.type, amount, who, ev.id] };
}
// Returns [{target, body, idem}] — each output becomes its own relay event with its own retries.
export function fanOut(ev, env) {
  if (!EVENTS.includes(ev.type)) return [];
  const out = [];
  if (env.DISCORD_WEBHOOK_URL) out.push({ target: "discord", body: JSON.stringify(discordMessage(ev)), idem: `${ev.id}:discord` });
  if (env.SHEETS_WEBAPP_URL) out.push({ target: "sheets", body: JSON.stringify(sheetsRow(ev)), idem: `${ev.id}:sheets` });
  return out;
}
