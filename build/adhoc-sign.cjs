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

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: "inherit",
  });
  // Fail the build if the seal isn't valid — better than shipping a bundle
  // that dies on someone else's Mac.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log("  • ad-hoc signed and verified", appPath);
};
