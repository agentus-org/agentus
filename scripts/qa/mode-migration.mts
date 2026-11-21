// Unit checks for retiring the 语音打断 mode from the frontend (issue #111 follow-up).
// The operator decided voice barge is too hard to get right; only 关键词打断 and 按键打断 remain,
// and the shipped wake phrase is 「摇摇」 (扶摇的摇). The server still stores old values for a while,
// so normalizeCall MUST migrate them or a fresh install would open in a now-hidden mode.
//
// Run: npx tsx scripts/qa/mode-migration.mts
import {
  CALL_DEFAULT, INTERRUPT_MODES, normalizeCall, matchesWakePhrase,
} from "../../packages/web/src/callSettings.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. shipped defaults -----------------------------------------------------------------------
check("default mode is keyword", CALL_DEFAULT.interruptMode === "keyword", CALL_DEFAULT.interruptMode);
check("default wake phrase is 摇摇", CALL_DEFAULT.wakePhrase === "摇摇", CALL_DEFAULT.wakePhrase);
check("only two modes are offered", INTERRUPT_MODES.length === 2
  && INTERRUPT_MODES.every((m) => m.id !== "voice"), JSON.stringify(INTERRUPT_MODES.map((m) => m.id)));

// --- 2. legacy migration: an untouched old install must not open in a hidden mode ---------------
{
  const old = normalizeCall({
    interruptMode: "voice", bargeSensitivity: 60, bargeMs: 300, silenceMs: 1500, minChars: 3,
    wakePhrase: "hi, Tus",
  });
  check("legacy voice mode migrates to keyword", old.interruptMode === "keyword", old.interruptMode);
  check("legacy hi,Tus phrase migrates to 摇摇", old.wakePhrase === "摇摇", old.wakePhrase);
}
{
  const none = normalizeCall(null);
  check("no stored settings -> keyword/摇摇", none.interruptMode === "keyword" && none.wakePhrase === "摇摇",
    JSON.stringify(none));
}

// --- 3. deliberate choices are preserved -------------------------------------------------------
{
  const button = normalizeCall({ interruptMode: "button", wakePhrase: "hi, Tus" });
  check("an explicit button choice survives", button.interruptMode === "button", button.interruptMode);
  const custom = normalizeCall({ interruptMode: "keyword", wakePhrase: "小灵" });
  check("a custom phrase survives", custom.wakePhrase === "小灵", custom.wakePhrase);
}

// --- 4. 摇摇 matches the way ASR writes it ------------------------------------------------------
check("摇摇 matches itself", matchesWakePhrase("摇摇", "摇摇"));
check("spaced 摇 摇 matches (ASR inserts spaces)", matchesWakePhrase("小 摇 摇 同学", "摇摇"));
check("a different homophone does not match (扶摇的摇 is explicit)", !matchesWakePhrase("遥遥", "摇摇"));

console.log(`\nmode-migration: ${pass} ok / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;
