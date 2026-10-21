/**
 * One vocabulary for the agent's background-completion notice.
 *
 * WHY A PARSER AND NOT A SERVER FIELD. The wake is a PROMPT: the fork synthesises the sentence the
 * gateway injects (``acp_adapter/background.py::_summary_text``), and the host's job is to deliver it
 * as a turn — the agent has to read the command and its output, so the text must stay exactly as
 * produced. That makes the transcript row a fixed, machine-written shape:
 *
 *     [IMPORTANT: Background process proc_abc completed normally (exit code 0).
 *     Command: cd /tmp && sleep 45 && echo hi
 *     Output:
 *     hi
 *     ]
 *
 * Rendered raw it is nine lines of shell noise for the one fact the operator wants (「跑完了，成功」).
 * So the roster keeps the original text (copy still yields it verbatim) and only the VIEW is folded:
 * a header line, and the command/output behind a caret. Parsing fails → the raw text renders exactly
 * as before, which is the safe direction for a format that lives in another repo.
 */

export interface BgNotice {
  /** The agent's process id (`proc_…`), not the cockpit's session id. */
  id: string;
  /** The command the agent ran, verbatim. */
  command: string;
  exitCode: number | null;
  /** ``completed normally`` — anything else (non-zero, killed, timed out) reads as a failure. */
  ok: boolean;
  /** Everything after ``Output:``, minus the carrier's trailing ``]``. */
  output: string;
}

const MARK = "[IMPORTANT: Background process ";

/** Parse the agent's completion sentence, or null when this is not one. */
export function parseBgNotice(text: string): BgNotice | null {
  const all = text.trim();
  if (!all.startsWith(MARK)) return null;
  const lines = all.split("\n");
  const head = /^\[IMPORTANT: Background process (\S+) (.*?)\(exit code (-?\d+)\)\.?\]?$/.exec(lines[0] ?? "");
  if (!head) return null;
  const verdict = head[2].trim();
  let command = "";
  let outputAt = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("Command: ")) command = lines[i].slice("Command: ".length).trim();
    else if (lines[i].trim() === "Output:") { outputAt = i + 1; break; }
  }
  let output = outputAt >= 0 ? lines.slice(outputAt).join("\n") : "";
  // The carrier closes with `]` on its own line. Drop it — and only it: a `]` inside real output stays.
  output = output.replace(/\n?\]\s*$/, "");
  return {
    id: head[1],
    command,
    exitCode: Number(head[3]),
    ok: /^completed normally$/i.test(verdict),
    output: output.replace(/\s+$/, ""),
  };
}

/**
 * A command long enough to be useless in a one-line header. Kept a pure function of the command so the
 * folded row is stable across re-renders (no measuring the DOM, which would flicker the label).
 */
export function shortCommand(command: string, max = 64): string {
  const one = command.replace(/\s+/g, " ").trim();
  if (!one) return "(no command)";
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}


/**
 * The DELEGATION wake — `delegate_task(background=true)` finishing — is a different machine-shaped
 * block on the same channel: one header line, then one `--- ✓ TASK i/n: <goal> (status=…) ---`
 * section per subagent, each carrying a whole report. Delivered raw it is hundreds of lines of
 * other agents' prose in the middle of the operator's own conversation (their words: 「内容太多了吧，
 * 全部展开占的空间很大，应该做成默认折叠」), and the fold has to keep the ONE fact that matters —
 * 回来了、几个、成没成、多久 — readable without opening anything.
 *
 * Same contract as the terminal notice above: parse → fold the view only; the roster keeps the
 * original text, so copy still yields it verbatim, and an unrecognised shape renders as before.
 */
export interface DelegTask {
  index: number;
  total: number;
  ok: boolean;
  /** What the subagent was told to do, verbatim (one line). */
  goal: string;
  /** `completed` / `interrupted` / … , as the carrier printed it. */
  status: string;
  /** The rest of the parenthesised metadata: `api_calls=27, 200.98s`. */
  meta: string;
  /** The subagent's own report, markdown, minus the section marker. */
  body: string;
}

export interface DelegNotice {
  /** `deleg_…`: the batch id, not a session id. */
  id: string;
  /** `2026-10-21 21:39:50` — when it was dispatched. */
  dispatched: string;
  /** `3m21s ago` — how long it took, as the carrier measured it. */
  ago: string;
  /** `leaf` / `orchestrator`. */
  role: string;
  /** `201.36s` total across the batch (may be empty). */
  total: string;
  tasks: DelegTask[];
}

const DELEG_HEAD = /^\[?ASYNC DELEGATION (?:BATCH )?COMPLETE\s*[—–-]\s*(\S+?)\]?$/;
const DELEG_TASK = /^---\s*(✓|✗|!|\?)?\s*TASK (\d+)\/(\d+):\s*(.*?)\s*(?:\(([^)]*)\))?\s*---$/;

/** Parse a delegation wake, or null when this is not one. */
export function parseDelegNotice(text: string): DelegNotice | null {
  const all = text.trim();
  const lines = all.split("\n");
  const head = DELEG_HEAD.exec((lines[0] ?? "").trim());
  if (!head) return null;
  const out: DelegNotice = { id: head[1], dispatched: "", ago: "", role: "", total: "", tasks: [] };
  let cur: DelegTask | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (!cur) return;
    cur.body = body.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "");
    out.tasks.push(cur);
    body = [];
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const t = DELEG_TASK.exec(line.trim());
    if (t) {
      flush();
      const meta = (t[5] ?? "").trim();
      const stat = /status\s*=\s*([\w-]+)/.exec(meta);
      cur = {
        index: Number(t[2]),
        total: Number(t[3]),
        // No marker at all is not a failure; an explicit ✗/! is.
        ok: t[1] !== "✗" && t[1] !== "!" && (!stat || !/^(interrupted|failed|error|cancelled)$/i.test(stat[1])),
        goal: (t[4] ?? "").trim(),
        status: stat ? stat[1] : t[1] === "✓" ? "completed" : "",
        meta: meta.replace(/status\s*=\s*[\w-]+\s*,?\s*/i, "").replace(/,\s*$/, "").trim(),
        body: "",
      };
      continue;
    }
    if (cur) { body.push(line); continue; }
    // Still in the preamble: the carrier's own three fields.
    const d = /^Dispatched:\s*(.+?)(?:\s*\(([^)]*)\))?\s*$/.exec(line);
    if (d) { out.dispatched = d[1].trim(); out.ago = (d[2] ?? "").trim(); continue; }
    const r = /^Role:\s*([^\s]+)/.exec(line);
    if (r) out.role = r[1];
    const dur = /Total duration:\s*([\w.]+)/.exec(line);
    if (dur) out.total = dur[1];
  }
  flush();
  // A header with no sections is not a notice — it is some other text that happened to start alike.
  return out.tasks.length ? out : null;
}

/** The one line the folded row shows: how many came back, and how long they took. */
export function delegSummary(d: DelegNotice): string {
  const n = d.tasks.length;
  const bad = d.tasks.filter((t) => !t.ok).length;
  const span = d.ago || d.total;
  return `${n} 个任务${bad ? ` · ${bad} 个未完成` : ""}${span ? ` · ${span}` : ""}`;
}
