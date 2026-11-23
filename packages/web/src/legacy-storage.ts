// One-time localStorage migration (Agentus -> Hermes Studio). Imported FIRST in main.tsx so it
// runs before bootstrapTheme()/state read any preference key. Legacy agentus.* keys are copied into
// the new hermes-studio.* namespace (new value always wins) and then removed, so an open tab from
// before the upgrade keeps its layout/theme/voice prefs and nothing is written back to the old key.
(function migrateLocalStorage() {
  try {
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("agentus.")) legacy.push(k);
    }
    for (const old of legacy) {
      const next = "hermes-studio." + old.slice("agentus.".length);
      if (localStorage.getItem(next) === null) {
        const v = localStorage.getItem(old);
        if (v !== null) localStorage.setItem(next, v);
      }
      localStorage.removeItem(old);
    }
    // the one CSS attribute selector uses a distinct prefix
  } catch { /* private mode / storage disabled — nothing to migrate */ }
})();
export {};
