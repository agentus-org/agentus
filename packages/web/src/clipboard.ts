// Copy text to the clipboard, from a page that may be served over plain http.
//
// `navigator.clipboard` only exists in a SECURE CONTEXT, and the cockpit's LAN entry is
// plain `http://<lan-ip>:8788` — so the execCommand path is load-bearing here, not a
// legacy courtesy (measured 2026-10-08: on that origin `navigator.clipboard` is `undefined`
// while the https entry has it). Without the fallback every copy button silently throws
// (`undefined.writeText(...)` — the optional chain yields undefined, and `.then` on it is a
// TypeError that no `try` around the click handler turns into feedback).
//
// Returns whether the text actually made it. Callers show the result; a copy that fails
// quietly is the shape the operator cannot tell from a broken button.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
