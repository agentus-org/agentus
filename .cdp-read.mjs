// Minimal CDP client for the app's WebView (devtools socket forwarded to 127.0.0.1:9333).
// usage: node cdp.mjs [navigateUrl] <expression>
import WebSocket from "ws";

const args = process.argv.slice(2);
const navigate = args.length > 1 ? args[0] : null;
const expr = args.length > 1 ? args[1] : args[0];

const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = targets.find((t) => t.type === "page") || targets[0];
if (!page) throw new Error("no page target: " + JSON.stringify(targets.map((t) => t.type)));
console.error("target:", page.url || page.title);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
});
await new Promise((r) => ws.on("open", r));

if (navigate) {
  await send("Page.enable");
  await send("Page.navigate", { url: navigate });
  await new Promise((r) => setTimeout(r, 5000));
}
const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(out.result?.value ?? out.result ?? out));
ws.close();
process.exit(0);
