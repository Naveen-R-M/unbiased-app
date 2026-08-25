import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Drops outside a handled zone must be swallowed here.
//
// A file dropped anywhere Chromium does not have a handler for is treated as a
// navigation: the window replaces the app with the file. In a browser that is
// merely surprising; in an Electron shell it blanks the UI with no way back
// except reopening the window, and it takes the whole renderer's state with it.
//
// These run in the bubble phase, so a component's own onDrop (React listens on
// the root container, inside document) has already had its turn — the chat's
// drop handler still works, and everything it did not claim lands here and is
// discarded instead of navigating.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => e.preventDefault());
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
