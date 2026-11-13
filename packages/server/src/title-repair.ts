// One-time repair of names that were LOCKED to a slice of the operator's own message (issue #105).
//
// The live fix (`isPromptSliceTitle` in title.ts) only helps frames that arrive from now on. Rows
// already written under the old discriminator are stuck: the name is a fragment of the opening
// message, and it is filed at `llm` rank — the highest rank below a manual rename — so no later
// frame can ever improve it (`TITLE_RANK`: equal ranks never overwrite).
//
// What can be recovered: the model's own title, still sitting in the AGENT's store
// (`<HERMES_HOME>/state.db`, `sessions.title` with `title_source='llm'`). Read-only, the same way
// `turn-busy.ts` reads that file — the gateway owns it, and a second writer would fight it.
//
// What can NOT be recovered: sessions whose agent-side title is empty (a turn that never got far
// enough to be named). Those only get their RANK corrected (`llm` → `agent`), so any frame that
// arrives later can still win them; the name itself stays what it is.
//
// KNOWN BLIND SPOT: the proof compares a name against prompts we hold, so a producer that slices
// something we never stored — an attachment/paste preview (`title_generator.py` returns a preview
// string for attachment-only openers), or a first line that is a fenced block — is still ranked as
// a model title. Fixing that needs the frame to carry its provenance; noted as a follow-up on #105.
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
  /** candidates that turned out to be a genuine model title */
  skipped: number;
  /** rows whose agent store could not be READ (locked, mid-WAL, unreadable) */
  unreadable: number;
  /** false = the pass was NOT recorded; the next start tries again */
  complete: boolean;
}

/** What the agent itself recorded for a session.
 *
 *  `readable:false` means WE COULD NOT LOOK (the store exists but would not open or query) — a
 *  different thing from `title:null` ("the agent has no model title for this one"). The first must
 *  never cause a permanent decision about a row; the second may. A home with no `state.db` at all
 *  is the second: nothing is going to appear there. */
export interface AgentTitleLookup {
  readable: boolean;
  title: string | null;
}

export function agentStateTitle(home: string | null, ids: Array<string | null | undefined>): AgentTitleLookup {
  const clean = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!home || !clean.length) return { readable: true, title: null };
  const dbPath = path.join(home, "state.db");
  if (!fs.existsSync(dbPath)) return { readable: true, title: null };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const marks = clean.map(() => "?").join(",");
    const row = db
      .prepare(`select title, title_source from sessions where id in (${marks})`)
      .get(...clean) as { title?: string | null; title_source?: string | null } | undefined;
    if (!row) return { readable: true, title: null };
    // Only the MODEL's name outranks the operator's own words; the agent's `derived` row IS the
    // slice we are trying to replace.
    if (row.title_source !== "llm") return { readable: true, title: null };
    const t = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
    return { readable: true, title: t || null };
  } catch {
    return { readable: false, title: null };
  } finally {
    try { db?.close(); } catch { /* already gone */ }
  }
}

/** Repair every row that wears a slice of the operator's message as if it were a model title.
 *
 *  `lookup` is injectable so the QA sweep can drive the pass without a real agent home. `force`
 *  re-runs a pass that already recorded itself.
 *
 *  The pass records itself ONLY when it could decide about every candidate: a row whose agent store
 *  was unreadable keeps both its name and its rank, and the next start tries again — recording a
 *  half-blind pass would turn 「boot 时那个库正忙」 into 「这个会话永远修不好了」. Idempotent
 *  otherwise: a repaired row no longer passes the proof. */
export function repairMisTieredTitles(
  store: Store,
  opts: {
    lookup?: (home: string | null, ids: Array<string | null | undefined>) => AgentTitleLookup;
    force?: boolean;
    log?: (line: string) => void;
  } = {},
): TitleRepairResult {
  const res: TitleRepairResult = { checked: 0, repaired: 0, refiled: 0, skipped: 0, unreadable: 0, complete: true };
  if (!opts.force && store.repairRan(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION)) return res;
  const lookup = opts.lookup ?? agentStateTitle;
  const log = opts.log ?? (() => {});
  for (const row of store.modelTitledRows()) {
    res.checked++;
    const prompts = store.userPromptSamples(row.id);
    // Prove it: only a name that really is the opening of the operator's own message is touched.
    // A model title that happens to be long enough to end in `…` must survive untouched.
    if (!isPromptSliceText(row.title, prompts)) {
      res.skipped++;
      continue;
    }
    const { readable, title: better } = lookup(row.home, [row.acpSessionId]);
    if (!readable) {
      // Decide nothing about this row, and do not claim the pass is done.
      res.unreadable++;
      continue;
    }
    // The replacement must ITSELF not be a slice — a `title_source='llm'` row whose title still
    // begins with the operator's words would re-lock the same defect at the same rank.
    if (better && better !== row.title && !isPromptSliceText(better, prompts)) {
      store.setAutoTitle(row.id, better, { force: true, src: "llm" });
      res.repaired++;
      log(`title repair: ${row.id} 「${row.title}」 → 「${better}」`);
      continue;
    }
    // Nothing better exists: stop claiming the slice is a model name, so a later frame can win it.
    if (store.setTitleSrc(row.id, "agent")) res.refiled++;
  }
  // A pass that saw nothing at all is not evidence of anything (an empty library, or a library
  // restored from a backup later): leave it unrecorded so a real candidate is never skipped.
  if (res.unreadable > 0 || res.checked === 0) res.complete = false;
  if (res.complete) store.markRepair(SLICE_TITLE_REPAIR, SLICE_TITLE_REPAIR_VERSION);
  else log(`title repair: not recorded (unreadable=${res.unreadable}, checked=${res.checked}) — retrying on the next start`);
  return res;
}
