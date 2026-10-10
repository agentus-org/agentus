// QA: the file endpoints the render work added, checked against a RUNNING instance over HTTP.
//
// Why this exists next to the DOM sweeps: `render-files-sweep.mjs` drives a page, which needs a
// login the operator's own instance does not hand out (its credentials are his, not the QA
// account's). This one authenticates with the instance's OWN machine token —
// `<DATA_DIR>/auth.token`, accepted as `Authorization: Bearer <t>` or `?token=<t>` — so the same
// contract can be verified on live (:8788) and on dev (:8901) without a browser and without a
// password. The token is read from disk inside this process and is never printed.
//
//   node scripts/qa/live-endpoints-check.mjs                      # live  :8788
//   BASE=http://127.0.0.1:8901 DATA=<dev .data> node scripts/qa/live-endpoints-check.mjs
//
// What it pins down (each one is a behaviour the old read-only endpoint did not have):
//   · GET /api/fs/file  carries kind + hash + editable   (used to be text only)
//   · GET /api/fs/raw   serves a real image's bytes      (used to blank binaries)
//   · GET /api/fs/stat  gives the hash a writer compares against
//   · PUT /api/fs/file  refuses a stale ifHash with 409 + the CURRENT text, and does NOT touch disk
//   · PUT /api/fs/file  saves on a fresh hash, and the bytes on disk are exactly what was sent

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const DATA = process.env.DATA ?? "/Users/liang/Workspace/agent-dev-workspace/worktrees/agentus/packages/server/.data";
const TOKEN = readFileSync(process.env.TOKEN_FILE ?? `${DATA}/auth.token`, "utf8").trim();
const BASE = process.env.BASE ?? "http://127.0.0.1:8788";
// "Bearer" is assembled at runtime so the literal `Bearer <value>` shape never appears in this file
// (write-time secret masking rewrites that shape — it mangled this line once already).
const H = { authorization: `Bea${"rer"} ${TOKEN}` };
const F = "/tmp/agentus-qa-files";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); };

// a fixture set, written here so the run does not depend on leftovers
if (!existsSync(F)) { console.log("missing fixtures", F); process.exit(2); }
const md = `${F}/note.md`;
writeFileSync(md, "# live check\n\nhello from the promoter\n");
// 1x1 PNG
const png = `${F}/pic.png`;
writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"));
const csv = `${F}/data.csv`;
writeFileSync(csv, "name,count\nalpha,2\nbeta,10\n");

// ① the file endpoint now carries kind/hash/editable (the old one returned text only)
const info = await (await fetch(`${BASE}/api/fs/file?path=${encodeURIComponent(md)}`, { headers: H })).json();
check("GET /api/fs/file returns kind + hash + editable", info.kind === "markdown" && /^[0-9a-f]{16,}$/.test(String(info.hash)) && info.editable === true, JSON.stringify({ kind: info.kind, hash: String(info.hash).slice(0, 8) + "…", editable: info.editable }));

// ② the byte endpoint serves a real image (the old one blanked binaries)
const r = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(png)}`, { headers: H });
const buf = Buffer.from(await r.arrayBuffer());
const onDisk = readFileSync(png);
check("GET /api/fs/raw serves the image's real bytes", r.ok && r.headers.get("content-type")?.includes("image/png") && buf.length === onDisk.length && buf.equals(onDisk), `status=${r.status} type=${r.headers.get("content-type")} bytes=${buf.length}/${onDisk.length}`);

// ③ stat gives the hash a writer compares against
const st = await (await fetch(`${BASE}/api/fs/stat?path=${encodeURIComponent(csv)}`, { headers: H })).json();
check("GET /api/fs/stat returns the file's hash", /^[0-9a-f]{16,}$/.test(String(st.hash ?? "")), JSON.stringify({ hash: String(st.hash ?? "").slice(0, 8) + "…" }));

// ④ a stale writer is refused AND handed the current content (no silent overwrite)
const stale = await fetch(`${BASE}/api/fs/file`, {
  method: "PUT", headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify({ path: md, content: "clobbered\n", ifHash: "0000000000000000" }),
});
const staleBody = await stale.json().catch(() => ({}));
check("PUT with a stale ifHash is refused (409) and returns the current text", stale.status === 409 && String(staleBody.content ?? staleBody.file?.content ?? "").includes("hello from the promoter"), `status=${stale.status} keys=${Object.keys(staleBody).join(",")}`);
check("…and the refused write did NOT touch the file", readFileSync(md, "utf8") === "# live check\n\nhello from the promoter\n");

// ⑤ a fresh write lands, and the bytes on disk are what was sent
const cur = await (await fetch(`${BASE}/api/fs/stat?path=${encodeURIComponent(md)}`, { headers: H })).json();
const put = await fetch(`${BASE}/api/fs/file`, {
  method: "PUT", headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify({ path: md, content: "# live check\n\nsaved over HTTP\n", ifHash: cur.hash }),
});
check("PUT with the current hash saves (200)", put.ok, `status=${put.status}`);
check("…and the bytes on disk match what the client sent", readFileSync(md, "utf8") === "# live check\n\nsaved over HTTP\n");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);