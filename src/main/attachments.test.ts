import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeImage, convertedImagePath, sipsArgs, IMAGE_EXTENSIONS } from "./attachments";

// Measured 2026-09-09: a user attached a WebP logo and asked for it to be
// redrawn. Electron's nativeImage cannot decode WebP, so the extension said
// "image" and the decode said "empty"; the file fell through to a text
// mention, the engine dropped the binary silently, and the model — with no
// image in context at all — inferred the subject from the target frame's NAME
// and drew it from memory. macOS can convert the file in 60ms.

test("the formats worth attaching as pixels include the ones Electron cannot decode itself", () => {
  for (const p of ["/a/b.png", "/a/b.JPG", "/a/b.jpeg", "/a/b.gif", "/a/b.bmp",
                   "/a/Claude_AI_symbol.svg.webp", "/a/shot.HEIC", "/a/scan.tiff", "/a/x.avif"]) {
    assert.equal(looksLikeImage(p), true, p);
  }
  for (const p of ["/a/notes.txt", "/a/logo.svg", "/a/photo.webp.txt", "/a/README", "/a/dir.png/inside.md"]) {
    assert.equal(looksLikeImage(p), false, `${p} must not be treated as a bitmap`);
  }
  assert.ok(IMAGE_EXTENSIONS.includes("webp") && IMAGE_EXTENSIONS.includes("heic"));
});

test("the converted copy is a PNG named after the original, and the same source always maps to the same file", () => {
  const a = convertedImagePath("/Users/n/Downloads/Claude_AI_symbol.svg.webp", "/tmp/conv");
  assert.match(a, /^\/tmp\/conv\/Claude_AI_symbol\.svg\.webp-[0-9a-f]{8}\.png$/);
  assert.equal(a, convertedImagePath("/Users/n/Downloads/Claude_AI_symbol.svg.webp", "/tmp/conv"), "stable, so a re-attach reuses it");
  // Two files with the same basename in different folders must not collide —
  // the whole path is what identifies the source.
  assert.notEqual(a, convertedImagePath("/Users/n/Desktop/Claude_AI_symbol.svg.webp", "/tmp/conv"));
  // A basename that would escape the directory or break a shell is neutered.
  assert.match(convertedImagePath("/a/../../etc/pa ss:wd.webp", "/tmp/conv"), /^\/tmp\/conv\/pa_ss_wd\.webp-[0-9a-f]{8}\.png$/);
});

test("the conversion is sips asked for a PNG, with the output path given explicitly", () => {
  assert.deepEqual(sipsArgs("/in/a.webp", "/out/a.png"), ["-s", "format", "png", "/in/a.webp", "--out", "/out/a.png"]);
});
