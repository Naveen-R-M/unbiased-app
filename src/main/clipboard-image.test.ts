import assert from "node:assert/strict";
import test from "node:test";
import { clipboardImageBuffer } from "./clipboard-image";

function item(type: string, bytes: number[]) {
  return {
    types: [type],
    async getType(requested: string) {
      assert.equal(requested, type);
      return new Blob([Uint8Array.from(bytes)], { type });
    },
  };
}

test("clipboard images prefer PNG and return its bytes", async () => {
  const result = await clipboardImageBuffer([
    item("image/jpeg", [4, 5, 6]),
    item("image/png", [1, 2, 3]),
  ]);

  assert.deepEqual(result, Buffer.from([1, 2, 3]));
});

test("clipboard images accept JPEG when PNG is absent", async () => {
  assert.deepEqual(await clipboardImageBuffer([item("image/jpeg", [7, 8])]), Buffer.from([7, 8]));
});

test("clipboard images ignore non-image and non-Blob payloads", async () => {
  assert.equal(await clipboardImageBuffer([
    { types: ["text/plain"], async getType() { return new Blob(["text"]); } },
    { types: ["image/png"], async getType() { return { title: "bookmark" }; } },
  ]), null);
});
