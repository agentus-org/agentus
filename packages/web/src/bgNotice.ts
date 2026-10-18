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
