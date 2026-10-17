// The web half of the notification-tap contract, and the address bar as a session locator (issue #20).
//
// A tap navigates the WebView here with the session in the query string (docs/android-notify-contract.md
// §5.2). Two things must hold: the parameter decides where the page lands, and — since #20 — the URL
// KEEPS saying which session is on screen, so 「发给自己」「收藏」「刷新」 all land on the same
// conversation. The rule that replaced the old one-shot read is a reconciliation:
//
//   · a ?session= that DISAGREES with the active session is followed (load, popstate, the App's hook);
//   · the operator switching slots rewrites the URL (replaceState — no history spam, no Back-button undo);
//   · a URL that already tells the truth is left completely alone.
//
// Run: npm run open-target
let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const stored = new Map<string, string>();
const replaced: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;

// The browser APIs the store uses, stubbed: this test is about the store's own rule, not the DOM.
g.localStorage = {
  getItem: (k: string) => stored.get(k) ?? null,
  setItem: (k: string, v: string) => void stored.set(k, v),
  removeItem: (k: string) => void stored.delete(k),
};
/** A tiny MUTABLE `location`: a tap or an omnibox navigation is just a new href. */
const loc = { href: "https://host:38788/?session=bbb&x=1", search: "?session=bbb&x=1" };
g.location = loc;
// replaceState must MOVE the page like a browser does, or the next write sees a stale URL and churns
// (the first version only recorded the call, and 「re-selecting writes nothing」 failed on a stub bug).
g.history = {
  state: null,
  replaceState: (_s: unknown, _t: unknown, url: string) => { replaced.push(url); loc.href = url; },
};
g.window = { addEventListener: () => {} }; // a real page has one; the store only adds listeners

const { cockpit } = await import("../../packages/web/src/state.ts");

const sessions = [
  { id: "aaa", title: "first", status: "ready" },
  { id: "bbb", title: "the one the notification was about", status: "ready" },
];
cockpit.apply({ t: "sessions", sessions } as never);
/** The store publishes its snapshot on a frame, so read the field the rule actually writes. */
const activeId = (c: { activeId: string | null; getSnapshot: () => { activeId: string | null } }) =>
  c.activeId ?? c.getSnapshot().activeId;

check("a tap target (?session=) wins over the slot the operator left",
  activeId(cockpit) === "bbb", String(activeId(cockpit)));
check("…and the parameter is KEPT: the URL now truthfully names what is on screen",
  loc.href.includes("session=bbb"), loc.href);
check("…without dropping the other parameters it arrived with", loc.href.includes("x=1"), loc.href);
check("…so it is remembered too (localStorage, the fallback for a bare `/`)",
  stored.get("agentus.active") === "bbb", String(stored.get("agentus.active")));

// switching slots rewrites the URL instead of leaving a stale session behind
replaced.length = 0;
cockpit.setActive("aaa");
check("switching slots rewrites ?session= (the address bar never lies about the view)",
  replaced.length === 1 && String(replaced[0]).includes("session=aaa"), JSON.stringify(replaced));
check("…once, not once per row repaint", replaced.length === 1, `${replaced.length} replaceState calls`);
check("…and the remembered slot follows", stored.get("agentus.active") === "aaa", String(stored.get("agentus.active")));

// re-selecting the slot already on screen must not churn the URL
replaced.length = 0;
cockpit.setActive("aaa");
check("re-selecting the same slot writes nothing (no history churn, no reflow)", replaced.length === 0,
  JSON.stringify(replaced));

// a URL that disagrees is followed — this is the reconciliation half
loc.href = "https://host:38788/?session=bbb";
cockpit.followUrl();
check("a URL that names another session is followed (link pasted, popstate, App hook)",
  activeId(cockpit) === "bbb", String(activeId(cockpit)));

replaced.length = 0;
loc.href = "https://host:38788/?session=bbb";
cockpit.followUrl();
check("following a URL that agrees with the view does nothing at all", replaced.length === 0,
  JSON.stringify(replaced));

// an id this page has never seen must not blank the cockpit
loc.href = "https://host:38788/?session=nope";
cockpit.followUrl();
check("an unknown id in the URL is ignored (the rail stays where it was)",
  activeId(cockpit) === "bbb", String(activeId(cockpit)));

// and with no parameter, the operator's own last slot still wins — the old fallback is intact
stored.set("agentus.active", "aaa");
loc.href = "https://host:38788/";
const { cockpit: fresh } = await import("../../packages/web/src/state.ts?fresh=1");
fresh.apply({ t: "sessions", sessions } as never);
check("without ?session= the remembered slot is restored (no regression)",
  activeId(fresh) === "aaa", String(activeId(fresh)));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${ok} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
