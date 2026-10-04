// Unit checks for the reader's utterance splitter (packages/web/src/speech.ts).
//
// Why a unit test and not a browser sweep: the rule is pure text in, pure text out, and the mock
// agent's canned reply cannot produce the case that matters — a 2-character opening sentence. The
// browser sweeps check the plumbing (that a request is in flight while the current clip plays);
// this checks the decision that keeps a boundary from needing one.
//
// Run: npm run sentence-units   (tsx; no browser, no server)
import { splitSentences, SHORT_SENTENCE, GLUE_MAX } from "../../packages/web/src/speech.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const show = (a: string[]): string => JSON.stringify(a);

// 1. The operator's own case, straight out of a call transcript: the answer opens with 「能。」
//    then continues. One utterance, so that boundary cannot go silent.
{
  const t = "能。我可以同时开好几个子任务，每个有自己的独立上下文和终端，互不打扰。";
  const { done, tail } = splitSentences(t);
  check("a 2-character opening sentence is read together with the next one",
    done.length === 1 && done[0].startsWith("能。 我可以同时") && tail === "", `${done.length} utterances ${show(done)}`);
}
// 2. 5 characters (「听得清楚。」) — the other measured opener.
{
  const { done } = splitSentences("听得清楚。有重复，\"你好\"说了两遍，可能是有意，也可能是识别没去重。");
  check("a 5-character opening sentence is glued too", done.length === 1, show(done));
}
// 3. …but what is already long enough is left alone: gluing must not swallow a whole answer.
{
  const t = "文字这边没问题，这一句完整、没截断、也没重复。现在听不到你，是语音那头的事，所以我只能判断字。";
  const { done } = splitSentences(t);
  check("two long sentences stay two utterances", done.length === 2 && done[0].startsWith("文字这边"), show(done));
}
// 4. A short piece in front of a piece that is already at the server's own limit is left where it
//    is: gluing would produce a clip the server splits again, i.e. the same boundary, later.
{
  const long = "长".repeat(GLUE_MAX);
  const { done } = splitSentences(`能。${long}。`);
  check("gluing never builds a clip longer than the server's own chunk",
    done.length === 2 && done[1].length === GLUE_MAX + 1, show(done.map((d) => d.length)));
}
// 5. The invariant the call's queue counter depends on: as the answer streams in, an utterance that
//    was already reported must never change its text. (A re-glue behind the reader's back would make
//    it speak, or skip, a sentence.)
{
  const full = "能。我可以同时开好几个子任务，每个有自己的独立上下文和终端，互不打扰。还有别的。";
  let stable = true, detail = "";
  for (let n = 1; n <= full.length; n++) {
    const a = splitSentences(full.slice(0, n)).done;
    const b = splitSentences(full).done;
    for (const [i, piece] of a.entries()) {
      if (b[i] !== piece) { stable = false; detail = `prefix ${n}: ${JSON.stringify(piece)} → ${JSON.stringify(b[i])}`; }
    }
    if (a.length > b.length) { stable = false; detail = `prefix ${n}: more utterances than the full text`; }
  }
  check("an utterance already handed out never changes as more text arrives", stable, detail);
}
// 6. A short sentence at the END of what has arrived is held back, not handed out: the next
//    sentence may still glue to it, and an utterance already given to the reader must not change.
//    It rides back in as part of the tail, which the call flushes when the turn ends.
{
  const { done, tail } = splitSentences("第一句在这里。第二句还没写完");
  check("a trailing short sentence is held back rather than handed out",
    done.length === 0 && tail === "第一句在这里。 第二句还没写完", `${show(done)} tail=${JSON.stringify(tail)}`);
}
// 7. …and the moment its successor arrives it is spoken WITH it — the operator's stall case, in two
//    steps of one stream.
{
  const first = splitSentences("能。");
  const then = splitSentences("能。我可以同时开好几个子任务。");
  check("a held-back sentence joins the next one as it arrives",
    first.done.length === 0 && then.done.length === 1 && then.done[0].startsWith("能。 我可以同时"),
    `${show(first.done)} → ${show(then.done)}`);
}
// 8. Latin sentences are NOT split on the ASCII period — that is the chunker's job (splitForSpeech
//    breaks on "." at 80 characters), and splitting here would cut "3.5" and "e.g." in half. Pinned
//    so the choice stays deliberate.
{
  const t = "Sure. Let me look at the logs first, then I will tell you what broke.";
  const { done, tail } = splitSentences(t);
  check("an English answer is not split on the Latin period (documented, not accidental)",
    done.length === 0 && tail === t, `${show(done)} tail=${JSON.stringify(tail.slice(0, 20))}`);
}
// 9. SHORT_SENTENCE is a *lower* bound on an utterance: whatever it is, a single short sentence on
//    its own is a clip shorter than the wait for the next one. Guards against someone "tidying" the
//    constant down to 0 and silently deleting the rule.
check("the threshold is a real length (not disabled)", SHORT_SENTENCE >= 8, `SHORT_SENTENCE=${SHORT_SENTENCE}`);

console.log(`\nsentence-units: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
