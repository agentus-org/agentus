// Session export. ACP has no notion of "export" (verified against the SDK types and
// AionUi: their export is a conversation-layer feature over their OWN storage, exactly
// like ours — the protocol only carries the stream). So this renderer works purely from
// what we persisted: `messages` rows whose payloads are raw ACP update fragments.
//
// The fold here mirrors packages/web's ingest rules so the exported transcript reads
// like the cockpit: consecutive agent/thought chunks join into one paragraph, a user
// row breaks the paragraph, tool rows are discrete entries keyed by toolCallId.
import type { StoredMessage } from "@agentus/shared";

export interface ExportSessionHeader {
  id: string;
  title: string;
  backend: string;
  cwd: string;
  workspace?: string | null;
  acpSessionId: string | null;
  createdAt: number;
}

function ts(at: number): string {
  return new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function contentText(payload: Record<string, unknown>): string {
  // user rows carry OUR shape ({ text }); agent/thought rows carry the raw ACP
  // update fragment ({ content: { type: "text", text } }). Accept both.
  if (typeof payload.text === "string" && payload.text) return payload.text;
  const c = payload.content as { type?: string; text?: string } | undefined;
  if (c?.type === "text" && typeof c.text === "string") return c.text;
  return "";
}

/** Tool result as text — same shape the cockpit bubble uses, but an archive should not
 *  lose bytes to a UI cap, so only extreme rows get clipped (marked, never silent). */
function toolDetail(payload: Record<string, unknown>): string {
  const CAP = 20000;
  const clip = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}\n… [truncated, ${s.length} chars total]` : s);
  const raw = payload.rawOutput;
  if (typeof raw === "string" && raw.trim()) return clip(raw);
  if (raw && typeof raw === "object") {
    try {
      return clip(JSON.stringify(raw, null, 1));
    } catch {
      /* non-serialisable — fall through to content items */
    }
  }
  const items = payload.content;
  if (Array.isArray(items)) {
    const parts: string[] = [];
    for (const it of items as Record<string, unknown>[]) {
      if (it?.type === "content") {
        const inner = it.content as { type?: string; text?: string } | undefined;
        if (inner?.text) parts.push(inner.text);
      } else if (it?.type === "diff") {
        parts.push(`diff ${String(it.path ?? "?")}`);
      } else if (typeof it?.text === "string") {
        parts.push(it.text as string);
      }
    }
    if (parts.length) return clip(parts.join("\n"));
  }
  return "";
}

function toolInput(payload: Record<string, unknown>): string {
  const raw = payload.rawInput;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    try {
      return JSON.stringify(raw);
    } catch {
      return "";
    }
  }
  return "";
}

type Group =
  | { kind: "user" | "agent" | "thought"; text: string; at: number }
  | { kind: "tool"; payload: Record<string, unknown>; at: number; status: string }
  | { kind: "plan"; entries: unknown[]; at: number };

/** fold stored rows into read-order groups (chunk rows merge; tool rows are discrete) */
export function foldMessages(messages: StoredMessage[]): Group[] {
  const groups: Group[] = [];
  const pushText = (kind: "user" | "agent" | "thought", text: string, at: number, mergeable: boolean): void => {
    const last = groups[groups.length - 1];
    if (mergeable && last && last.kind === kind) {
      // consecutive agent/thought chunks join (a user/tool/plan row breaks them because
      // it pushed a different group on top)
      (last as Extract<Group, { text: string }>).text += text;
      return;
    }
    groups.push({ kind, text, at });
  };
  for (const m of messages) {
    const p = (m.payload ?? {}) as Record<string, unknown>;
    switch (m.kind) {
      case "user": {
        const text = contentText(p);
        if (text) pushText("user", text, m.createdAt, false);
        break;
      }
      case "agent": {
        const text = contentText(p);
        // merge into a still-open agent run; a row that carries no text is skipped
        if (text) pushText("agent", text, m.createdAt, true);
        break;
      }
      case "thought": {
        const text = contentText(p);
        if (text) pushText("thought", text, m.createdAt, true);
        break;
      }
      case "tool": {
        const last = groups[groups.length - 1];
        const sameTool =
          last && last.kind === "tool" &&
          String(last.payload.toolCallId ?? m.toolCallId ?? "") === String(p.toolCallId ?? m.toolCallId ?? "");
        if (sameTool) {
          (last as Extract<Group, { payload: unknown }>).payload = p; // upserted row = latest wins
          (last as Extract<Group, { at: number }>).at = m.createdAt;
          break;
        }
        groups.push({ kind: "tool", payload: p, at: m.createdAt, status: String(p.status ?? "") });
        break;
      }
      case "plan": {
        groups.push({ kind: "plan", entries: Array.isArray(p.entries) ? p.entries : [], at: m.createdAt });
        break;
      }
      default:
        break; // meta/unknown kinds are not part of the transcript
    }
  }
  // merge adjacent same-kind agent/thought groups too (user rows interleaved as separate
  // groups keep the Q/A order intact)
  const merged: Group[] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && (g.kind === "agent" || g.kind === "thought") && prev.kind === g.kind) {
      (prev as Extract<Group, { text: string }>).text += (g as Extract<Group, { text: string }>).text;
    } else merged.push(g);
  }
  return merged;
}

const LABEL: Record<string, string> = { user: "User", agent: "Agent", thought: "Thought" };

export function renderMarkdown(session: ExportSessionHeader, messages: StoredMessage[]): string {
  const out: string[] = [];
  out.push(`# ${session.title || "session"}`, "");
  out.push(`- backend: ${session.backend}`);
  out.push(`- session id: ${session.id}${session.acpSessionId ? ` (agent side: ${session.acpSessionId})` : ""}`);
  out.push(`- working directory: ${session.workspace || session.cwd}`);
  out.push(`- created: ${ts(session.createdAt)} · exported: ${ts(Date.now())}`);
  out.push("");
  for (const g of foldMessages(messages)) {
    if (g.kind === "user" || g.kind === "agent" || g.kind === "thought") {
      out.push(`### ${LABEL[g.kind]} · ${ts(g.at)}`, "", (g as { text: string }).text.trim(), "");
    } else if (g.kind === "tool") {
      const p = g.payload as Record<string, unknown>;
      const title = String(p.title ?? "tool call");
      const status = String(p.status ?? "");
      out.push(`### Tool · ${title}${status ? ` (${status})` : ""} · ${ts(g.at)}`);
      const input = toolInput(p);
      if (input) out.push("", `Input: \`\`\`${input.length < 200 ? " " : "\n"}${input}\`\`\``, "");
      const detail = toolDetail(p);
      if (detail) out.push("```", detail, "```", "");
    } else if (g.kind === "plan") {
      out.push(`### Plan · ${ts(g.at)}`);
      for (const e of g.entries as { content?: string; status?: string }[]) {
        out.push(`- [${e.status ?? "?"}] ${e.content ?? ""}`);
      }
      out.push("");
    }
  }
  if (out.length <= 7) out.push("_（这个会话还没有消息记录。）_", "");
  return out.join("\n");
}

export function renderJson(session: ExportSessionHeader, messages: StoredMessage[]): string {
  return JSON.stringify(
    {
      format: "agentus-session/1",
      exportedAt: new Date().toISOString(),
      session,
      // lossless: every stored row with its raw payload, seq order preserved
      messages: messages.map((m) => ({
        seq: m.seq, kind: m.kind, createdAt: m.createdAt,
        toolCallId: m.toolCallId ?? null, payload: m.payload,
      })),
    },
    null,
    2,
  );
}

/** filename-safe slug from the title (never trust a display string in a header) */
export function exportFilename(title: string, ext: string): string {
  const slug = (title || "session")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return `${slug || "session"}.${ext}`;
}
