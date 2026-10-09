import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { cockpit } from "./state";
import { bootstrapTheme } from "./theme";
import { renderMarkdown } from "./Markdown";
import { dictation, loadVoiceCaps, resampleToPcm16, voiceCaps } from "./voice";
import "./theme.css";

// Paint the saved palette before the first render: the login card is part of the app and
// a white flash on a dark cockpit (or the reverse) is the first thing anyone sees.
bootstrapTheme();

// debug handles for browser QA (guarded, dev-console only). __voice exists because a
// recogniser is otherwise only testable by talking into a microphone: it lets a script
// drive the same code path (URL, hotwords, resampler) the mic would. __renderMarkdown is
// the same idea for the local-file links/images in a reply — a sweep can render a fixture
// and click it without needing an agent to emit exactly that markdown.
(window as unknown as Record<string, unknown>).__cockpit = cockpit;
(window as unknown as Record<string, unknown>).__voice = { dictation, loadVoiceCaps, resampleToPcm16, voiceCaps };
(window as unknown as Record<string, unknown>).__renderMarkdown = renderMarkdown;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
