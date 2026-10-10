import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // NOT cosmetic — this is the fix for a frozen terminal. `@xterm/xterm@6.0.0` ships
    // PRE-MINIFIED ESM, and the default `target: "modules"` (= es2020) makes esbuild lower
    // `r ||= {}` inside its `InputHandler.requestMode` into `void 0 || (s = {})` with `s`
    // never declared (esbuild#4508). The first DECRQM query — `CSI ? Ps $ p`, which vim,
    // nvim, htop, less and every TUI send on startup — then throws a ReferenceError inside
    // xterm's write-buffer timer chain, which dies with it: the pty and the socket stay
    // healthy, keystrokes still reach the shell, but NOTHING is ever parsed or painted
    // again. Hence "vi opens, then the panel is dead". es2021+ skips the lowering and the
    // pattern survives verbatim. Verified in the built bundle, not by reasoning: the
    // shipped asset must contain `requestMode(e,t){(E=>…)(n||={})`, never `void 0||(`.
    target: "es2022",
  },
  server: {
    host: true, // LAN access for phone testing
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/healthz": "http://127.0.0.1:8788",
      "/api": "http://127.0.0.1:8788",
      "/ws": { target: "ws://127.0.0.1:8788", ws: true },
    },
  },
});
