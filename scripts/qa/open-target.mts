// The web half of the tap contract: `?session=<id>` decides where the page lands, ONCE.
//
// A notification tap navigates the WebView here with the session in the query string (see
// docs/android-notify-contract.md §5.2). Two things must hold, and the second is the one that is easy
// to get wrong: the parameter picks the slot, and it does NOT keep overriding the operator afterwards
// (a stale query string must not drag them back on every reconnect).
//
// Run: npm run open-target
let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const stored = new Map<string, string>();
let replacedWith: string | null = null;

// The browser APIs the store uses, stubbed: this test is about the store's own rule.
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
};
g.location = { href: "https://host:38787/?session=bbb&x=1", search: "?session=bbb&x=1" };
g.history = { replaceState: (_s: unknown, _t: unknown, url: string) => { replacedWith = url; } };

const { cockpit } = await import("../../packages/web/src/state.ts");

const sessions = [
  { id: "aaa", title: "first", status: "ready" },
  { id: "bbb", title: "the one the notification was about", status: "ready" },
];
cockpit.apply({ t: "sessions", sessions } as never);

check("a tap target (?session=) wins over the slot the operator left",
  cockpit.getSnapshot().activeId === "bbb", String(cockpit.getSnapshot().activeId));
check("the parameter is dropped from the URL after it is honoured",
  replacedWith !== null && !String(replacedWith).includes("session=") && String(replacedWith).includes("x=1"),
  String(replacedWith));
check("…so it is remembered instead (localStorage)", stored.get("agentus.active") === "bbb",
  String(stored.get("agentus.active")));
check("no `openTarget` is consumed twice: the URL no longer has it",
  !String(replacedWith ?? "").includes("bbb"), String(replacedWith));

// and with no parameter, the operator's own last slot still wins — the old behaviour is intact
stored.set("agentus.active", "aaa");
g.location = { href: "https://host:38787/", search: "" };
const { cockpit: fresh } = await import("../../packages/web/src/state.ts?fresh=1");
fresh.apply({ t: "sessions", sessions } as never);
check("without ?session= the remembered slot is restored (no regression)",
  fresh.getSnapshot().activeId === "aaa", String(fresh.getSnapshot().activeId));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
