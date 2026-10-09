import test from "node:test"; import assert from "node:assert/strict"; import { createHmac } from "node:crypto";
import { Relay } from "../src/relay-core.js";
import { Payments } from "../src/payments.js";
import { adminOk } from "../src/auth.js";
const enc = s => new TextEncoder().encode(s), sig = s => createHmac("sha256", "sec").update(s).digest("hex");
function mk(sender, o = {}) { const c = { t: 0 }; return [new Relay({ secrets: { src: "sec" }, targets: { src: "http://t" }, sender, clock: () => c.t, ...o }), c]; }
async function drain(r, c, n = 50) { for (let i = 0; i < n; i++) { await r.tick(); c.t += 100; } }

test("valid signature stored", async () => { const [r] = mk(async () => true);
  const [code, b] = await r.ingest("src", enc("{}"), sig("{}")); assert.equal(code, 202); assert.equal(r.listEvents("src")[1][0].id, b.event_id); });
test("bad signature 401", async () => { const [r] = mk(async () => true); assert.equal((await r.ingest("src", enc("{}"), "nope"))[0], 401); });
test("dead letter after 5", async () => { let n = 0; const [r, c] = mk(async () => (n++, false), { cbCooldown: 0 });
  await r.ingest("src", enc("x"), sig("x")); await drain(r, c); assert.equal(n, 5); assert.equal(r.dead.length, 1); });
test("breaker opens and closes", async () => { let n = 0; const [r, c] = mk(async () => (n++, false), { baseDelay: 0, cbCooldown: 30 });
  await r.ingest("src", enc("x"), sig("x")); for (let i = 0; i < 3; i++) await r.tick();
  assert.equal(n, 3); assert.ok(r.breakerOpen("http://t")); await r.tick(); assert.equal(n, 3);
  c.t += 30; assert.ok(!r.breakerOpen("http://t")); await r.tick(); assert.equal(n, 4); });
test("idempotency single delivery", async () => { let n = 0; const [r, c] = mk(async () => (n++, true));
  for (let i = 0; i < 3; i++) await r.ingest("src", enc("x"), sig("x"), "k1"); await drain(r, c, 3); assert.equal(n, 1); });
test("rate limit 429", async () => { const [r] = mk(async () => true, { rpm: 2 });
  const codes = []; for (let i = 0; i < 3; i++) codes.push((await r.ingest("src", enc(`${i}`), sig(`${i}`)))[0]); assert.deepEqual(codes, [202, 202, 429]); });
test("replay redelivers", async () => { let n = 0; const [r] = mk(async () => (n++, true));
  const id = (await r.ingest("src", enc("x"), sig("x")))[1].event_id; await r.tick(); r.replay(id); await r.tick(); assert.equal(n, 2); });
test("retention purge", async () => { const [r, c] = mk(async () => true, { retention: 10 });
  await r.ingest("src", enc("x"), sig("x"), "k"); await r.tick(); c.t += 11; await r.tick();
  assert.equal(Object.keys(r.events).length, 0); assert.equal(Object.keys(r.idem).length, 0); assert.equal(r.delivered.size, 0); });
test("state survives JSON round trip", async () => { let n = 0; const [r, c] = mk(async () => (n++, true));
  await r.ingest("src", enc("x"), sig("x"), "k"); const r2 = new Relay({ ...r, state: JSON.parse(JSON.stringify(r)) });
  assert.equal((await r2.ingest("src", enc("x"), sig("x"), "k"))[1].duplicate, true); });

// ---- payment check (simulated Base RPC, example values only) ----
const TOKEN = "0x" + "a".repeat(40), RECV = "0x" + "b".repeat(40), H1 = "0x" + "1".repeat(64);
const cfg = { rpcUrl: "http://rpc", token: TOKEN, receiver: RECV, minConfirmations: 10 };
// chain: { head, txs: {hash: {status, block, value, to, token}} }; delay lets us force interleaving
function chain(c, delay = 0) {
  return async (_u, o) => { const { method, params } = JSON.parse(o.body); if (delay) await new Promise(r => setTimeout(r, delay));
    let result;
    if (method === "eth_blockNumber") result = "0x" + c.head.toString(16);
    else { const t = c.txs[params[0]]; result = t && { status: t.status ?? "0x1", blockNumber: "0x" + t.block.toString(16),
      logs: [{ address: t.token ?? TOKEN, data: "0x" + BigInt(t.value).toString(16),
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(64), "0x" + (t.to ?? RECV).slice(2).padStart(64, "0")] }] }; }
    return { json: async () => ({ result }) }; }; }
