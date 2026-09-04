// electron-builder afterPack hook: ad-hoc sign the whole bundle.
//
// Without this, only Electron's own linker signature is present, and it does
// NOT cover the engine binaries we add via extraResources. macOS on Apple
// Silicon refuses to run code whose signature doesn't seal the bundle, which
// shows up as "the application is damaged" on some machines. An ad-hoc deep
// signature (identity "-") seals everything and costs nothing.
//
// This is NOT a substitute for Developer ID signing + notarization: a
// downloaded ad-hoc app is still quarantined and needs a right-click → Open
// (or `xattr -dr com.apple.quarantine`) the first time.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

/** codesign's default designated requirement for an ad-hoc bundle is the
 *  cdhash — "this exact build". TCC stores an Accessibility grant against that
 *  requirement, so every release changed the cdhash and silently invalidated
 *  the grant: the row stayed in System Settings with its switch still on, and
 *  macOS denied the new binary anyway. Pinning the requirement to the bundle
 *  identifier instead makes the grant survive updates, which is what the dev
 *  launcher and the accessibility bridge have always done. */
function designatedRequirement(id) {
  return `=designated => identifier "${id}"`;
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  if (!id) throw new Error("no appId to pin the designated requirement to");

  // Deep first, so nested code (the engine, the bridge) is sealed and keeps its
  // OWN identifier. Passing --identifier here instead would stamp the app's id
  // onto every nested binary and clobber the bridge's ai.unbiased.ax identity.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: "inherit",
  });
  // Then re-seal the outer bundle alone, carrying the stable requirement.
  execFileSync(
    "codesign",
    ["--force", "--sign", "-", "--identifier", id, "--requirements", designatedRequirement(id), "--timestamp=none", appPath],
    { stdio: "inherit" },
  );

  // Fail the build if the seal isn't valid — better than shipping a bundle
  // that dies on someone else's Mac.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });

  // And fail it if the requirement did not take. A cdhash requirement here is
  // the bug this hook exists to prevent, and it is invisible until someone's
  // permission quietly stops working after an update.
  const dr = execFileSync("codesign", ["-d", "-r-", appPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (!dr.includes(`designated => identifier "${id}"`)) {
    throw new Error(`designated requirement is not pinned to ${id} — Accessibility grants would break on every update:\n${dr}`);
  }
  console.log(`  • ad-hoc signed, verified, and pinned to identifier "${id}"`, appPath);
};
