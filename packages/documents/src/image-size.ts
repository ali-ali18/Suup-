// The type and size of a PNG or JPEG, read from its own header bytes (fixed signatures; never from
// the name). Anything else is refused: the maker embeds only these two.

export interface ImageInfo {
  type: "png" | "jpg";
  width: number;
  height: number;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function imageInfo(bytes: Uint8Array): ImageInfo | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && PNG.every((b, i) => bytes[i] === b)) {
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { type: "png", width, height } : undefined;
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1] ?? 0;
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the size.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const height = view.getUint16(i + 5);
        const width = view.getUint16(i + 7);
        return width > 0 && height > 0 ? { type: "jpg", width, height } : undefined;
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}
