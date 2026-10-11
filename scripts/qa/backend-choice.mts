// Which backends the new-session form may offer — decided without a browser.
//
// The rule exists because the mock agent is a QA backend that LOOKS like a working agent: it answers
// with canned text and spends nothing. It must not be a choice on an instance the operator actually
// works in (his words: 「默认不要放 mock agent 吧，这个不应该只在 dev 中使用吗」), and it must stay a
// choice where the QA sweeps run. The server says which instance this is (`/api/version.dev`, from
// scripts/dev.sh's DEV_TREE), and this suite pins the mapping from that flag to the row list.
//
// Run: npx tsx scripts/qa/backend-choice.mts
import { backendChoices } from "../../packages/web/src/agents.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const rows = [
  { id: "hermes", kind: "hermes" },
  { id: "mock", kind: "mock" },
  { id: "qoder", kind: "qoder" },
];
const ids = (r: { id: string }[]) => r.map((x) => x.id).join(",");

// ---- a live instance: the QA backend is not offered --------------------------------------------
{
  const got = backendChoices(rows, false);
  check("on a live instance the mock agent is not offered", !got.some((r) => r.kind === "mock"), ids(got));
  check("…and every real backend still is, in the server's order", ids(got) === "hermes,qoder", ids(got));
}

// ---- a dev instance: it is, next to the real ones ----------------------------------------------
{
  const got = backendChoices(rows, true);
  check("on a dev instance the mock agent is offered", got.some((r) => r.kind === "mock"), ids(got));
  check("…without reordering anything", ids(got) === "hermes,mock,qoder", ids(got));
}

// ---- the filter yields rather than emptying the form -------------------------------------------
{
  const onlyMock = [{ id: "mock", kind: "mock" }];
  check("a machine whose only backend is the mock is still usable (the filter yields)",
    ids(backendChoices(onlyMock, false)) === "mock" && backendChoices([], false).length === 0,
    ids(backendChoices(onlyMock, false)));
}

// ---- the rows are passed through untouched (the form renders them as-is) -----------------------
{
  const got = backendChoices(rows, false);
  check("the surviving rows are the SAME objects (no copies, no renamed fields)",
    got[0] === rows[0] && got[1] === rows[2]);
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
