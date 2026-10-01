import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { cockpit } from "./state";
import "./theme.css";

// debug handle for browser QA (guarded, dev-console only)
(window as unknown as Record<string, unknown>).__cockpit = cockpit;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
