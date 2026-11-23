// Forward-compatibility shim for the Agentus -> Hermes Studio rename.
//
// The canonical environment prefix is now HERMES_STUDIO_*. Launchers, launchd
// plists and QA scripts written before the rename still set AGENTUS_*. Import
// this module ONCE, before anything reads env, and every legacy AGENTUS_X is
// mirrored into HERMES_STUDIO_X when (and only when) the new name is unset ---
// so an explicit HERMES_STUDIO_X always wins and nothing can be silently
// overridden by a stale launcher.
//
// Import for side effects only: `import ".../env-alias.mjs";`
for (const key of Object.keys(process.env)) {
  if (!key.startsWith("AGENTUS_")) continue;
  const canonical = "HERMES_STUDIO_" + key.slice("AGENTUS_".length);
  if (process.env[canonical] === undefined) {
    process.env[canonical] = process.env[key];
  }
}
