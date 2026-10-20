// Cold paging must be per WORKSPACE, not one global top-N (issue #34).
//
// The bug: `cold(limit)` sorted every cold row by lastAt and took the first N. Every consumer — the
// rail's workspace groups, its 展开其余 counter, the search box, `cockpit session list --workspace` —
// then treated that page as the complete set. One busy workspace could eat the whole page, and since
// a cold row is the ONLY handle that can wake its session, everything it pushed out became
// unreachable from the UI while the transcript sat fine on disk.
//
// Two halves, both offline:
//   1. the pure rule (`cold-page.ts`) — retention per workspace, ordering, the total backstop;
//   2. real data — copy a live `agentus.sqlite` to a temp dir, open the real Store + SessionManager
//      and assert every workspace that exists in the DB comes back from `cold()`.
//
//   npx tsx scripts/qa/cold-paging.mts
//   COLD_PAGING_DB=/tmp/live-copy.sqlite npx tsx scripts/qa/cold-paging.mts   # real-data half
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coldPage, coldKeyOf, COLD_PER_WORKSPACE } from "../../packages/server/src/acp/cold-page.ts";
import { listSessions, LIST_LIMIT_DEFAULT } from "../../packages/server/src/cockpit/api.ts";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  ok ? (pass += 1) : (fail += 1);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

/** A cold row in the shape the pager reads. */
const row = (id: string, ws: string | null, lastAt: number) => ({
  id,
  workspace: ws,
  cwd: `/ws/${ws ?? "no-workspace"}`,
  lastAt,
  createdAt: lastAt,
});

console.log("\n[1] per-workspace retention (the whole point of #34)");
{
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => row(`a${30 - i}`, "alpha", 1000 - i)), // 30, newest first
    ...Array.from({ length: 6 }, (_, i) => row(`b${6 - i}`, "beta", 500 - i)), // 6, all older than alpha's
    ...Array.from({ length: 2 }, (_, i) => row(`c${2 - i}`, "gamma", 100 - i)),
  ];
  const page = coldPage(rows, 20, 400);
  const byWs = (ws: string) => page.rows.filter((r) => coldKeyOf(r) === ws).length;
  check("alpha keeps 20 of its 30", byWs("alpha") === 20, `got ${byWs("alpha")}`);
  check("beta keeps all 6 (a global top-20 would have kept 0)", byWs("beta") === 6, `got ${byWs("beta")}`);
  check("gamma keeps all 2 (oldest rows on the install)", byWs("gamma") === 2, `got ${byWs("gamma")}`);
  check("omitted = 10 and total = 38", page.omitted === 10 && page.total === 38, `omitted ${page.omitted}, total ${page.total}`);
  check("no row appears twice", new Set(page.rows.map((r) => r.id)).size === page.rows.length);
  check(
    "each workspace keeps its NEWEST rows",
    page.rows.filter((r) => r.id.startsWith("a")).every((r) => Number(r.id.slice(1)) <= 30 && Number(r.id.slice(1)) >= 11),
  );
  const sorted = page.rows.every((r, i) => i === 0 || (page.rows[i - 1].lastAt ?? 0) >= (r.lastAt ?? 0));
  check("merged page is still newest-first", sorted);
}

console.log("\n[2] the anti-bloat backstop still exists");
{
  const rows = Array.from({ length: 10 }, (_, w) =>
    Array.from({ length: 5 }, (_, i) => row(`w${w}-${i}`, `ws${w}`, w * 100 + (5 - i) || 1)),
  ).flat();
  const page = coldPage(rows, 5, 12);
  check("total cap 12 is honoured", page.rows.length === 12, `got ${page.rows.length}`);
  check("omitted reports the rest", page.omitted === 38, `got ${page.omitted}`);
  const perWs = new Map<string, number>();
  for (const r of page.rows) perWs.set(coldKeyOf(r), (perWs.get(coldKeyOf(r)) ?? 0) + 1);
  check("the cap eats from the oldest workspaces, not one single bucket", [...perWs.values()].every((n) => n <= 5));
}

