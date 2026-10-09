// Receive-only payment check. Server creates the order (amount + start block); the customer
// submits only order_id + tx_hash. Never holds keys, never signs or sends.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = a => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const HASH_RE = /^0x[0-9a-fA-F]{64}$/, ID_RE = /^[0-9a-f]{32}$/;

export async function rpc(url, method, params, fetchFn = fetch) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

// store: { orders: {id: order}, claims: {key: order_id} } -- plain objects, mutated synchronously
export class Payments {
  constructor({ cfg, store = { orders: {}, claims: {} }, fetchFn = fetch, clock = () => Date.now() / 1000, ttl = 1800, grace = 600, retention = 604800,
                rand = () => Math.floor(Math.random() * 9999) + 1 }) {
    store.late ||= []; Object.assign(this, { cfg, store, fetchFn, clock, ttl, grace, retention, rand });
  }
  // Old orders can't be reused: a new order's start block rules out older txs, so pruning claims is safe.
  prune() {
    const now = this.clock(), cut = now - this.retention;
    for (const o of Object.values(this.store.orders))
      if (o.expires_at + this.grace < cut) {
        delete this.store.orders[o.id];
        for (const [k, v] of Object.entries(this.store.claims)) if (v === o.id) delete this.store.claims[k];
      }
    this.store.late = this.store.late.filter(l => l.at >= cut);
  }
  async createOrder(priceUnits) {
    if (!/^[0-9]+$/.test(String(priceUnits)) || BigInt(priceUnits) <= 0n) return [400, { error: "bad price" }];
    const startBlock = Number(BigInt(await rpc(this.cfg.rpcUrl, "eth_blockNumber", [], this.fetchFn)));
    const now = this.clock(), open = new Set(Object.values(this.store.orders)
      .filter(o => o.status === "open" && o.expires_at > now).map(o => o.amount));
    let amount, tries = 0;
    do { amount = (BigInt(priceUnits) + BigInt(this.rand())).toString(); } while (open.has(amount) && ++tries < 50);
    if (open.has(amount)) return [503, { error: "no unique amount available" }];
    const id = crypto.randomUUID().replace(/-/g, "");
    this.store.orders[id] = { id, amount, start_block: startBlock, expires_at: now + this.ttl, status: "open" };
    const disp = (BigInt(amount) / 1000000n) + "." + (BigInt(amount) % 1000000n).toString().padStart(6, "0");
    return [201, { order_id: id, amount: disp, receiver: this.cfg.receiver, amount_units: amount, pay_to: this.cfg.receiver, token: this.cfg.token, expires_at: now + this.ttl }];
  }
  async verify(orderId, txHash) {
    if (typeof orderId !== "string" || !ID_RE.test(orderId) || typeof txHash !== "string" || !HASH_RE.test(txHash))
      return [400, { error: "bad input" }];
    const o = this.store.orders[orderId];
    if (!o) return [404, { error: "unknown order" }];
    if (o.status === "paid") return [409, { error: "order already paid" }];
    if (this.clock() > o.expires_at + this.grace) {
      if (!this.store.late.some(l => l.tx === txHash.toLowerCase()))
        this.store.late.push({ order_id: orderId, tx: txHash.toLowerCase(), at: this.clock() });
      return [410, { error: "order expired; flagged for manual review, not credited" }];
    }
    const key = `base|${txHash.toLowerCase()}`;
    // Claim synchronously BEFORE any await, so concurrent requests can't both pass.
    if (this.store.claims[key]) return [409, { error: "already used" }];
    this.store.claims[key] = orderId;
    let res;
    try { res = await this.#check(o, txHash); } catch (e) { res = { ok: false, reason: "rpc error" }; }
    if (!res.ok) { delete this.store.claims[key]; return [402, res]; }
    if (o.status === "paid") { delete this.store.claims[key]; return [409, { error: "order already paid" }]; }
    o.status = "paid"; o.tx = txHash.toLowerCase();
    return [200, { ok: true, order_id: orderId, paid: res.paid }];
  }
  async #check(o, txHash) {
    const c = this.cfg, rcpt = await rpc(c.rpcUrl, "eth_getTransactionReceipt", [txHash], this.fetchFn);
    if (!rcpt) return { ok: false, reason: "not found" };
    if (rcpt.status !== "0x1") return { ok: false, reason: "failed tx" };
    const blk = BigInt(rcpt.blockNumber);
    if (blk <= BigInt(o.start_block)) return { ok: false, reason: "payment predates order" };
    const head = BigInt(await rpc(c.rpcUrl, "eth_blockNumber", [], this.fetchFn));
    if (head - blk + 1n < BigInt(c.minConfirmations)) return { ok: false, reason: "not enough confirmations" };
    const paid = rcpt.logs.filter(l => l.address.toLowerCase() === c.token.toLowerCase()
        && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === pad(c.receiver))
      .reduce((s, l) => s + BigInt(l.data), 0n);
    if (paid !== BigInt(o.amount)) return { ok: false, reason: "amount mismatch" };
    return { ok: true, paid: paid.toString() };
  }
}