async function setup(over = {}, delay = 0) {
  const c = { head: 100, txs: {} }, clk = { t: 0 }; let n = 0;
  const p = new Payments({ cfg, fetchFn: chain(c, delay), clock: () => clk.t, rand: () => ++n });
  const [, o] = await p.createOrder("1000000");
  c.head = 120; c.txs[H1] = { block: 110, value: o.amount_units, ...over };
  return { p, c, clk, o };
}
test("pay: server sets amount; valid payment accepted", async () => { const { p, o } = await setup();
  assert.equal(o.amount_units, "1000001"); assert.equal((await p.verify(o.order_id, H1))[0], 200); });
test("pay: stranger can't claim someone else's payment", async () => { const { p, o } = await setup();
  const [, o2] = await p.createOrder("1000000");                 // stranger's own order, different amount
  assert.equal((await p.verify(o2.order_id, H1))[0], 402);
  assert.equal((await p.verify(o.order_id, H1))[0], 200);        // real payer still succeeds
});
test("pay: two simultaneous claims -> exactly one wins", async () => { const { p, o } = await setup({}, 5);
  const [, o2] = await p.createOrder("1000000"); p.store.orders[o2.order_id].amount = o.amount_units; // worst case: same amount
  const codes = (await Promise.all([p.verify(o.order_id, H1), p.verify(o2.order_id, H1)])).map(r => r[0]).sort();
  assert.deepEqual(codes, [200, 409]); });
test("pay: payment made before the order is rejected", async () => { const { p, o } = await setup({ block: 90 });
  assert.equal((await p.verify(o.order_id, H1))[1].reason, "payment predates order"); });
test("pay: late payment inside 10-min grace accepted", async () => { const { p, o, clk } = await setup(); clk.t = 1800 + 599; assert.equal((await p.verify(o.order_id, H1))[0], 200); });
test("pay: after grace -> 410, flagged, not credited", async () => { const { p, o, clk } = await setup(); clk.t = 2401;
  assert.equal((await p.verify(o.order_id, H1))[0], 410); assert.equal(p.store.late.length, 1);
  assert.equal(p.store.orders[o.order_id].status, "open"); assert.equal(Object.keys(p.store.claims).length, 0); });
test("pay: prune removes old orders and their claims", async () => { const { p, o, clk } = await setup(); await p.verify(o.order_id, H1);
  clk.t = 1800 + 600 + 604800 + 1; p.prune(); assert.equal(Object.keys(p.store.orders).length, 0); assert.equal(Object.keys(p.store.claims).length, 0); });
test("pay: hash reuse on a second order rejected", async () => { const { p, o } = await setup(); await p.verify(o.order_id, H1);
  const [, o2] = await p.createOrder("1000000"); assert.equal((await p.verify(o2.order_id, H1))[0], 409); });
test("pay: failed check releases the claim", async () => { const { p, o, c } = await setup({ block: 115 }); c.head = 116;
  assert.equal((await p.verify(o.order_id, H1))[1].reason, "not enough confirmations");
  c.head = 130; assert.equal((await p.verify(o.order_id, H1))[0], 200); });
test("pay: wrong receiver / token / failed tx", async () => {
  for (const [over, why] of [[{ to: "0x" + "c".repeat(40) }, "amount mismatch"], [{ token: "0x" + "d".repeat(40) }, "amount mismatch"], [{ status: "0x0" }, "failed tx"]]) {
    const { p, o } = await setup(over); assert.equal((await p.verify(o.order_id, H1))[1].reason, why); } });
test("pay: bad input 400", async () => { const { p, o } = await setup();
  for (const [a, b] of [[o.order_id, "0x12"], ["nope", H1], [undefined, undefined], [o.order_id, 5]]) assert.equal((await p.verify(a, b))[0], 400);
  assert.equal((await p.createOrder("-5"))[0], 400); });
test("pay: paid order can't be paid twice", async () => { const { p, o, c } = await setup(); await p.verify(o.order_id, H1);
  const H2 = "0x" + "2".repeat(64); c.txs[H2] = { block: 111, value: o.amount_units }; assert.equal((await p.verify(o.order_id, H2))[0], 409); });

const areq = h => new Request("https://x/events/src", { headers: h ? { authorization: h } : {} });
test("admin: /events and /replay need the token", () => {
  const env = { ADMIN_TOKEN: "t0ken" };
  assert.equal(adminOk(areq(), env), false); assert.equal(adminOk(areq("Bearer wrong"), env), false);
  assert.equal(adminOk(areq("Bearer t0ken"), env), true); assert.equal(adminOk(areq("Bearer t0ken"), {}), false); });

test("pay: order response matches the landing page fields", async () => { const { o } = await setup();
  assert.equal(o.amount, "1.000001"); assert.equal(o.receiver, RECV); });
