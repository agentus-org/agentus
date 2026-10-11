// Guard the one build-time defect that has actually bitten this project: xterm.js#5800 / esbuild#4508.
//
// @xterm/xterm 6.0.0 publishes PRE-MINIFIED ESM. Its `InputHandler.requestMode` builds an enum
// through an IIFE over a local that is never read again:
//
//     requestMode(e, i) { let r; (P => (…))(r ||= {}); … }
//
// Bundling that at `target <= es2020` (Vite's default `"modules"`) makes esbuild lower `r ||= {}`
// to `r || (r = {})`; the minify pass then drops the declaration as dead code but keeps the
// assignment, minted as a FRESH undeclared identifier:
//
//     requestMode(e, i) { (P => (…))(void 0 || (n = {})); … }   // n is not defined
//
// The first DECRQM query — `CSI ? Ps $ p`, sent on startup by vim, nvim, htop, less, opencode and
// every other TUI — then throws a ReferenceError INSIDE xterm's write-buffer timer chain. The
// timer chain dies with it: the pty stays alive, keystrokes keep reaching the shell, and NOTHING
// is ever parsed or painted again. The operator sees "vi opens, then the panel is dead".
//
// Source and node_modules are both correct — only the emitted bundle is wrong, so this asserts on
// the emitted BYTES. Run it after any web build; it is cheap and it is the only thing that would
// have caught the freeze before the operator did.
//
//   node scripts/qa/web-bundle-integrity.mjs [--dist packages/web/dist]
//
// Fix when it fails: `build.target` must be es2021 or newer in packages/web/vite.config.ts (or
// switch the minifier to terser). Do NOT fix it by editing xterm — the next `npm i` undoes that.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/scripts/qa
const repoRoot = path.resolve(here, "..", "..");

const dist = path.resolve(arg("--dist", path.join(repoRoot, "packages/web/dist")));
const assets = path.join(dist, "assets");

if (!fs.existsSync(assets)) {
  console.error(`[bundle-integrity] FAIL: no built assets at ${assets} — build packages/web first`);
  process.exit(2);
}

const bundles = fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f));
if (bundles.length === 0) {
  console.error(`[bundle-integrity] FAIL: no index-*.js in ${assets}`);
  process.exit(2);
}

/** Every `requestMode(a, b){ … }` definition body, cut at the first `;`. */
function requestModeBodies(source) {
  const out = [];
  const re = /requestMode\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{/g;
  let m;
  while ((m = re.exec(source))) {
    const end = source.indexOf(";", m.index);
    out.push(source.slice(m.index, end === -1 ? m.index + 400 : end));
  }
  return out;
}

// The second build-time defect this gate exists for: a DEVELOPMENT build.
//
// This box exports NODE_ENV=development, and `vite build` honours it — @vitejs/plugin-react then
// picks the dev JSX runtime, so the emitted bundle carries `jsxDEV(…)` with
// `{fileName:"/abs/path/App.tsx",lineNumber:2121}` on EVERY element. Both consequences are silent:
//
//   · the asset is ~40% bigger and slower (React's dev runtime, no minification of that layer), and
//   · those absolute paths make the content hash depend on WHERE the tree was checked out — so the
//     same sources build to a different filename in every worktree (live's bundle and dev's bundle
//     disagreed by exactly the length difference of their two paths), and a packed tarball ships
//     the builder's home directory to strangers.
//
// Fix: the build script must pin `NODE_ENV=production vite build` (packages/web/package.json). This
// asserts on the emitted bytes so a dev build can neither reach live nor leave in an npm package.
function devBuildSignatures(source) {
  const out = [];
  if (source.includes("jsxDEV(")) out.push("jsxDEV( — React's development JSX runtime is in here");
  const m = source.match(/fileName:"[^"]*\.(tsx|ts)"/);
  if (m) out.push(`fileName:"…" — the dev transform left source paths in the bundle (${m[0].slice(0, 70)}…)`);
  if (source.includes("createHotContext") || source.includes("import.meta.hot")) out.push("HMR client code — this is a dev server build");
  return out;
}

let failed = false;
let checked = 0;

for (const file of bundles) {
  const source = fs.readFileSync(path.join(assets, file), "utf8");
  const bodies = requestModeBodies(source);
  checked += bodies.length;

  if (bodies.length === 0) {
    // Not a pass: the assertion below would be vacuous. Either xterm was removed (then delete this
    // check) or the bundle was mangled past recognition — both need a human.
    console.error(`[bundle-integrity] FAIL: ${file} contains no InputHandler.requestMode — xterm gone, or renamed beyond recognition`);
    failed = true;
    continue;
  }

  for (const body of bodies) {
    if (body.includes("void 0||(") || body.includes("void 0 || (")) {
      failed = true;
      console.error(
        `[bundle-integrity] FAIL: ${file} — requestMode's enum local was lowered away (esbuild#4508).\n` +
          `    emitted: ${body}\n` +
          `    A TUI that sends DECRQM (vim, htop, less, opencode) will freeze this terminal permanently.\n` +
          `    Fix: packages/web/vite.config.ts → build.target must be "es2021" or newer.`,
      );
    }
  }

  for (const sig of devBuildSignatures(source)) {
    failed = true;
    console.error(
      `[bundle-integrity] FAIL: ${file} looks like a DEVELOPMENT build — ${sig}\n` +
        `    Fix: packages/web/package.json → the build script must pin \`NODE_ENV=production vite build\`.\n` +
        `    (This box exports NODE_ENV=development, so a bare \`vite build\` silently ships the dev runtime.)`,
    );
  }

  if (!failed) console.log(`[bundle-integrity] ok: ${file} (${bodies.length} requestMode definition(s), enum local intact)`);
}

if (failed) process.exit(1);
console.log(`[bundle-integrity] PASS — ${checked} definition(s) checked across ${bundles.length} bundle(s)`);
