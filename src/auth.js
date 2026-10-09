export function adminOk(req, env) {
  const want = env.ADMIN_TOKEN, got = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!want || got.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i); return d === 0;
}
