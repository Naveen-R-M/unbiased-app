import { createHash } from "node:crypto";
import { join } from "node:path";

/** Attaching an image the app cannot decode.
 *
 *  Measured 2026-09-09: a user attached a WebP logo and asked for it to be
 *  redrawn in a design app. Electron's nativeImage cannot decode WebP, so the
 *  extension said "image" and the decode said "empty"; the record fell
 *  through to `kind: "file"`, went to the engine as a text mention, and the
 *  engine dropped the binary without a word. The model's context held zero
 *  images. It inferred the subject from the target frame's NAME, drew the mark
 *  from memory, and reported success — the only failure in the series that
 *  produced a WRONG result rather than a slow one.
 *
 *  macOS ships `sips`, which converts the file in about 60ms. So a format the
 *  extension promises but the app cannot read is converted to PNG and the
 *  converted copy is attached instead. */

/** Bitmap formats worth attaching as pixels. The last five are here precisely
 *  because Electron may fail on them: WebP always, HEIC/AVIF depending on the
 *  build, TIFF sometimes. SVG is deliberately absent — it is a vector, and
 *  `sips` cannot rasterise it either, so pretending would only cost a failed
 *  subprocess on every attach. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "heic", "heif", "tif", "tiff", "avif"];

const IMAGE_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join("|")})$`, "i");

export function looksLikeImage(path: string): boolean {
  return IMAGE_RE.test(path);
}

/** Where the converted copy of `path` lives: a PNG in `dir`, named after the
 *  original plus a digest of its full path — so the same source always maps to
 *  the same file (a re-attach costs nothing) and two files sharing a basename
 *  never collide. The basename is reduced to safe characters: it becomes a
 *  real filename, and a `..` in it must not walk out of `dir`. */
export function convertedImagePath(path: string, dir: string): string {
  const base = (path.split("/").filter(Boolean).pop() ?? "image").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return join(dir, `${base}-${digest}.png`);
}

/** Ask sips for a PNG at an explicit destination, so nothing is written next
 *  to the user's original. */
export function sipsArgs(source: string, out: string): string[] {
  return ["-s", "format", "png", source, "--out", out];
}
