import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { cockpit } from "./state";
import { bootstrapTheme } from "./theme";
import { dictation, loadVoiceCaps, resampleToPcm16, voiceCaps } from "./voice";
import "./theme.css";

// Paint the saved palette before the first render: the login card is part of the app and
// a white flash on a dark cockpit (or the reverse) is the first thing anyone sees.
bootstrapTheme();

// debug handles for browser QA (guarded, dev-console only). __voice exists because a
// recogniser is otherwise only testable by talking into a microphone: it lets a script
// drive the same code path (URL, hotwords, resampler) the mic would.
(window as unknown as Record<string, unknown>).__cockpit = cockpit;
(window as unknown as Record<string, unknown>).__voice = { dictation, loadVoiceCaps, resampleToPcm16, voiceCaps };

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
