type ClipboardItemLike = {
  types: readonly string[];
  getType(type: string): Promise<unknown>;
};

const IMAGE_TYPES = ["image/png", "image/jpeg"] as const;

export async function clipboardImageBuffer(items: readonly ClipboardItemLike[]): Promise<Buffer | null> {
  for (const type of IMAGE_TYPES) {
    const item = items.find((candidate) => candidate.types.includes(type));
    if (!item) continue;

    const payload = await item.getType(type);
    if (payload instanceof Blob) return Buffer.from(await payload.arrayBuffer());
  }
  return null;
}
