import { test } from "node:test";
import assert from "node:assert/strict";
import { isProductionBuild } from "./runtime-mode";

// Measured on main, 2026-09-03: the dev launcher runs the app out of a signed
// .app bundle in ~/Applications (so macOS gives it a stable TCC identity), and
// electron then reports app.isPackaged === true even though every line of code
// comes from a checkout. Ten call sites read that flag to mean "shipped
// build", and all ten took the production path: the engine was looked for in
// Contents/Resources/engine and never found, so `npm run dev` produced an app
// that rendered but never started an engine.

test("a shipped build is a production build", () => {
  assert.equal(isProductionBuild({ isPackaged: true }), true);
});

test("the dev launcher is NOT production, even though its bundle is packaged", () => {
  // The whole regression, in one assertion.
  assert.equal(isProductionBuild({ isPackaged: true, devAppName: "Unbiased Dev" }), false);
});

test("a plain electron-vite run is not production", () => {
  assert.equal(isProductionBuild({ isPackaged: false }), false);
  assert.equal(isProductionBuild({ isPackaged: false, devAppName: "Unbiased Dev" }), false);
});

test("an empty or blank dev name is not a dev marker", () => {
  // Env vars arrive as "" far more often than they arrive absent, and treating
  // "" as "this is dev" would disable updates in the shipped app.
  assert.equal(isProductionBuild({ isPackaged: true, devAppName: "" }), true);
  assert.equal(isProductionBuild({ isPackaged: true, devAppName: "   " }), true);
  assert.equal(isProductionBuild({ isPackaged: true, devAppName: undefined }), true);
});
