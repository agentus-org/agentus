// Ambient declaration for the side-effect-only env-alias shim. Do NOT declare `process` here —
// that would shadow the real NodeJS.Process global and break every `.pid`/`.exit`/`.on()` call
// site. The import is pure runtime; no type surface is needed.
export {};
