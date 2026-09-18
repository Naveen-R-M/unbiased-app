#!/usr/bin/env bash
# Unbiased desktop installer.
#
#   curl -fsSL https://raw.githubusercontent.com/circuitandchisel/unbiased-app-releases/main/install.sh | bash
#
# Downloads the latest release DMG, verifies its SHA-256 against the release's
# SHA256SUMS, installs Unbiased.app to /Applications, and clears the download
# quarantine flag so the first launch doesn't hit Gatekeeper.
#
# THE QUARANTINE STRIP IS THE POINT of this script. The app is ad-hoc signed,
# not Developer ID signed + notarized, so a hand-downloaded DMG makes macOS
# refuse to open it ("Apple could not verify…") until the user right-clicks →
# Open. Removing com.apple.quarantine here does the same thing, once, in a way
# the whole team can copy-paste.
#
# This file lives in unbiased-app/scripts/ (the source of truth) and is
# pushed verbatim to the public releases repo by .github/workflows/release.yml.
set -euo pipefail

REPO="circuitandchisel/unbiased-app-releases"
APP_NAME="Unbiased.app"
INSTALL_DIR="${UNBIASED_INSTALL_DIR:-/Applications}"

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '  %s\n' "$1"; }

# ── Platform gate ───────────────────────────────────────────────────────
# The app ships arm64-only (Electron AND the bundled Pareto engine), so an
# Intel Mac cannot run it at all — fail with a clear reason instead of
# installing something that dies on launch.
[ "$(uname -s)" = "Darwin" ] || die "Unbiased desktop is macOS-only (this is $(uname -s))."
if [ "$(uname -m)" != "arm64" ]; then
  die "Unbiased desktop requires an Apple Silicon Mac (M1 or newer); this Mac is $(uname -m)."
fi
os_major="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$os_major" -lt 12 ]; then
  die "Unbiased desktop requires macOS 12 (Monterey) or newer; this Mac runs $(sw_vers -productVersion)."
fi

for cmd in curl shasum hdiutil ditto; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

printf '\nInstalling Unbiased desktop…\n\n'

# ── Resolve the latest release ──────────────────────────────────────────
api="https://api.github.com/repos/$REPO/releases/latest"
release_json="$(curl -fsSL "$api")" || die "could not reach $REPO releases (is the repo public and a release published?)"

tag="$(printf '%s' "$release_json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$tag" ] || die "could not determine the latest version"

# Pull the .dmg and SHA256SUMS download URLs out of the release payload.
dmg_url="$(printf '%s' "$release_json" | tr ',' '\n' | sed -n 's/.*"browser_download_url": *"\([^"]*\.dmg\)".*/\1/p' | head -1)"
sums_url="$(printf '%s' "$release_json" | tr ',' '\n' | sed -n 's/.*"browser_download_url": *"\([^"]*SHA256SUMS\)".*/\1/p' | head -1)"
[ -n "$dmg_url" ] || die "release $tag has no .dmg asset"

info "version:  $tag"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; [ -n "${mnt:-}" ] && hdiutil detach "$mnt" -quiet 2>/dev/null || true' EXIT

dmg="$tmp/$(basename "$dmg_url")"
info "download: $(basename "$dmg_url")"
curl -fsSL --retry 3 --retry-delay 2 -o "$dmg" "$dmg_url" || die "download failed"

# ── Verify ──────────────────────────────────────────────────────────────
# A corrupted or tampered 188MB download should never reach /Applications.
if [ -n "$sums_url" ]; then
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$sums_url" || die "could not download SHA256SUMS"
  expected="$(awk -v f="$(basename "$dmg")" '$2 == f || $2 == "*"f {print $1}' "$tmp/SHA256SUMS" | head -1)"
  if [ -n "$expected" ]; then
    actual="$(shasum -a 256 "$dmg" | awk '{print $1}')"
    [ "$actual" = "$expected" ] || die "checksum mismatch — refusing to install (expected $expected, got $actual)"
    info "checksum: verified"
  else
    info "checksum: no entry for $(basename "$dmg") in SHA256SUMS — skipping"
  fi
else
  info "checksum: SHA256SUMS not published for $tag — skipping"
fi

# ── Install ─────────────────────────────────────────────────────────────
info "mounting…"
# NOT -quiet: it suppresses the attach table we parse the mount point out of,
# which would leave the image mounted and this script unable to find the app.
mnt="$(hdiutil attach "$dmg" -nobrowse -mountrandom /tmp | awk -F'\t' '/\/tmp\//{print $NF; exit}')"
[ -n "$mnt" ] && [ -d "$mnt/$APP_NAME" ] || die "could not find $APP_NAME inside the disk image"

target="$INSTALL_DIR/$APP_NAME"
staged="$INSTALL_DIR/.$APP_NAME.incoming"

# ditto preserves the code signature and resource forks; cp -R can break the
# bundle's seal, which would make macOS reject the app.
#
# Stage the new copy BESIDE the target and swap only once it has landed.
# Deleting the old app first means any later failure — bad payload, full
# disk, no write access — leaves the user with no app at all.
#
# Braces around every expansion are not decoration: `$INSTALL_DIR…` makes
# bash 3.2 in a UTF-8 locale read the ellipsis bytes as part of the variable
# NAME, so `set -u` kills the script mid-install. ${INSTALL_DIR} is immune.
info "installing to ${INSTALL_DIR}…"
rm -rf "$staged"
ditto "$mnt/$APP_NAME" "$staged" || die "install failed (no write access to ${INSTALL_DIR}?)"
if [ -d "$target" ]; then
  info "replacing existing install at ${target}"
  rm -rf "$target" || { rm -rf "$staged"; die "could not remove ${target} (try: sudo rm -rf '${target}')"; }
fi
mv "$staged" "$target" || { rm -rf "$staged"; die "could not move the new app into place"; }

hdiutil detach "$mnt" -quiet || true
mnt=""

# ── Clear quarantine ────────────────────────────────────────────────────
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
if xattr "$target" 2>/dev/null | grep -q com.apple.quarantine; then
  printf '\n\033[33mnote:\033[0m could not clear the quarantine flag. Right-click %s → Open the first time.\n' "$APP_NAME"
fi

printf '\n\033[32m✓\033[0m Unbiased %s installed to %s\n\n' "$tag" "$target"
printf 'Launch it from Applications (or: open -a Unbiased).\n'
printf 'On first run, paste your Unbiased API key — get one at https://platform.unbiased.ai\n\n'
