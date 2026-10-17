// A message another agent sent must not be drawn as the operator's own words.
//
// The cockpit's `session send` delivers into a target session as a `user` row — it has to, it starts a
// turn — so without a marker the page renders it under the «YOU» label with the operator's bubble
// styling: their words, which they never typed. The fix is `payload.origin` on the stored row and a
// `from` field on the client view. This drives the REAL store (the same `apply` the WebSocket calls)
// and asserts the view model, so it fails if either half of that contract is dropped.
//
// Run: npx tsx scripts/qa/message-origin.mts
(globalThis as unknown as { localStorage: unknown }).localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const { cockpit } = await import("../../packages/web/src/state.ts");

const SID = "sess_target";
const FROM = "sess_sender";
let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = ""): void => {
  ok ? (pass += 1) : (fail += 1);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, backend: "mock", acpSessionId: null, cwd: "/tmp", status: "ready", pid: null,
  title: id, createdAt: 1, lastAt: 1, archivedAt: null, workspace: null, contextLimit: null, home: null,
  ...extra,
});

const apply = (frame: Record<string, unknown>) =>
  (cockpit as unknown as { apply: (f: unknown) => void }).apply(frame);

const view = () => (cockpit as unknown as { getSnapshot: () => { active: { msgs: unknown[] } | null } }).getSnapshot();

apply({ t: "sessions", sessions: [row(SID)], cold: [], archived: [] });
apply({ t: "session", session: row(SID) } as unknown as Record<string, unknown>);
(cockpit as unknown as { setActive: (id: string) => void }).setActive(SID);

// two rows: one typed by the operator, one sent by another session's agent
apply({ t: "messages", sessionId: SID, hasMore: false, messages: [
  { seq: 1, sessionId: SID, kind: "user", createdAt: 100, payload: { text: "我打的", attachments: [] } },
  { seq: 2, sessionId: SID, kind: "user", createdAt: 200,
    payload: { text: "别的 agent 说的", attachments: [], origin: { sessionId: FROM, title: "帮我修登录" } } },
  { seq: 3, sessionId: SID, kind: "user", createdAt: 300,
    payload: { text: "署名丢了也不能冒充", attachments: [], origin: { sessionId: FROM } } },
] });

const msgs = view().active?.msgs as { kind: string; text?: string; from?: { id: string; title: string } }[];
const byText = (t: string) => msgs?.find((m) => m.text === t);

check("a message the operator typed has NO `from` (still labelled YOU)", byText("我打的")?.from === undefined,
  JSON.stringify(byText("我打的")?.from ?? null));
check("a cross-session message carries `from` (origin.sessionId + title)",
  byText("别的 agent 说的")?.from?.id === FROM && byText("别的 agent 说的")?.from?.title === "帮我修登录",
  JSON.stringify(byText("别的 agent 说的")?.from ?? null));
check("an origin WITHOUT a title still marks it as not-the-operator (never falls back to YOU)",
  byText("署名丢了也不能冒充")?.from?.id === FROM && byText("署名丢了也不能冒充")?.from?.title === "另一个会话",
  JSON.stringify(byText("署名丢了也不能冒充")?.from ?? null));
check("it stays a user row (it is a turn boundary, not an agent reply)",
  byText("别的 agent 说的")?.kind === "user", String(byText("别的 agent 说的")?.kind));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
