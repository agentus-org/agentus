import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>AgentSlot</h1>
      <p>Keep your agents on the track.</p>
      <p style={{ opacity: 0.6 }}>M0 skeleton — server health: <a href="/healthz">/healthz</a></p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
