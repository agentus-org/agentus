// One-time repair of names that were LOCKED to a slice of the operator's own message (issue #105).
//
// The live fix (`isPromptSliceTitle` in title.ts) only helps frames that arrive from now on. Rows
// already written under the old discriminator are stuck: the name is a fragment of the opening
// message, and it is filed at `llm` rank — the highest rank below a manual rename — so no later
// frame can ever improve it (`TITLE_RANK`: equal ranks never overwrite). Two of them are visible in
// the operator's rail as 「…（照 Agentus…」 style fragments.
//
// What can be recovered: the model's own title, still sitting in the AGENT's store
// (`<HERMES_HOME>/state.db`, `sessions.title` with `title_source='llm'`). Read-only, the same way
// `turn-busy.ts` reads that file — the gateway owns it, and a second writer would fight it.
//
// What can NOT be recovered: sessions whose agent-side title is empty (a turn that never got far
// enough to be named). Those only get their RANK corrected (`llm` → `agent`), so any frame that
// arrives later can still win them; the name itself stays what it is.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Store } from "./store/store.js";
import { isPromptSliceText } from "./title.js";

export const SLICE_TITLE_REPAIR = "title-slice-tier";
export const SLICE_TITLE_REPAIR_VERSION = 1;

export interface TitleRepairResult {
  /** rows that looked like a mis-tiered slice */
  checked: number;
  /** rows given the agent's real model title */
  repaired: number;
  /** rows whose name could not be recovered but whose rank was corrected */
  refiled: number;
  /** candidates that turned out to be a genuine model title ending in `…` */
  skipped: number;
}

/** The name the AGENT itself recorded for a session — only when it is the model's (`title_source
 *  = 'llm'`); the agent's `derived` rows are the very slice we are trying to replace. Unreadable
 *  store (no file, no table, locked) = `null`, never a guess. */
export function agentStateTitle(home: string | null, ids: Array<string | null | undefined>): string | null {
  const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!home || !clean.length) return null;
  const dbPath = path.join(home, "state.db");
  if (!fs.existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const marks = clean.map(() => "?").join(",");
    const row = db
      .prepare(`select title, title_source from sessions where id in (${marks})`)
      .get(...clean) as { title?: string | null; title_source?: string | null } | undefined;
    if (!row || row.title_source !== "llm") return null;
    const t = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
    return t || null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

/** Repair every row that wears a slice of the operator's message as if it were a model title.
 *
 *  `lookup` is injectable so the QA sweep can drive the pass without a real agent home. `force`
 *  re-runs a pass that already recorded itself (QA / a second attempt after the agent store was
 *  reachable the second time). Idempotent: a repaired row no longer matches the prefilter. */
export function repairMisTieredTitles(
  store: Store,
  opts: {
    lookup?: (home: string | null, ids: Array<string | null | undefined>) => string | null;
    force?: boolean;
    log?: (line: string) => void;
  } = {},
): TitleRepairResult {
  const res: TitleRepairResult = { checked: 0, repaired: 0, refiled: 0, skipped: 0 };
  if (!opts.force && store.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION)) return res;
  const lookup = opts.lookup ?? agentStateTitle;
  const log = opts.log ?? (() => {});
  for (const row of store.modelTitledRows()) {
    res.checked++;
    const texts = store.userPromptTexts(row.id);
    // Prove it: only a name that really is the opening of the operator's own message is touched.
    // A model title that happens to be long enough to end in `…` must survive untouched.
    if (!isPromptSliceText(row.title, [texts.first, texts.latest])) {
      res.skipped++;
      continue;
    }
    const better = lookup(row.home, [row.acpSessionId]);
    if (better && better !== row.title) {
      store.setAutoTitle(row.id, better, { force: true, src: "llm" });
      res.repaired++;
      log(`title repair: ${row.id} 「${row.title}」 → 「${better}」`);
      continue;
    }
    // Nothing better exists: stop claiming the slice is a model name, so a later frame can win it.
    if (store.setTitleSrc(row.id, "agent")) res.refiled++;
  }
  store.markRepair(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION);
  return res;
}
