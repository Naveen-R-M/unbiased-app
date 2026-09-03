/** Is this a real shipped build, or a development run?
 *
 *  `app.isPackaged` is the obvious answer, and it is the wrong one. The dev
 *  launcher runs the app out of a signed .app bundle in ~/Applications so that
 *  macOS gives it a stable TCC identity across restarts — and electron then
 *  reports `isPackaged === true`, even though every line of code is being
 *  served from a checkout by vite.
 *
 *  Ten call sites in the main process read that flag to mean "shipped build".
 *  Under the launcher all ten took the production path: the engine was looked
 *  for inside Contents/Resources/engine and never found, the learning sidecar
 *  likewise, bundled skills resolved to a directory that does not exist, the
 *  Accessibility recovery flow disabled itself, the permission card named the
 *  wrong application, and the auto-updater armed itself against the dev
 *  bundle. `npm run dev` produced an app that rendered and never started an
 *  engine.
 *
 *  The launcher exports UNBIASED_DEV_APP_NAME. A run carrying it is a
 *  development run whatever its bundle looks like, so that — not the bundle —
 *  is what decides. */
export function isProductionBuild(env: { isPackaged: boolean; devAppName?: string | undefined }): boolean {
  // Absent is the common case; "" is nearly as common, and treating a blank
  // value as "this is dev" would silently disable updates in the real app.
  if (env.devAppName?.trim()) return false;
  return env.isPackaged;
}