console.log("\n[3] bucket key matches what the rail displays");
{
  const withCwdOnly = { id: "x", workspace: null, cwd: "/a/b", lastAt: 1, createdAt: 1 };
  const withWs = { id: "y", workspace: "/a/b", cwd: "/somewhere/else", lastAt: 2, createdAt: 2 };
  check("null workspace falls back to cwd", coldKeyOf(withCwdOnly as never) === "/a/b");
  check("workspace wins over cwd (same rule as sessionRow)", coldKeyOf(withWs as never) === "/a/b");
  const page = coldPage([withWs, withCwdOnly] as never, 20, 400);
  check("both land in one bucket and both survive", page.rows.length === 2);
}

console.log("\n[4] `capped` tells the truth about the cold page (#34 point 3)");
{
  const cockpitRow = (id: string, lastAt: number) => ({
    id,
    name: id,
    workspace: "/w",
    status: "idle",
    cold: true,
    archived: false,
    createdAt: lastAt,
    lastAt,
    plan: { done: 0, total: 0, title: null },
    permissions: 0,
  });
  const rows = Array.from({ length: 3 }, (_, i) => cockpitRow(`s${i}`, 100 - i));

  const clean = listSessions(rows as never, { limit: LIST_LIMIT_DEFAULT });
  check("nothing hidden → capped false, cold_omitted 0", clean.meta.capped === false && clean.meta.cold_omitted === 0);

  const partial = listSessions(rows as never, { limit: LIST_LIMIT_DEFAULT, coldOmitted: 7 });
  check("cold page dropped rows → capped true", partial.meta.capped === true);
  check("cold_omitted travels with the answer", partial.meta.cold_omitted === 7, `got ${partial.meta.cold_omitted}`);
  check("the rows themselves are untouched by the flag", partial.rows.length === 3);
}

// ── real data ────────────────────────────────────────────────────────────────────────────────────
const dbIn = process.env.COLD_PAGING_DB;
if (dbIn) {
  console.log(`\n[5] real DB: ${dbIn}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentus-cold-"));
  const db = path.join(tmp, "agentus.sqlite");
  fs.copyFileSync(dbIn, db);
  const { Store } = await import("../../packages/server/src/store/store.ts");
  const { SessionManager } = await import("../../packages/server/src/acp/session-manager.ts");
  const store = new Store(db);
  const mgr = new SessionManager(store, () => {}) as unknown as {
    cold(per?: number, total?: number): { id: string; workspace: string | null; cwd: string }[];
  };
  const all = mgr.cold(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const page = mgr.cold();
  const key = (r: { workspace: string | null; cwd: string }) => r.workspace || r.cwd;
  const want = new Set(all.map(key));
  const got = new Set(page.map(key));
  const missing = [...want].filter((k) => !got.has(k));
  const perWs = (rs: typeof all) => {
    const m = new Map<string, number>();
    for (const r of rs) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return m;
  };
  const wantCounts = perWs(all);
  const gotCounts = perWs(page);
  console.log(`      cold rows: ${all.length}, workspaces: ${want.size}`);
  for (const [k, n] of [...wantCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(3)} → ${String(gotCounts.get(k) ?? 0).padStart(3)}  ${k.slice(-46)}`);
  }
  check("every workspace with cold rows is represented in the default page", missing.length === 0, missing.join(", "));
  check(
    "each workspace keeps min(its size, per-workspace cap)",
    [...wantCounts.entries()].every(([k, n]) => (gotCounts.get(k) ?? 0) === Math.min(n, COLD_PER_WORKSPACE)),
  );
  const oldGlobal = all.slice(0, COLD_PER_WORKSPACE);
  const oldWs = perWs(oldGlobal);
  console.log(`      old global top-${COLD_PER_WORKSPACE} covered ${oldWs.size} workspace(s); per-group covers ${gotCounts.size}`);
  check("per-group covers at least as many workspaces as the old global page", gotCounts.size >= oldWs.size);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
