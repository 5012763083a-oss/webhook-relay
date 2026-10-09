#!/usr/bin/env node
// Real-world compile check for the Next.js templates (not part of `npm test`: it downloads Next.js and takes minutes).
//   node scripts/next-build-check.mjs                 -> Next 15 and Next 16 (latest of each major)
//   node scripts/next-build-check.mjs 15.5.27 16.4.0  -> exact versions
// For each version it creates a throwaway app in the OS temp dir (outside this pack), installs next/react/typescript,
// copies every Next.js template in this pack to app/api/webhooks/<provider>/route.ts and runs, with BOTH strict:false (the tsconfig Next
// generates itself) and strict:true:  tsc --noEmit  and  next build.  Exit code 0 only if every step passes.
// Set NEXT_CHECK_KEEP=1 to keep the temp apps (prints their paths).
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDERS = ["stripe", "shopify", "github", "paddle", "lemonsqueezy"].filter((p) => existsSync(join(ROOT, "templates/nextjs", p, "route.ts")));
const versions = process.argv.slice(2).length ? process.argv.slice(2) : ["15", "16"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function sh(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CI: "1", ...env } });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const tsconfig = (strict) => ({
  compilerOptions: {
    target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true, skipLibCheck: true, strict, noEmit: true,
    esModuleInterop: true, module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, isolatedModules: true,
    jsx: "preserve", incremental: false, plugins: [{ name: "next" }], paths: { "@/*": ["./*"] },
  },
  include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"], exclude: ["node_modules"],
});

const results = []; let failed = 0;
for (const v of versions) {
  const app = mkdtempSync(join(tmpdir(), `skillpack-next${v.split(".")[0]}-`));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "skillpack-next-check", private: true }, null, 2));
  const inst = sh(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", `next@${v}`, `react@${v.startsWith("14") ? "18" : "19"}`,
    `react-dom@${v.startsWith("14") ? "18" : "19"}`, "typescript@5", "@types/node@20", "@types/react@19"], app);
  if (!inst.ok) { console.log(`npm install next@${v} FAILED\n${inst.out}`); failed++; continue; }
  const resolved = JSON.parse(readFileSync(join(app, "node_modules/next/package.json"), "utf8")).version;
  mkdirSync(join(app, "app"), { recursive: true });
  writeFileSync(join(app, "app/layout.tsx"), "export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang=\"en\"><body>{children}</body></html>;\n}\n");
  writeFileSync(join(app, "app/page.tsx"), "export default function Page() { return <p>ok</p>; }\n");
  writeFileSync(join(app, "next-env.d.ts"), '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
  writeFileSync(join(app, "next.config.mjs"), "export default {};\n");
  for (const p of PROVIDERS) {
    mkdirSync(join(app, "app/api/webhooks", p), { recursive: true });
    copyFileSync(join(ROOT, "templates/nextjs", p, "route.ts"), join(app, "app/api/webhooks", p, "route.ts"));
  }
  for (const strict of [false, true]) {
    writeFileSync(join(app, "tsconfig.json"), JSON.stringify(tsconfig(strict), null, 2));
    const tsc = sh(process.execPath, [join(app, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"], app);
    rmSync(join(app, ".next"), { recursive: true, force: true });
    const build = sh(process.execPath, [join(app, "node_modules/next/dist/bin/next"), "build"], app);
    const routesOk = build.ok && PROVIDERS.every((p) => build.out.includes(`/api/webhooks/${p}`));
    for (const [step, r, ok] of [["tsc --noEmit", tsc, tsc.ok], ["next build", build, routesOk]]) {
      results.push(`next@${resolved} strict:${strict} ${step}: ${ok ? "PASS" : "FAIL"}`);
      if (!ok) { failed++; console.log(`--- next@${resolved} strict:${strict} ${step} output ---\n${r.out.slice(-4000)}`); }
    }
  }
  if (process.env.NEXT_CHECK_KEEP) console.log(`kept ${app}`); else rmSync(app, { recursive: true, force: true });
}
console.log(results.join("\n"));
console.log(failed ? `NEXT BUILD CHECK FAILED (${failed})` : `NEXT BUILD CHECK PASSED (${results.length} checks, ${PROVIDERS.length} routes each)`);
process.exit(failed ? 1 : 0);
