// Receive-only payment check: the customer submits a tx hash; we verify it with read-only RPC calls.
// Never holds keys, never signs or sends. Addresses and token contracts come from config.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = a => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export async function rpc(url, method, params, fetchFn = fetch) {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

// cfg: { rpcUrl, token, receiver, minConfirmations }, used: Set-like of "base|hash" already accepted
export async function verifyBaseUsdc(txHash, expectedUnits, cfg, used, fetchFn = fetch) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, reason: "bad hash" };
  const key = `base|${txHash.toLowerCase()}`;
  if (await used.has(key)) return { ok: false, reason: "already used" };
  const rcpt = await rpc(cfg.rpcUrl, "eth_getTransactionReceipt", [txHash], fetchFn);
  if (!rcpt) return { ok: false, reason: "not found" };
  if (rcpt.status !== "0x1") return { ok: false, reason: "failed tx" };
  const head = BigInt(await rpc(cfg.rpcUrl, "eth_blockNumber", [], fetchFn));
  const conf = head - BigInt(rcpt.blockNumber) + 1n;
  if (conf < BigInt(cfg.minConfirmations)) return { ok: false, reason: "not enough confirmations", confirmations: Number(conf) };
  const paid = rcpt.logs.filter(l => l.address.toLowerCase() === cfg.token.toLowerCase()
      && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === pad(cfg.receiver))
    .reduce((s, l) => s + BigInt(l.data), 0n);
  // Exact match: each order gets a unique amount, which ties the payment to that order.
  if (paid !== BigInt(expectedUnits)) return { ok: false, reason: "amount mismatch", paid: paid.toString() };
  await used.add(key);
  return { ok: true, paid: paid.toString() };
}
