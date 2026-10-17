// The instance's own name (issue #19): one person runs several cockpits, and every tab + every
// home-screen icon used to say "Agentus".
//
// Two servers are started from THIS tree on spare ports — one with `AGENTUS_TITLE` unset, one with
// it set — and the running process is asked for the two bodies that carry the name. Nothing is
// stubbed: a title that only works in a helper function would pass a unit test and fail the tab.
//
//   node scripts/qa/instance-title-sweep.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/** Start one server on `port` with exactly the environment this instance should have. */
async function start(port, extraEnv) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `title-sweep-${port}-`));
  // A scratch instance must not inherit the LIVE identity from the shell that runs the sweep — the
  // name included, or the "unset" case would silently test the operator's own title.
  const env = { ...process.env, AGENTUS_PORT: String(port), AGENTUS_DATA: data, AGENTUS_DEV: "1" };
  delete env.AGENTUS_TITLE;
  delete env.AGENTUS_BASE;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ["--import", "tsx", "packages/server/src/index.ts"], {
    cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => { log += String(b); });
  child.stderr.on("data", (b) => { log += String(b); });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server ${port} exited: ${log.slice(-600)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return { child, data, log: () => log };
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`server ${port} never answered /healthz: ${log.slice(-600)}`);
}
const stop = async (s) => {
  s.child.kill("SIGTERM");
  for (let i = 0; i < 50 && s.child.exitCode === null; i++) await sleep(100);
  if (s.child.exitCode === null) s.child.kill("SIGKILL");
  fs.rmSync(s.data, { recursive: true, force: true });
};
const get = async (port, p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.text(), cache: r.headers.get("cache-control") ?? "" };
};

const PLAIN = 8913, NAMED = 8914;
const NAME = "Agentus（pre-betabox）";
const weird = { AGENTUS_TITLE: "<b>x</b> & co" };
const WEIRD_PORT = 8915;

const a = await start(PLAIN, {});
const b = await start(NAMED, { AGENTUS_TITLE: NAME });
const c = await start(WEIRD_PORT, weird);
try {
  // ---- unset: the built file is served, unchanged ----
  const plainHtml = await get(PLAIN, "/");
  check("no AGENTUS_TITLE → the tab still says Agentus",
    /<title>Agentus<\/title>/i.test(plainHtml.body), (plainHtml.body.match(/<title>[^<]*<\/title>/i) ?? [""])[0]);
  // ---- named: both surfaces follow ----
  const namedHtml = await get(NAMED, "/");
  check("AGENTUS_TITLE → the tab title is the instance name",
    namedHtml.body.includes(`<title>${NAME}</title>`), (namedHtml.body.match(/<title>[^<]*<\/title>/i) ?? [""])[0]);
  check("…the page is still the real SPA shell (it names the hashed bundle)",
    /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(namedHtml.body));
  const man = await get(NAMED, "/manifest.webmanifest");
  let mj = null;
  try { mj = JSON.parse(man.body); } catch { /* reported below */ }
  check("…the manifest parses and carries the name in name + short_name",
    mj?.name === NAME && mj?.short_name === NAME, JSON.stringify({ name: mj?.name, short: mj?.short_name }));
  check("…and the manifest keeps everything else (icons, start_url, display)",
    Array.isArray(mj?.icons) && mj.icons.length === 4 && mj?.start_url === "/" && mj?.display === "standalone");

  // ---- the name is DATA, not markup ----
  const weirdHtml = await get(WEIRD_PORT, "/");
  check("an operator title is HTML-escaped, never injected as markup",
    weirdHtml.body.includes("<title>&lt;b&gt;x&lt;/b&gt; &amp; co</title>") && !weirdHtml.body.includes("<title><b>"),
    (weirdHtml.body.match(/<title>[^<]*<\/title>/i) ?? [""])[0]);

  // ---- caching: a renamed instance must not keep the old label on a home screen for a year ----
  check("the HTML is served no-store (it names the bundle and now the name)",
    /no-cache|no-store/.test(namedHtml.cache), namedHtml.cache);
  check("…and so is the manifest", /no-cache|no-store/.test(man.cache), man.cache);

  // ---- the hashed assets are NOT touched by the name ----
  const asset = namedHtml.body.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
  const plainAsset = plainHtml.body.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
  check("both instances serve the same bundle (the name is not a build input)", asset === plainAsset, `${plainAsset} vs ${asset}`);
  if (asset) {
    const served = await get(NAMED, `/assets/${asset}`);
    const onDisk = fs.readFileSync(path.join(REPO, "packages/web/dist/assets", asset), "utf8");
    check("…and that bundle is byte-identical to the build on disk", served.body === onDisk,
      `${served.body.length} vs ${onDisk.length} bytes`);
  }

  // ---- deep links and unknown paths still fall back to the shell, now titled ----
  const deep = await get(NAMED, "/some/deep/link");
  check("the SPA fallback carries the name too (a shared deep link opens with the right tab)",
    deep.body.includes(`<title>${NAME}</title>`));

  // ---- the default instance's manifest really was the untouched file ----
  const plainMan = await get(PLAIN, "/manifest.webmanifest");
  const onDiskMan = fs.readFileSync(path.join(REPO, "packages/web/dist/manifest.webmanifest"), "utf8");
  check("unset → the manifest is served exactly as built (no reformatting)",
    plainMan.body === onDiskMan, `${plainMan.body.length} vs ${onDiskMan.length} bytes`);
} finally {
  await stop(a); await stop(b); await stop(c);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
