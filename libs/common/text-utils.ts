import { createHash } from "node:crypto";

/**
 * Chuẩn hóa chuỗi (NFC, trim, gộp khoảng trắng)
 * và trả về mã băm SHA-256.
 *
 * @param text Câu thuần văn bản
 * @returns Văn bản chuẩn hóa và hash Hex 64 ký tự
 */
export function normalize_hash(
  text: string
): { normalizedText: string; hash: string } {
  const normalizedText = text
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();

  const hash = createHash("sha256")
    .update(normalizedText, "utf8")
    .digest("hex");

  return { normalizedText, hash };
}

/**
 * Đếm số byte UTF-8 của chuỗi.
 */
function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Tách một câu quá dài thành các phần không vượt quá maxBytes.
 * Ưu tiên cắt tại khoảng trắng; nếu không có thì cắt theo
 * ranh giới code point Unicode để không tách đôi ký tự UTF-8.
 */
function splitLongSentence(
  sentence: string,
  maxBytes: number
): string[] {
  const parts: string[] = [];
  let remaining = sentence;

  while (remaining.length > 0) {
    if (utf8ByteLength(remaining) <= maxBytes) {
      parts.push(remaining);
      break;
    }

    let currentBytes = 0;
    let endIndex = 0;

    // Array.from() tách theo Unicode code point,
    // thay vì tách theo UTF-16 code unit.
    const codePoints = Array.from(remaining);

    for (const codePoint of codePoints) {
      const charBytes = utf8ByteLength(codePoint);

      if (currentBytes + charBytes > maxBytes) {
        break;
      }

      currentBytes += charBytes;
      endIndex += codePoint.length;
    }

    if (endIndex === 0) {
      throw new RangeError(
        "maxBytes quá nhỏ để chứa một Unicode code point."
      );
    }

    let piece = remaining.slice(0, endIndex);
    let next = remaining.slice(endIndex);

    // Ưu tiên cắt ở khoảng trắng gần cuối phần có thể chứa.
    const lastWhitespace = piece.search(/\s+$/u);
    if (lastWhitespace > 0) {
      next = piece.slice(lastWhitespace) + next;
      piece = piece.slice(0, lastWhitespace);
    }

    piece = piece.trimEnd();
    next = next.trimStart();

    if (piece.length > 0) {
      parts.push(piece);
    }

    remaining = next;
  }

  return parts;
}

/**
 * Gom các câu thành các chunk không vượt quá giới hạn byte UTF-8.
 *
 * Mỗi chunk là một mảng câu/đoạn văn bản. Khi nối các phần tử
 * trong chunk bằng một dấu cách, tổng byte vẫn <= maxBytes.
 *
 * Câu đơn dài hơn giới hạn sẽ được tách thành các đoạn nhỏ.
 *
 * @param sentences Mảng các câu cần gom
 * @param maxBytes Giới hạn byte tối đa, mặc định 10000
 */
export function chunk_by_bytes(
  sentences: string[],
  maxBytes: number = 10_000
): string[][] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes phải là số nguyên >= 1.");
  }

  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentBytes = 0;

  for (const rawSentence of sentences) {
    const normalized = rawSentence
      .normalize("NFC")
      .replace(/\s+/gu, " ")
      .trim();

    if (!normalized) {
      continue;
    }

    const sentenceParts =
      utf8ByteLength(normalized) <= maxBytes
        ? [normalized]
        : splitLongSentence(normalized, maxBytes);

    for (const part of sentenceParts) {
      const partBytes = utf8ByteLength(part);
      const separatorBytes = currentChunk.length > 0 ? 1 : 0;

      if (
        currentChunk.length > 0 &&
        currentBytes + separatorBytes + partBytes > maxBytes
      ) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentBytes = 0;
      }

      const separator = currentChunk.length > 0 ? 1 : 0;
      currentChunk.push(part);
      currentBytes += separator + partBytes;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}