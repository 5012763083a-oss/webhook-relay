import test from "node:test"; import assert from "node:assert/strict"; import { createHmac } from "node:crypto";
import { verifyStripe, discordMessage, sheetsRow, fanOut } from "../src/stripe.js";
import { Relay } from "../src/relay-core.js";
const SEC = "whsec_test", enc = s => new TextEncoder().encode(s);
const hdr = (body, t) => `t=${t},v1=${createHmac("sha256", SEC).update(`${t}.${body}`).digest("hex")}`;
const ev = { id: "evt_1", type: "checkout.session.completed", created: 1760000000,
  data: { object: { amount_total: 2500, currency: "usd", customer_details: { email: "buyer@example.com" } } } };
const body = JSON.stringify(ev);
test("stripe: valid signature accepted", async () => assert.equal(await verifyStripe(enc(body), hdr(body, 1000), SEC, 1000), true));
test("stripe: expired timestamp rejected", async () => assert.equal(await verifyStripe(enc(body), hdr(body, 1000), SEC, 1301), false));
test("stripe: tampered body rejected", async () => assert.equal(await verifyStripe(enc(body + " "), hdr(body, 1000), SEC, 1000), false));
test("stripe: discord format", () => assert.equal(discordMessage(ev).content, "💰 New payment: **25.00 USD** from buyer@example.com (`evt_1`)"));
test("stripe: sheets row", () => assert.deepEqual(sheetsRow(ev).row, ["2025-10-09T08:53:20.000Z", "checkout.session.completed", "25.00 USD", "buyer@example.com", "evt_1"]));
const env = { DISCORD_WEBHOOK_URL: "d", SHEETS_WEBAPP_URL: "s" };
function relayWith(sender) { const c = { t: 0 };
  return [new Relay({ secrets: { "stripe:discord": "x", "stripe:sheets": "x" }, targets: { "stripe:discord": "D", "stripe:sheets": "S" }, sender, clock: () => c.t, cbCooldown: 0 }), c]; }
async function push(r, e) { for (const o of fanOut(e, env)) await r.enqueue(`stripe:${o.target}`, enc(o.body), o.idem); }
test("stripe: duplicate event delivered once per output", async () => { const sent = []; const [r] = relayWith(async t => (sent.push(t), true));
  await push(r, ev); await push(r, ev); await r.tick(); assert.deepEqual(sent.sort(), ["D", "S"]); });
test("stripe: discord down -> retried, sheets still gets its row", async () => { const sent = []; let up = false;
  const [r, c] = relayWith(async t => { sent.push(t); return t === "S" || up; });
  await push(r, ev); await r.tick(); assert.ok(sent.includes("S"));
  up = true; c.t += 10; await r.tick(); assert.equal(sent.filter(t => t === "D").length, 2);
  assert.ok(r.listEvents("stripe:discord")[1].every(e => e.status === "delivered")); });
test("stripe: ignores unlisted event types", () => assert.equal(fanOut({ ...ev, type: "customer.created" }, env).length, 0));
