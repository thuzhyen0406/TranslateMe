/**
 * docx – Phân tích và dựng lại tệp Microsoft Word (.docx) cho F10 (Nhiệm vụ 4.9 – TV4).
 * Thực hiện theo Mục 2.3.3 (Bảng 2.11), Mục 2.6.6 (Bảng 2.17) và Mục 2.9.1 (Mối đe dọa T10) của Báo cáo.
 *
 * Thuật toán (Mục 2.6.6):
 *  1. Mở an toàn: đọc gói ZIP thuần trong bộ nhớ, kiểm tra số mục (<= 2.000), tổng kích thước sau giải nén
 *     (<= 50 MB) và tỷ lệ nén (<= 100:1) cả theo header lẫn trong lúc giải nén để chống zip bomb;
 *     cấm <!DOCTYPE và <!ENTITY trong mọi phần XML để chống XXE (XML External Entity).
 *  2. Duyệt thân tài liệu: đọc word/document.xml, duyệt đệ quy các đoạn w:p và bảng w:tbl -> w:tr -> w:tc -> w:p
 *     (kể cả bảng lồng nhau). Không dịch nội dung trong hộp văn bản/hình vẽ (w:txbxContent, w:drawing, w:pict),
 *     trường/công thức (w:fldSimple, m:oMath); ghi nhận vào mảng warnings theo Bảng 2.17.
 *  3. Gộp run: trong mỗi w:p, các w:r liền kề có cùng w:rPr (và cùng w:hyperlink nếu có) được gộp thành một span.
 *     Ký tự tab (w:tab) và xuống dòng (w:br) được giữ như '\t' và '\n' trong văn bản của đoạn.
 *     Thay đổi có theo dõi (w:ins, w:del): dịch phần chèn như văn bản thường, bỏ qua phần đã xóa, báo TRACKED_CHANGES.
 *  4. Chọn định dạng nền & tạo ký hiệu {n}: định dạng nền của đoạn là định dạng của span có nhiều ký tự nhất.
 *     Span khác định dạng nền hoặc là liên kết (w:hyperlink) được bọc bằng {k}...{/k}.
 *  5. Dựng lại (rebuild): tách câu dịch theo {k}, tạo các w:r mới sao chép w:rPr của span k (hoặc định dạng nền),
 *     đặt xml:space="preserve", giữ nguyên đích w:hyperlink, và sao chép nguyên vẹn từng byte mọi phần khác của gói ZIP.
 *  6. Phông Đông Á: khi ngôn ngữ đích là ko, ja hoặc zh, đặt w:eastAsia cho w:rFonts và w:lang nếu run chưa có.
 *  7. Kiểm tra sau dựng: số w:p và số ô bảng w:tc của tệp mới phải bằng tệp gốc và tệp mới phải mở lại được
 *     bằng chính bộ phân tích; nếu sai thì ném CorruptFile('REBUILD_VERIFICATION_FAILED').
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  compareMarkers,
  escapeMarkerText,
  renumberMarkers,
  stripMarkers,
  tokenizeMarkers,
  validateMarkers,
} from './markers.js';
import type {
  FormatParser,
  ParseOptions,
  ParseWarning,
  ParsedDocument,
  RebuildOptions,
  RebuildStats,
  Sentence,
  Skeleton,
} from './parsers.js';
import { isTranslatable, segmentBlock } from './segmenter.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Tệp hỏng hoặc vi phạm giới hạn; reason dùng làm lý do FAILED của JOB */
export class CorruptFile extends Error {
  override name = 'CorruptFile';
  constructor(
    public reason: 'NOT_UTF8' | 'TOO_LARGE' | 'INVALID_SKELETON' | string,
    message: string,
  ) {
    super(message);
  }
}

// ============================================================================
// Ngưỡng an toàn chống ZIP bomb và XXE (Mục 2.6.6 & 2.9.1 T10)
// ============================================================================

/** Tổng kích thước tối đa sau giải nén của gói DOCX (50 MB) */
export const DOCX_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
/** Số mục (file/entry) tối đa trong gói ZIP DOCX (2.000 mục) */
export const DOCX_MAX_ZIP_ENTRIES = 2000;
/** Tỷ lệ nén tối đa cho phép (100:1) */
export const DOCX_MAX_COMPRESSION_RATIO = 100;

export interface DocxParseLimits {
  maxUncompressedBytes?: number;
  maxZipEntries?: number;
  maxCompressionRatio?: number;
}

// ============================================================================
// Cấu trúc Skeleton JSON của DOCX (lưu S3 giữa các bước của state machine BATCH)
// ============================================================================

export interface DocxSpanSpec {
  /** Chuỗi XML của <w:rPr>...</w:rPr> (rỗng '' nếu run không có định dạng riêng) */
  rPrXml: string;
  /** Chuỗi thuộc tính của <w:hyperlink ...> nếu span nằm trong liên kết */
  hyperlinkAttrs?: string;
  /** Chuỗi XML mở đặt ngay trước span (ví dụ <w:bookmarkStart .../> bao quanh cụm từ trong câu) */
  beforeXml?: string;
  /** Chuỗi XML đóng đặt ngay sau span (ví dụ <w:bookmarkEnd .../> bao quanh cụm từ trong câu) */
  afterXml?: string;
}

export interface DocxParagraphSegmentSentence {
  kind: 'sentence';
  sentenceId: number;
  /** Chuỗi nguồn có ký hiệu {1}...{/1} đã đánh số riêng cho câu */
  sourceMarkerText: string;
  /** Bảng ánh xạ id ký hiệu ("1", "2"...) -> định dạng của span */
  spans: Record<string, DocxSpanSpec>;
}

export interface DocxParagraphSegmentGap {
  kind: 'gap';
  /** Phần khoảng trắng hoặc văn bản không dịch (có thể chứa ký hiệu {k} nếu có định dạng riêng) */
  markerText: string;
  spans: Record<string, DocxSpanSpec>;
}

export interface DocxParagraphSegmentPreserved {
  kind: 'preserved';
  /** Phần tử XML phi văn bản (w:drawing, w:pict, m:oMath, w:bookmarkStart/End, w:footnoteReference...) giữ đúng vị trí trong đoạn */
  xml: string;
}

export type DocxParagraphSegment =
  | DocxParagraphSegmentSentence
  | DocxParagraphSegmentGap
  | DocxParagraphSegmentPreserved;

export interface DocxParagraphSlot {
  /** Vị trí bắt đầu và kết thúc của phần ruột bên trong <w:p ...>...</w:p> trong word/document.xml */
  innerStart: number;
  innerEnd: number;
  /** Chuỗi XML của <w:pPr>...</w:pPr> (nếu có) được giữ nguyên ở đầu đoạn */
  pPrXml: string;
  /** Các trường tương thích ngược (nếu skeleton cũ có lưu preservedBeforeXml / preservedAfterXml) */
  preservedBeforeXml?: string;
  preservedAfterXml?: string;
  /** Định dạng nền của đoạn (của span có nhiều ký tự nhất) */
  baseRPrXml: string;
  /** Danh sách theo đúng thứ tự xuất hiện gồm câu dịch, khoảng trắng (gap) và phần tử giữ nguyên (preserved) */
  segments: DocxParagraphSegment[];
}

export interface DocxZipEntrySkeleton {
  name: string;
  compressionMethod: number;
  /** Dữ liệu nén gốc dạng base64 (trống đối với word/document.xml vì sẽ được tạo mới từ documentXml) */
  compressedBase64: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dosTime: number;
  dosDate: number;
  externalAttrs: number;
}

export interface DocxSkeleton {
  v: 1;
  format: 'DOCX';
  /** Nội dung gốc của word/document.xml */
  documentXml: string;
  /** Các đoạn văn được trích xuất để thay thế khi dựng lại */
  paragraphs: DocxParagraphSlot[];
  /** Danh sách toàn bộ mục trong gói ZIP để sao chép nguyên vẹn từng byte các phần ngoài word/document.xml */
  entries: DocxZipEntrySkeleton[];
  /** Số lượng w:p và w:tc của tệp gốc để kiểm tra bất biến sau khi dựng */
  expectedParagraphCount: number;
  expectedTableCellCount: number;
}

// ============================================================================
// Đọc / Ghi gói ZIP thuần trong bộ nhớ & Kiểm tra chống ZIP bomb
// ============================================================================

const SIG_LFH = 0x04034b50;
const SIG_CDFH = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface RawZipEntry {
  name: string;
  compressionMethod: number;
  compressedData: Uint8Array;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dosTime: number;
  dosDate: number;
  externalAttrs: number;
}

function readUInt16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUInt32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] |
      (buf[offset + 1] << 8) |
      (buf[offset + 2] << 16) |
      (buf[offset + 3] << 24)) >>>
    0
  );
}

function writeUInt16LE(buf: Uint8Array, val: number, offset: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
}

function writeUInt32LE(buf: Uint8Array, val: number, offset: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function isSafeZipEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\')) return false;
  const segments = name.split(/[\\/]/);
  return !segments.some((s) => s === '..');
}

function readZipArchive(bytes: Uint8Array, limits: Required<DocxParseLimits> = {
  maxUncompressedBytes: DOCX_MAX_UNCOMPRESSED_BYTES,
  maxZipEntries: DOCX_MAX_ZIP_ENTRIES,
  maxCompressionRatio: DOCX_MAX_COMPRESSION_RATIO,
}): { entries: RawZipEntry[]; decompressEntry: (entry: RawZipEntry) => Uint8Array } {
  if (bytes.byteLength < 22 || readUInt32LE(bytes, 0) !== SIG_LFH) {
    throw new CorruptFile('INVALID_DOCX', 'Tệp không phải gói ZIP/DOCX hợp lệ');
  }

  // Tìm End of Central Directory (EOCD) từ cuối tệp
  const minEocdOffset = Math.max(0, bytes.byteLength - 65557);
  let eocdOffset = -1;
  for (let i = bytes.byteLength - 22; i >= minEocdOffset; i--) {
    if (readUInt32LE(bytes, i) === SIG_EOCD) {
      const commentLen = readUInt16LE(bytes, i + 20);
      if (i + 22 + commentLen <= bytes.byteLength) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new CorruptFile('INVALID_DOCX', 'Không tìm thấy Central Directory trong gói ZIP DOCX');
  }

  const totalEntries = readUInt16LE(bytes, eocdOffset + 10);
  if (totalEntries > limits.maxZipEntries) {
    throw new CorruptFile(
      'ZIP_TOO_MANY_ENTRIES',
      `Số mục trong gói DOCX (${totalEntries}) vượt ngưỡng cho phép (${limits.maxZipEntries})`,
    );
  }

  const cdSize = readUInt32LE(bytes, eocdOffset + 12);
  const cdOffset = readUInt32LE(bytes, eocdOffset + 16);
  if (cdOffset + cdSize > bytes.byteLength) {
    throw new CorruptFile('INVALID_DOCX', 'Central Directory của gói DOCX bị cắt cụt hoặc hỏng');
  }

  const entries: RawZipEntry[] = [];
  let totalDeclaredUncompressed = 0;
  let totalCompressed = 0;
  let pos = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (pos + 46 > bytes.byteLength || readUInt32LE(bytes, pos) !== SIG_CDFH) {
      throw new CorruptFile('INVALID_DOCX', 'Bản ghi Central Directory trong DOCX không hợp lệ');
    }
    const flags = readUInt16LE(bytes, pos + 8);
    if ((flags & 0x01) !== 0) {
      throw new CorruptFile('INVALID_DOCX', 'Tệp DOCX được mã hóa mật khẩu, không thể phân tích');
    }
    const compressionMethod = readUInt16LE(bytes, pos + 10);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new CorruptFile('INVALID_DOCX', `Phương thức nén ZIP không hỗ trợ: ${compressionMethod}`);
    }
    const dosTime = readUInt16LE(bytes, pos + 12);
    const dosDate = readUInt16LE(bytes, pos + 14);
    const crc32 = readUInt32LE(bytes, pos + 16);
    const compressedSize = readUInt32LE(bytes, pos + 20);
    const uncompressedSize = readUInt32LE(bytes, pos + 24);
    const nameLen = readUInt16LE(bytes, pos + 28);
    const extraLen = readUInt16LE(bytes, pos + 30);
    const commentLen = readUInt16LE(bytes, pos + 32);
    const externalAttrs = readUInt32LE(bytes, pos + 38);
    const lfhOffset = readUInt32LE(bytes, pos + 42);

    const nameEnd = pos + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > bytes.byteLength) {
      throw new CorruptFile('INVALID_DOCX', 'Tên mục trong Central Directory vượt quá kích thước tệp');
    }
    const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 46, nameEnd));
    if (!isSafeZipEntryName(name)) {
      throw new CorruptFile('INVALID_DOCX', `Tên mục trong ZIP không an toàn: ${name}`);
    }

    // Kiểm tra ngưỡng ZIP bomb theo thông tin khai báo trước khi giải nén
    totalDeclaredUncompressed += uncompressedSize;
    totalCompressed += Math.max(1, compressedSize);
    if (totalDeclaredUncompressed > limits.maxUncompressedBytes) {
      throw new CorruptFile(
        'ZIP_BOMB',
        `Tổng kích thước giải nén khai báo (${totalDeclaredUncompressed} byte) vượt ngưỡng ${limits.maxUncompressedBytes} byte`,
      );
    }
    if (
      uncompressedSize > 256 &&
      (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio)
    ) {
      throw new CorruptFile(
        'ZIP_BOMB',
        `Tỷ lệ nén của mục ${name} (${uncompressedSize}/${compressedSize}) vượt ngưỡng ${limits.maxCompressionRatio}:1`,
      );
    }

    if (lfhOffset + 30 > bytes.byteLength || readUInt32LE(bytes, lfhOffset) !== SIG_LFH) {
      throw new CorruptFile('INVALID_DOCX', `Local File Header của mục ${name} không hợp lệ`);
    }
    const lfhNameLen = readUInt16LE(bytes, lfhOffset + 26);
    const lfhExtraLen = readUInt16LE(bytes, lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) {
      throw new CorruptFile('INVALID_DOCX', `Dữ liệu nén của mục ${name} bị cắt cụt`);
    }

    entries.push({
      name,
      compressionMethod,
      compressedData: bytes.subarray(dataStart, dataEnd),
      crc32,
      compressedSize,
      uncompressedSize,
      dosTime,
      dosDate,
      externalAttrs,
    });

    pos = nameEnd + extraLen + commentLen;
  }

  if (
    totalDeclaredUncompressed > 1024 &&
    totalDeclaredUncompressed / Math.max(1, totalCompressed) > limits.maxCompressionRatio
  ) {
    throw new CorruptFile(
      'ZIP_BOMB',
      `Tổng tỷ lệ nén của gói DOCX vượt ngưỡng ${limits.maxCompressionRatio}:1`,
    );
  }

  let actualUncompressedTotal = 0;

  const decompressEntry = (entry: RawZipEntry): Uint8Array => {
    const remainingBudget = limits.maxUncompressedBytes - actualUncompressedTotal;
    if (remainingBudget < 0) {
      throw new CorruptFile('ZIP_BOMB', 'Tổng kích thước giải nén thực tế vượt ngưỡng cho phép');
    }

    let out: Uint8Array;
    if (entry.compressionMethod === 0) {
      out = entry.compressedData;
    } else {
      // Giới hạn kích thước đầu ra của inflate theo cả tổng ngân sách còn lại lẫn tỷ lệ nén tối đa
      const maxAllowedByRatio =
        entry.compressedData.byteLength * limits.maxCompressionRatio + 1024;
      const maxOutputLength = Math.min(remainingBudget, maxAllowedByRatio);
      try {
        out = inflateRawSync(entry.compressedData, {
          maxOutputLength: Math.max(0, maxOutputLength) + 1,
        });
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test(String(err))) {
          throw new CorruptFile(
            'ZIP_BOMB',
            `Giải nén mục ${entry.name} vượt ngưỡng kích thước hoặc tỷ lệ nén (${limits.maxCompressionRatio}:1)`,
          );
        }
        throw new CorruptFile('INVALID_DOCX', `Dữ liệu DEFLATE của mục ${entry.name} bị hỏng`);
      }
    }

    actualUncompressedTotal += out.byteLength;
    if (actualUncompressedTotal > limits.maxUncompressedBytes) {
      throw new CorruptFile(
        'ZIP_BOMB',
        `Tổng kích thước giải nén thực tế (${actualUncompressedTotal} byte) vượt ngưỡng ${limits.maxUncompressedBytes} byte`,
      );
    }
    if (
      out.byteLength > 256 &&
      (entry.compressedData.byteLength === 0 ||
        out.byteLength / entry.compressedData.byteLength > limits.maxCompressionRatio)
    ) {
      throw new CorruptFile(
        'ZIP_BOMB',
        `Tỷ lệ nén thực tế của mục ${entry.name} (${out.byteLength}/${entry.compressedData.byteLength}) vượt ngưỡng ${limits.maxCompressionRatio}:1`,
      );
    }
    return out;
  };

  return { entries, decompressEntry };
}

function writeZipArchive(entries: readonly DocxZipEntrySkeleton[], newDocXmlBytes: Uint8Array): Uint8Array {
  const prepared = entries.map((e) => {
    const nameBytes = new TextEncoder().encode(e.name);
    if (e.name === 'word/document.xml') {
      const crc = computeCrc32(newDocXmlBytes);
      const compressed =
        e.compressionMethod === 0 ? newDocXmlBytes : new Uint8Array(deflateRawSync(newDocXmlBytes));
      return {
        nameBytes,
        compressionMethod: e.compressionMethod === 0 ? 0 : 8,
        compressed,
        crc32: crc,
        compressedSize: compressed.byteLength,
        uncompressedSize: newDocXmlBytes.byteLength,
        dosTime: e.dosTime,
        dosDate: e.dosDate,
        externalAttrs: e.externalAttrs,
      };
    }
    const compressed = new Uint8Array(Buffer.from(e.compressedBase64, 'base64'));
    return {
      nameBytes,
      compressionMethod: e.compressionMethod,
      compressed,
      crc32: e.crc32,
      compressedSize: compressed.byteLength,
      uncompressedSize: e.uncompressedSize,
      dosTime: e.dosTime,
      dosDate: e.dosDate,
      externalAttrs: e.externalAttrs,
    };
  });

  let localSize = 0;
  let cdSize = 0;
  for (const item of prepared) {
    localSize += 30 + item.nameBytes.byteLength + item.compressed.byteLength;
    cdSize += 46 + item.nameBytes.byteLength;
  }

  const out = new Uint8Array(localSize + cdSize + 22);
  const offsets: number[] = [];
  let pos = 0;

  for (const item of prepared) {
    offsets.push(pos);
    writeUInt32LE(out, SIG_LFH, pos);
    writeUInt16LE(out, 20, pos + 4); // version needed: 2.0
    writeUInt16LE(out, 0x0800, pos + 6); // UTF-8 filename flag
    writeUInt16LE(out, item.compressionMethod, pos + 8);
    writeUInt16LE(out, item.dosTime, pos + 10);
    writeUInt16LE(out, item.dosDate, pos + 12);
    writeUInt32LE(out, item.crc32, pos + 14);
    writeUInt32LE(out, item.compressedSize, pos + 18);
    writeUInt32LE(out, item.uncompressedSize, pos + 22);
    writeUInt16LE(out, item.nameBytes.byteLength, pos + 26);
    writeUInt16LE(out, 0, pos + 28); // extra len
    out.set(item.nameBytes, pos + 30);
    out.set(item.compressed, pos + 30 + item.nameBytes.byteLength);
    pos += 30 + item.nameBytes.byteLength + item.compressed.byteLength;
  }

  const cdStart = pos;
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    writeUInt32LE(out, SIG_CDFH, pos);
    writeUInt16LE(out, 20, pos + 4); // version made by
    writeUInt16LE(out, 20, pos + 6); // version needed
    writeUInt16LE(out, 0x0800, pos + 8); // UTF-8 flag
    writeUInt16LE(out, item.compressionMethod, pos + 10);
    writeUInt16LE(out, item.dosTime, pos + 12);
    writeUInt16LE(out, item.dosDate, pos + 14);
    writeUInt32LE(out, item.crc32, pos + 16);
    writeUInt32LE(out, item.compressedSize, pos + 20);
    writeUInt32LE(out, item.uncompressedSize, pos + 24);
    writeUInt16LE(out, item.nameBytes.byteLength, pos + 28);
    writeUInt16LE(out, 0, pos + 30); // extra len
    writeUInt16LE(out, 0, pos + 32); // comment len
    writeUInt16LE(out, 0, pos + 34); // disk number
    writeUInt16LE(out, 0, pos + 36); // internal attrs
    writeUInt32LE(out, item.externalAttrs, pos + 38);
    writeUInt32LE(out, offsets[i], pos + 42);
    out.set(item.nameBytes, pos + 46);
    pos += 46 + item.nameBytes.byteLength;
  }

  writeUInt32LE(out, SIG_EOCD, pos);
  writeUInt16LE(out, 0, pos + 4);
  writeUInt16LE(out, 0, pos + 6);
  writeUInt16LE(out, prepared.length, pos + 8);
  writeUInt16LE(out, prepared.length, pos + 10);
  writeUInt32LE(out, cdSize, pos + 12);
  writeUInt32LE(out, cdStart, pos + 16);
  writeUInt16LE(out, 0, pos + 20);

  return out;
}

/**
 * Tiện ích đóng gói một tệp DOCX (ZIP) từ bảng đường dẫn -> nội dung XML/nhị phân.
 * Dùng cho kiểm thử đơn vị và tạo mẫu kịch bản 7.
 */
export function createDocxPackage(
  files: Readonly<Record<string, string | Uint8Array>>,
  options: { compressionMethod?: 0 | 8 } = {},
): Uint8Array {
  const method = options.compressionMethod ?? 8;
  const defaultFiles: Record<string, string | Uint8Array> = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
    ...files,
  };

  const entries: DocxZipEntrySkeleton[] = [];
  let docBytes: Uint8Array = new Uint8Array(0);

  for (const [name, content] of Object.entries(defaultFiles)) {
    const raw = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const crc = computeCrc32(raw);
    const compressed = method === 0 ? raw : new Uint8Array(deflateRawSync(raw));
    if (name === 'word/document.xml') {
      docBytes = raw;
    }
    entries.push({
      name,
      compressionMethod: method,
      compressedBase64: name === 'word/document.xml' ? '' : Buffer.from(compressed).toString('base64'),
      crc32: crc,
      compressedSize: compressed.byteLength,
      uncompressedSize: raw.byteLength,
      dosTime: 0,
      dosDate: 0x5421,
      externalAttrs: 0,
    });
  }
  return writeZipArchive(entries, docBytes);
}

// ============================================================================
// Kiểm tra chống XXE & Bộ phân tích cây XML bảo toàn vị trí byte/ký tự
// ============================================================================

const XXE_PATTERN = /<!DOCTYPE\b|<!ENTITY\b/i;

function decodeXmlUtf8(bytes: Uint8Array, partName: string): string {
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CorruptFile('NOT_UTF8', `Phần XML ${partName} trong DOCX không phải UTF-8 hợp lệ`);
  }
  if (XXE_PATTERN.test(xml)) {
    throw new CorruptFile(
      'XXE_DETECTED',
      `Phát hiện khai báo DOCTYPE/ENTITY (nguy cơ XXE) trong ${partName}`,
    );
  }
  return xml;
}

export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (all, ent: string) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
        return String.fromCodePoint(cp);
      }
    }
    return all;
  });
}

interface XmlTextNode {
  kind: 'text';
  value: string;
  start: number;
  end: number;
}

interface XmlElementNode {
  kind: 'element';
  name: string;
  attrs: string;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
  selfClosing: boolean;
  children: XmlNode[];
}

type XmlNode = XmlElementNode | XmlTextNode;

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseXmlTree(xml: string): XmlElementNode {
  const root: XmlElementNode = {
    kind: 'element',
    name: '#document',
    attrs: '',
    start: 0,
    end: xml.length,
    innerStart: 0,
    innerEnd: xml.length,
    selfClosing: false,
    children: [],
  };
  const stack: XmlElementNode[] = [root];
  let i = 0;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const textVal = xml.slice(i);
      if (textVal) {
        stack[stack.length - 1].children.push({
          kind: 'text',
          value: decodeXmlEntities(textVal),
          start: i,
          end: xml.length,
        });
      }
      break;
    }

    if (lt > i) {
      const rawText = xml.slice(i, lt);
      stack[stack.length - 1].children.push({
        kind: 'text',
        value: decodeXmlEntities(rawText),
        start: i,
        end: lt,
      });
    }

    // Comment <!-- ... -->
    if (xml.startsWith('<!--', lt)) {
      const endComment = xml.indexOf('-->', lt + 4);
      if (endComment < 0) throw new CorruptFile('INVALID_DOCX', 'Comment XML trong DOCX không đóng');
      i = endComment + 3;
      continue;
    }
    // Processing Instruction <?...?>
    if (xml.startsWith('<?', lt)) {
      const endPi = xml.indexOf('?>', lt + 2);
      if (endPi < 0) throw new CorruptFile('INVALID_DOCX', 'Chỉ thị XML trong DOCX không đóng');
      i = endPi + 2;
      continue;
    }
    // CDATA <![CDATA[...]]>
    if (xml.startsWith('<![CDATA[', lt)) {
      const endCdata = xml.indexOf(']]>', lt + 9);
      if (endCdata < 0) throw new CorruptFile('INVALID_DOCX', 'CDATA trong DOCX không đóng');
      stack[stack.length - 1].children.push({
        kind: 'text',
        value: xml.slice(lt + 9, endCdata),
        start: lt,
        end: endCdata + 3,
      });
      i = endCdata + 3;
      continue;
    }
    // Chặn mọi khai báo <! (DOCTYPE / ENTITY)
    if (xml.startsWith('<!', lt)) {
      throw new CorruptFile('XXE_DETECTED', 'Phát hiện khai báo <!DOCTYPE/<!ENTITY không an toàn trong XML');
    }

    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) {
      throw new CorruptFile('INVALID_DOCX', 'Thẻ XML trong DOCX bị thiếu dấu đóng >');
    }

    const tagContent = xml.slice(lt + 1, gt);
    if (tagContent.startsWith('/')) {
      const closeName = tagContent.slice(1).trim();
      const top = stack.pop();
      if (!top || top === root || top.name !== closeName) {
        throw new CorruptFile(
          'INVALID_DOCX',
          `Thẻ đóng </${closeName}> không khớp với thẻ mở <${top?.name ?? 'none'}>`,
        );
      }
      top.innerEnd = lt;
      top.end = gt + 1;
      i = gt + 1;
      continue;
    }

    const selfClosing = tagContent.endsWith('/');
    const cleanContent = selfClosing ? tagContent.slice(0, -1).trim() : tagContent.trim();
    const spaceIdx = cleanContent.search(/\s/);
    const name = spaceIdx < 0 ? cleanContent : cleanContent.slice(0, spaceIdx);
    const attrs = spaceIdx < 0 ? '' : cleanContent.slice(spaceIdx + 1).trim();

    if (!name) {
      throw new CorruptFile('INVALID_DOCX', 'Thẻ XML rỗng không hợp lệ trong DOCX');
    }

    const el: XmlElementNode = {
      kind: 'element',
      name,
      attrs,
      start: lt,
      end: gt + 1,
      innerStart: gt + 1,
      innerEnd: gt + 1,
      selfClosing,
      children: [],
    };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) {
      stack.push(el);
    }
    i = gt + 1;
  }

  if (stack.length !== 1) {
    throw new CorruptFile('INVALID_DOCX', `Thẻ XML <${stack[stack.length - 1].name}> chưa được đóng`);
  }
  return root;
}

// ============================================================================
// Đếm phần tử & Phân tích đoạn văn, gộp run, chọn định dạng nền
// ============================================================================

function countElementsByName(node: XmlElementNode, targetNames: ReadonlySet<string>, counts: Map<string, number>): void {
  if (targetNames.has(node.name)) {
    counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
  }
  for (const child of node.children) {
    if (child.kind === 'element') {
      countElementsByName(child, targetNames, counts);
    }
  }
}

export function countDocxStructure(xml: string): { paragraphCount: number; tableCellCount: number } {
  const tree = parseXmlTree(xml);
  const counts = new Map<string, number>();
  countElementsByName(tree, new Set(['w:p', 'w:tc']), counts);
  return {
    paragraphCount: counts.get('w:p') ?? 0,
    tableCellCount: counts.get('w:tc') ?? 0,
  };
}

/** Chuẩn hóa chuỗi <w:rPr> để so sánh hai run liền kề có cùng định dạng hay không */
function normalizeRPrXml(rawRPrXml: string): string {
  if (!rawRPrXml) return '';
  // Bỏ các phần tử lịch sử sửa định dạng <w:rPrChange ...>...</w:rPrChange> và khoảng trắng thừa giữa các thẻ
  const withoutChanges = rawRPrXml.replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>|<w:rPrChange\b[^>]*\/>/g, '');
  const compact = withoutChanges.replace(/>\s+</g, '><').trim();
  if (/^<w:rPr(?:\s[^>]*)?\/>$/.test(compact) || /^<w:rPr(?:\s[^>]*)?><\/w:rPr>$/.test(compact)) {
    return '';
  }
  return compact;
}

function sameSpanSpec(a: DocxSpanSpec, b: DocxSpanSpec): boolean {
  if (a.beforeXml || a.afterXml || b.beforeXml || b.afterXml) {
    return false;
  }
  return a.rPrXml === b.rPrXml && (a.hyperlinkAttrs ?? '') === (b.hyperlinkAttrs ?? '');
}

interface ExtractedRunSpan {
  text: string;
  spec: DocxSpanSpec;
}

type RawParagraphItem =
  | { kind: 'span'; text: string; spec: DocxSpanSpec }
  | { kind: 'bookmarkStart'; id: string; xml: string }
  | { kind: 'bookmarkEnd'; id: string; xml: string }
  | { kind: 'preserved'; xml: string };

interface WarningCollector {
  unsupportedElements: Map<string, number>;
  trackedChangesCount: number;
}

const UNSUPPORTED_INLINE_TAGS: ReadonlySet<string> = new Set([
  'w:drawing',
  'w:pict',
  'w:txbxContent',
  'w:fldSimple',
  'm:oMath',
  'm:oMathPara',
  'dgm:relIds',
]);

function scanUnsupportedDescendants(node: XmlElementNode, collector: WarningCollector): void {
  if (UNSUPPORTED_INLINE_TAGS.has(node.name)) {
    collector.unsupportedElements.set(node.name, (collector.unsupportedElements.get(node.name) ?? 0) + 1);
    // Nếu là w:drawing hoặc w:pict chứa w:txbxContent thì ghi nhận cả w:txbxContent nếu có
    if (node.name !== 'w:txbxContent') {
      const subCounts = new Map<string, number>();
      countElementsByName(node, new Set(['w:txbxContent']), subCounts);
      const txbx = subCounts.get('w:txbxContent') ?? 0;
      if (txbx > 0) {
        collector.unsupportedElements.set(
          'w:txbxContent',
          (collector.unsupportedElements.get('w:txbxContent') ?? 0) + txbx,
        );
      }
    }
    return;
  }
  if (node.name === 'w:fldChar' || node.name === 'w:instrText') {
    if (node.name === 'w:instrText') {
      collector.unsupportedElements.set('w:instrText', (collector.unsupportedElements.get('w:instrText') ?? 0) + 1);
    }
    return;
  }
  for (const child of node.children) {
    if (child.kind === 'element') {
      scanUnsupportedDescendants(child, collector);
    }
  }
}

function isTocSdt(sdtNode: XmlElementNode, xml: string): boolean {
  const raw = xml.slice(sdtNode.start, sdtNode.end);
  return /w:docPartGallery\s+w:val=["']Table of Contents["']/i.test(raw) || /TOC\s+\\o/i.test(raw);
}

function wrapInHyperlinkIfNeeded(fragmentXml: string, hyperlinkAttrs: string | undefined): string {
  if (hyperlinkAttrs === undefined) return fragmentXml;
  const attrs = hyperlinkAttrs ? ` ${hyperlinkAttrs}` : '';
  return `<w:hyperlink${attrs}>${fragmentXml}</w:hyperlink>`;
}

function extractAttrValue(attrs: string, attrName: string): string | null {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? '';
}

/**
 * Đọc các thành phần con của một <w:r> theo đúng thứ tự xuất hiện:
 *  - <w:t> -> văn bản
 *  - <w:tab/> -> '\t'
 *  - <w:br/> (không phải page/column break) hoặc <w:cr/> -> '\n'
 *  - Các phần tử giữ nguyên (w:drawing, w:pict, ngắt trang/cột, w:footnoteReference...) được tách thành
 *    mục 'preserved' ngay tại vị trí xuất hiện để không làm xô lệch cấu trúc trong run.
 */
function extractRunItems(
  rNode: XmlElementNode,
  xml: string,
  hyperlinkAttrs: string | undefined,
  collector: WarningCollector,
): RawParagraphItem[] {
  let rPrXml = '';
  for (const child of rNode.children) {
    if (child.kind === 'element' && child.name === 'w:rPr') {
      rPrXml = normalizeRPrXml(xml.slice(child.start, child.end));
    }
  }

  const items: RawParagraphItem[] = [];
  let textBuf = '';

  const flushText = (): void => {
    if (!textBuf) return;
    items.push({
      kind: 'span',
      text: textBuf,
      spec: { rPrXml, ...(hyperlinkAttrs !== undefined ? { hyperlinkAttrs } : {}) },
    });
    textBuf = '';
  };

  const pushPreservedRunChild = (childXml: string): void => {
    flushText();
    const runXml = `<w:r>${rPrXml}${childXml}</w:r>`;
    items.push({
      kind: 'preserved',
      xml: wrapInHyperlinkIfNeeded(runXml, hyperlinkAttrs),
    });
  };

  for (const child of rNode.children) {
    if (child.kind !== 'element') continue;
    if (child.name === 'w:rPr') {
      continue;
    }
    if (child.name === 'w:t') {
      for (const tChild of child.children) {
        if (tChild.kind === 'text') textBuf += tChild.value;
      }
      continue;
    }
    if (child.name === 'w:tab') {
      textBuf += '\t';
      continue;
    }
    if (child.name === 'w:br' || child.name === 'w:cr') {
      const isPageOrCol = /w:type\s*=\s*["'](?:page|column)["']/i.test(child.attrs);
      if (isPageOrCol) {
        pushPreservedRunChild(xml.slice(child.start, child.end));
      } else {
        textBuf += '\n';
      }
      continue;
    }
    if (child.name === 'w:noBreakHyphen') {
      textBuf += '\u2011';
      continue;
    }
    if (UNSUPPORTED_INLINE_TAGS.has(child.name) || child.name === 'w:fldChar' || child.name === 'w:instrText') {
      scanUnsupportedDescendants(child, collector);
      pushPreservedRunChild(xml.slice(child.start, child.end));
      continue;
    }
    if (child.name === 'w:footnoteReference' || child.name === 'w:endnoteReference' || child.name === 'w:commentReference') {
      pushPreservedRunChild(xml.slice(child.start, child.end));
    }
  }

  flushText();
  return items;
}

/**
 * Ghép các cặp <w:bookmarkStart w:id="X"/> ... <w:bookmarkEnd w:id="X"/> bao quanh một cụm văn bản nội tuyến
 * bên trong câu vào `DocxSpanSpec` (`beforeXml` / `afterXml`) để câu không bị cắt vụn mà bookmark vẫn bám đúng cụm từ.
 * Các bookmark điểm (rỗng), bookmark bao trọn đoạn hoặc nằm xen giữa các phần tử khác được giữ nguyên thành slot 'preserved'
 * tại đúng vị trí xuất hiện.
 */
function resolveParagraphBookmarks(rawItems: readonly RawParagraphItem[]): Array<
  | { kind: 'span'; text: string; spec: DocxSpanSpec }
  | { kind: 'preserved'; xml: string }
> {
  const items = rawItems.map((it) => (it.kind === 'span' ? { ...it, spec: { ...it.spec } } : { ...it }));

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < items.length - 2; i++) {
      const startItem = items[i];
      const midItem = items[i + 1];
      const endItem = items[i + 2];
      if (
        startItem.kind === 'bookmarkStart' &&
        midItem.kind === 'span' &&
        endItem.kind === 'bookmarkEnd' &&
        startItem.id !== '' &&
        startItem.id === endItem.id
      ) {
        const hasAdjacentSpanBefore = i > 0 && items[i - 1].kind === 'span';
        const hasAdjacentSpanAfter = i + 3 < items.length && items[i + 3].kind === 'span';
        const sentencePartsInMid = segmentBlock(escapeMarkerText(midItem.text)).filter((p) => p.kind === 'sentence');

        if ((hasAdjacentSpanBefore || hasAdjacentSpanAfter) && sentencePartsInMid.length <= 1) {
          midItem.spec = {
            ...midItem.spec,
            beforeXml: (midItem.spec.beforeXml ?? '') + startItem.xml,
            afterXml: endItem.xml + (midItem.spec.afterXml ?? ''),
          };
          items.splice(i + 2, 1);
          items.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
  }

  const resolved: Array<{ kind: 'span'; text: string; spec: DocxSpanSpec } | { kind: 'preserved'; xml: string }> = [];
  for (const it of items) {
    if (it.kind === 'span') {
      const prev = resolved[resolved.length - 1];
      if (prev && prev.kind === 'span' && sameSpanSpec(prev.spec, it.spec)) {
        prev.text += it.text;
      } else {
        resolved.push({ kind: 'span', text: it.text, spec: { ...it.spec } });
      }
    } else {
      const prev = resolved[resolved.length - 1];
      if (prev && prev.kind === 'preserved') {
        prev.xml += it.xml;
      } else {
        resolved.push({ kind: 'preserved', xml: it.xml });
      }
    }
  }
  return resolved;
}

function extractParagraphSlot(
  pNode: XmlElementNode,
  xml: string,
  blocks: Sentence[],
  collector: WarningCollector,
): DocxParagraphSlot | null {
  let pPrXml = '';
  const rawItems: RawParagraphItem[] = [];
  let hadDeletedContent = false;

  const pushRawItem = (item: RawParagraphItem): void => {
    if (item.kind === 'span') {
      if (!item.text) return;
      const prev = rawItems[rawItems.length - 1];
      if (prev && prev.kind === 'span' && sameSpanSpec(prev.spec, item.spec)) {
        prev.text += item.text;
      } else {
        rawItems.push({ kind: 'span', text: item.text, spec: { ...item.spec } });
      }
      return;
    }
    rawItems.push(item);
  };

  const walkParagraphChildren = (children: readonly XmlNode[], hyperlinkAttrs?: string): void => {
    for (const child of children) {
      if (child.kind !== 'element') continue;

      if (child.name === 'w:pPr' && hyperlinkAttrs === undefined) {
        pPrXml = xml.slice(child.start, child.end);
        continue;
      }
      if (child.name === 'w:proofErr') {
        continue;
      }
      if (child.name === 'w:r') {
        const runItems = extractRunItems(child, xml, hyperlinkAttrs, collector);
        for (const it of runItems) pushRawItem(it);
        continue;
      }
      if (child.name === 'w:hyperlink') {
        walkParagraphChildren(child.children, child.attrs);
        continue;
      }
      if (child.name === 'w:ins') {
        collector.trackedChangesCount++;
        walkParagraphChildren(child.children, hyperlinkAttrs);
        continue;
      }
      if (child.name === 'w:del') {
        collector.trackedChangesCount++;
        hadDeletedContent = true;
        // Mục 2.6.6 Bảng 2.17: bỏ qua nội dung đã xóa
        continue;
      }
      if (UNSUPPORTED_INLINE_TAGS.has(child.name)) {
        scanUnsupportedDescendants(child, collector);
        pushRawItem({
          kind: 'preserved',
          xml: wrapInHyperlinkIfNeeded(xml.slice(child.start, child.end), hyperlinkAttrs),
        });
        continue;
      }
      if (child.name === 'w:bookmarkStart' && hyperlinkAttrs === undefined) {
        const id = extractAttrValue(child.attrs, 'w:id') ?? '';
        pushRawItem({ kind: 'bookmarkStart', id, xml: xml.slice(child.start, child.end) });
        continue;
      }
      if (child.name === 'w:bookmarkEnd' && hyperlinkAttrs === undefined) {
        const id = extractAttrValue(child.attrs, 'w:id') ?? '';
        pushRawItem({ kind: 'bookmarkEnd', id, xml: xml.slice(child.start, child.end) });
        continue;
      }
      pushRawItem({
        kind: 'preserved',
        xml: wrapInHyperlinkIfNeeded(xml.slice(child.start, child.end), hyperlinkAttrs),
      });
    }
  };

  walkParagraphChildren(pNode.children);

  const orderedItems = resolveParagraphBookmarks(rawItems);
  const allSpans = orderedItems.filter((it): it is { kind: 'span'; text: string; spec: DocxSpanSpec } => it.kind === 'span');

  if (allSpans.length === 0) {
    if (!hadDeletedContent) return null;
    const segments: DocxParagraphSegment[] = orderedItems.map((it) => ({
      kind: 'preserved',
      xml: (it as { kind: 'preserved'; xml: string }).xml,
    }));
    return {
      innerStart: pNode.innerStart,
      innerEnd: pNode.innerEnd,
      pPrXml,
      baseRPrXml: '',
      segments,
    };
  }

  // Mục 2.6.6: "Định dạng nền của đoạn là định dạng của span có nhiều ký tự nhất."
  let baseRPrXml = '';
  let maxSpanChars = -1;
  const charTotalsByRPr = new Map<string, number>();
  for (const sp of allSpans) {
    if (sp.spec.hyperlinkAttrs !== undefined || sp.spec.beforeXml || sp.spec.afterXml) continue;
    const len = Array.from(sp.text).length;
    const total = (charTotalsByRPr.get(sp.spec.rPrXml) ?? 0) + len;
    charTotalsByRPr.set(sp.spec.rPrXml, total);
    if (len > maxSpanChars) {
      maxSpanChars = len;
      baseRPrXml = sp.spec.rPrXml;
    }
  }
  let bestTotal = -1;
  for (const [rPr, total] of charTotalsByRPr) {
    if (total > bestTotal) {
      bestTotal = total;
      baseRPrXml = rPr;
    }
  }

  // Lưu theo thứ tự các câu, gap và slot 'preserved' trong đoạn
  const segments: DocxParagraphSegment[] = [];
  let hasTranslatableSentence = false;
  let currentSpanGroup: ExtractedRunSpan[] = [];

  const flushSpanGroup = (): void => {
    if (currentSpanGroup.length === 0) return;
    const paraSpans: Record<string, DocxSpanSpec> = {};
    let nextMarkerId = 1;
    let groupMarkerText = '';

    for (const sp of currentSpanGroup) {
      const escaped = escapeMarkerText(sp.text);
      const isBase =
        sp.spec.hyperlinkAttrs === undefined &&
        !sp.spec.beforeXml &&
        !sp.spec.afterXml &&
        sp.spec.rPrXml === baseRPrXml;
      if (isBase) {
        groupMarkerText += escaped;
      } else {
        const id = String(nextMarkerId++);
        paraSpans[id] = sp.spec;
        groupMarkerText += `{${id}}${escaped}{/${id}}`;
      }
    }

    const segParts = segmentBlock(groupMarkerText);
    for (const part of segParts) {
      if (part.kind === 'sentence' && isTranslatable(part.text)) {
        hasTranslatableSentence = true;
        const renumbered = renumberMarkers(part.text);
        const sentenceSpans: Record<string, DocxSpanSpec> = {};
        for (const [newId, oldId] of Object.entries(renumbered.idMap)) {
          if (paraSpans[oldId]) {
            sentenceSpans[newId] = paraSpans[oldId];
          }
        }
        const sentenceId = blocks.length;
        blocks.push({ id: sentenceId, text: renumbered.text });
        segments.push({
          kind: 'sentence',
          sentenceId,
          sourceMarkerText: renumbered.text,
          spans: sentenceSpans,
        });
      } else {
        const gapSpans: Record<string, DocxSpanSpec> = {};
        for (const id of validateMarkers(part.text).ids) {
          if (paraSpans[id]) gapSpans[id] = paraSpans[id];
        }
        segments.push({
          kind: 'gap',
          markerText: part.text,
          spans: gapSpans,
        });
      }
    }
    currentSpanGroup = [];
  };

  for (const item of orderedItems) {
    if (item.kind === 'span') {
      currentSpanGroup.push({ text: item.text, spec: item.spec });
    } else {
      flushSpanGroup();
      segments.push({ kind: 'preserved', xml: item.xml });
    }
  }
  flushSpanGroup();

  if (!hasTranslatableSentence && !hadDeletedContent) {
    return null;
  }

  return {
    innerStart: pNode.innerStart,
    innerEnd: pNode.innerEnd,
    pPrXml,
    baseRPrXml,
    segments,
  };
}

function traverseDocumentBody(
  node: XmlElementNode,
  xml: string,
  paragraphs: DocxParagraphSlot[],
  blocks: Sentence[],
  collector: WarningCollector,
): void {
  for (const child of node.children) {
    if (child.kind !== 'element') continue;

    if (child.name === 'w:p') {
      const slot = extractParagraphSlot(child, xml, blocks, collector);
      if (slot) paragraphs.push(slot);
      continue;
    }

    if (child.name === 'w:sdt') {
      if (isTocSdt(child, xml)) {
        collector.unsupportedElements.set('w:sdt(TOC)', (collector.unsupportedElements.get('w:sdt(TOC)') ?? 0) + 1);
        continue;
      }
    }

    if (UNSUPPORTED_INLINE_TAGS.has(child.name)) {
      scanUnsupportedDescendants(child, collector);
      continue;
    }

    if (child.name === 'w:ins' || child.name === 'w:del') {
      collector.trackedChangesCount++;
      if (child.name === 'w:del') continue;
    }

    // Duyệt đệ quy vào w:tbl -> w:tr -> w:tc (kể cả bảng lồng nhau), w:sdtContent, w:customXml...
    traverseDocumentBody(child, xml, paragraphs, blocks, collector);
  }
}

// ============================================================================
// Phông Đông Á (ko, ja, zh) & Dựng lại XML của đoạn văn
// ============================================================================

interface EastAsianFontConfig {
  font: string;
  locale: string;
}

function getEastAsianFontConfig(targetLang: string | undefined): EastAsianFontConfig | null {
  if (!targetLang) return null;
  const normalized = targetLang.trim().toLowerCase();
  if (normalized === 'ko' || normalized.startsWith('ko-')) {
    return { font: 'Malgun Gothic', locale: 'ko-KR' };
  }
  if (normalized === 'ja' || normalized.startsWith('ja-')) {
    return { font: 'MS Mincho', locale: 'ja-JP' };
  }
  if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-hant') {
    return { font: 'PMingLiU', locale: 'zh-TW' };
  }
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return { font: 'SimSun', locale: 'zh-CN' };
  }
  return null;
}

/**
 * Mục 2.6.6: "Khi ngôn ngữ đích là ko, ja hoặc zh, run mới được đặt thuộc tính w:eastAsia của w:rFonts
 * và w:lang theo ngôn ngữ đích nếu run chưa có phông phù hợp, để chữ Hàn, Nhật, Trung hiển thị đúng."
 */
export function applyEastAsianFont(rPrXml: string, targetLang: string | undefined): string {
  const cfg = getEastAsianFontConfig(targetLang);
  if (!cfg) return rPrXml;

  if (!rPrXml) {
    return `<w:rPr><w:rFonts w:eastAsia="${cfg.font}"/><w:lang w:eastAsia="${cfg.locale}"/></w:rPr>`;
  }

  let updated = rPrXml;

  // 1. w:rFonts
  if (/<w:rFonts\b/.test(updated)) {
    updated = updated.replace(/<w:rFonts\b([^>]*?)(\/?>)/, (all, attrs: string, close: string) => {
      if (/\bw:eastAsia\s*=/.test(attrs)) return all;
      return `<w:rFonts${attrs} w:eastAsia="${cfg.font}"${close}`;
    });
  } else {
    updated = updated.replace(/^<w:rPr(\s[^>]*)?>/, (openTag) => `${openTag}<w:rFonts w:eastAsia="${cfg.font}"/>`);
  }

  // 2. w:lang
  if (/<w:lang\b/.test(updated)) {
    updated = updated.replace(/<w:lang\b([^>]*?)(\/?>)/, (all, attrs: string, close: string) => {
      if (/\bw:eastAsia\s*=/.test(attrs)) return all;
      return `<w:lang${attrs} w:eastAsia="${cfg.locale}"${close}`;
    });
  } else {
    updated = updated.replace(/<\/w:rPr>$/, `<w:lang w:eastAsia="${cfg.locale}"/></w:rPr>`);
  }

  return updated;
}

function buildRunChildrenXml(text: string): string {
  // Tách theo ký tự tab (\t) và xuống dòng (\n) để chuyển về <w:tab/> và <w:br/>
  const parts = text.split(/(\t|\n)/);
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (part === '\t') {
      out += '<w:tab/>';
    } else if (part === '\n') {
      out += '<w:br/>';
    } else {
      out += `<w:t xml:space="preserve">${escapeXmlText(part)}</w:t>`;
    }
  }
  return out;
}

function markerTextToSpans(
  markerText: string,
  spans: Readonly<Record<string, DocxSpanSpec>>,
  baseRPrXml: string,
): ExtractedRunSpan[] {
  const tokens = tokenizeMarkers(markerText);
  const activeStack: DocxSpanSpec[] = [];
  const out: ExtractedRunSpan[] = [];
  let pendingBeforeXml = '';

  const currentSpec = (): DocxSpanSpec => {
    if (activeStack.length === 0) return { rPrXml: baseRPrXml };
    const top = activeStack[activeStack.length - 1];
    // Nếu lồng bên trong một liên kết ở cấp ngoài thì vẫn giữ hyperlinkAttrs
    let hyperlinkAttrs = top.hyperlinkAttrs;
    if (hyperlinkAttrs === undefined) {
      for (let i = activeStack.length - 2; i >= 0; i--) {
        if (activeStack[i].hyperlinkAttrs !== undefined) {
          hyperlinkAttrs = activeStack[i].hyperlinkAttrs;
          break;
        }
      }
    }
    return {
      rPrXml: top.rPrXml || baseRPrXml,
      ...(hyperlinkAttrs !== undefined ? { hyperlinkAttrs } : {}),
    };
  };

  for (const tok of tokens) {
    if (tok.type === 'open') {
      const opened = spans[tok.id] ?? { rPrXml: baseRPrXml };
      activeStack.push(opened);
      if (opened.beforeXml) {
        pendingBeforeXml += opened.beforeXml;
      }
    } else if (tok.type === 'close') {
      const closed = activeStack.pop();
      if (closed?.afterXml && out.length > 0) {
        const last = out[out.length - 1];
        last.spec = {
          ...last.spec,
          afterXml: (last.spec.afterXml ?? '') + closed.afterXml,
        };
      }
    } else if (tok.type === 'text' && tok.value) {
      const spec: DocxSpanSpec = {
        ...currentSpec(),
        ...(pendingBeforeXml ? { beforeXml: pendingBeforeXml } : {}),
      };
      pendingBeforeXml = '';
      const prev = out[out.length - 1];
      if (prev && sameSpanSpec(prev.spec, spec)) {
        prev.text += tok.value;
      } else {
        out.push({ text: tok.value, spec });
      }
    }
  }
  return out;
}

function rebuildParagraphInnerXml(
  slot: DocxParagraphSlot,
  translations: readonly (string | null | undefined)[],
  targetLang: string | undefined,
  stats: RebuildStats,
): string {
  const pendingSpans: ExtractedRunSpan[] = [];
  let outXml = `${slot.pPrXml}${slot.preservedBeforeXml ?? ''}`;

  const appendSpans = (items: readonly ExtractedRunSpan[]): void => {
    for (const item of items) {
      if (!item.text) continue;
      const prev = pendingSpans[pendingSpans.length - 1];
      if (prev && sameSpanSpec(prev.spec, item.spec)) {
        prev.text += item.text;
      } else {
        pendingSpans.push({ text: item.text, spec: { ...item.spec } });
      }
    }
  };

  const flushPendingSpans = (): void => {
    for (const sp of pendingSpans) {
      const rPr = applyEastAsianFont(sp.spec.rPrXml, targetLang);
      const childrenXml = buildRunChildrenXml(sp.text);
      const runXml = `<w:r>${rPr}${childrenXml}</w:r>`;
      const wrappedRun =
        sp.spec.hyperlinkAttrs !== undefined
          ? `<w:hyperlink${sp.spec.hyperlinkAttrs ? ` ${sp.spec.hyperlinkAttrs}` : ''}>${runXml}</w:hyperlink>`
          : runXml;
      outXml += `${sp.spec.beforeXml ?? ''}${wrappedRun}${sp.spec.afterXml ?? ''}`;
    }
    pendingSpans.length = 0;
  };

  for (const seg of slot.segments) {
    if (seg.kind === 'preserved') {
      flushPendingSpans();
      outXml += seg.xml;
      continue;
    }

    if (seg.kind === 'gap') {
      appendSpans(markerTextToSpans(seg.markerText, seg.spans, slot.baseRPrXml));
      continue;
    }

    stats.sentences++;
    const tr = translations[seg.sentenceId];
    const hasTranslation = typeof tr === 'string' && tr.trim() !== '';
    if (!hasTranslation) {
      stats.keptSource++;
      appendSpans(markerTextToSpans(seg.sourceMarkerText, seg.spans, slot.baseRPrXml));
      continue;
    }

    stats.translated++;
    const cmp = compareMarkers(seg.sourceMarkerText, tr);
    if (!cmp.restorable) {
      stats.tagFallback++;
      // Bảo toàn các bookmark nội tuyến (beforeXml / afterXml) nếu có trong seg.spans khi fallback
      let fallbackBefore = '';
      let fallbackAfter = '';
      for (const spSpec of Object.values(seg.spans)) {
        if (spSpec.beforeXml) fallbackBefore += spSpec.beforeXml;
        if (spSpec.afterXml) fallbackAfter += spSpec.afterXml;
      }
      appendSpans([
        {
          text: stripMarkers(tr),
          spec: {
            rPrXml: slot.baseRPrXml,
            ...(fallbackBefore ? { beforeXml: fallbackBefore } : {}),
            ...(fallbackAfter ? { afterXml: fallbackAfter } : {}),
          },
        },
      ]);
    } else {
      appendSpans(markerTextToSpans(tr, seg.spans, slot.baseRPrXml));
    }
  }

  flushPendingSpans();
  outXml += slot.preservedAfterXml ?? '';
  return outXml;
}

// ============================================================================
// Cài đặt FormatParser cho DOCX (Bảng 2.11)
// ============================================================================

const UNSUPPORTED_PART_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^word\/header\d*\.xml$/i, label: 'Đầu trang (header)' },
  { re: /^word\/footer\d*\.xml$/i, label: 'Chân trang (footer)' },
  { re: /^word\/footnotes\.xml$/i, label: 'Chú thích cuối trang (footnotes)' },
  { re: /^word\/endnotes\.xml$/i, label: 'Chú thích cuối tài liệu (endnotes)' },
  { re: /^word\/comments\.xml$/i, label: 'Nhận xét (comments)' },
];

const UNSUPPORTED_ELEMENT_LABELS: Readonly<Record<string, string>> = {
  'w:drawing': 'Hình vẽ / ảnh / hộp văn bản (w:drawing)',
  'w:pict': 'Hình vẽ VML (w:pict)',
  'w:txbxContent': 'Hộp văn bản (w:txbxContent)',
  'w:fldSimple': 'Trường đơn (w:fldSimple)',
  'w:instrText': 'Trường / mục lục tự động (w:instrText)',
  'w:sdt(TOC)': 'Mục lục tự động (Table of Contents)',
  'm:oMath': 'Công thức toán học (m:oMath)',
  'm:oMathPara': 'Khối công thức toán học (m:oMathPara)',
  'dgm:relIds': 'Sơ đồ SmartArt (dgm:relIds)',
};

export const docxParser: FormatParser = {
  parse(bytes: Uint8Array, opts: Required<ParseOptions>): ParsedDocument<DocxSkeleton> {
    if (bytes.byteLength > opts.maxBytes) {
      throw new CorruptFile('TOO_LARGE', `Tệp vượt ${opts.maxBytes} byte`);
    }

    const { entries, decompressEntry } = readZipArchive(bytes);
    const warnings: ParseWarning[] = [];

    // Kiểm tra XXE trên mọi phần XML/.rels trong gói và phát hiện UNSUPPORTED_PART (Bảng 2.17)
    let docEntry: RawZipEntry | undefined;
    for (const entry of entries) {
      if (entry.name === 'word/document.xml') {
        docEntry = entry;
      }
      if (/\.(?:xml|rels)$/i.test(entry.name)) {
        const rawXmlBytes = decompressEntry(entry);
        const xmlText = decodeXmlUtf8(rawXmlBytes, entry.name);

        for (const pat of UNSUPPORTED_PART_PATTERNS) {
          if (pat.re.test(entry.name)) {
            // Với footnotes/endnotes, kiểm tra có văn bản thực sự ngoài separator mặc định của Word không
            const hasUserContent =
              !/footnotes|endnotes/i.test(entry.name) ||
              /<w:t\b[^>]*>[^<]+<\/w:t>/.test(xmlText);
            if (hasUserContent) {
              warnings.push({
                code: 'UNSUPPORTED_PART',
                where: entry.name,
                count: 1,
                message: `${pat.label} tại ${entry.name} được giữ nguyên, không dịch`,
              });
            }
          }
        }
      }
    }

    if (!docEntry) {
      throw new CorruptFile('INVALID_DOCX', 'Gói DOCX thiếu tệp bắt buộc word/document.xml');
    }

    const documentXml = decodeXmlUtf8(decompressEntry(docEntry), 'word/document.xml');
    const tree = parseXmlTree(documentXml);

    const docRoot = tree.children.find(
      (c): c is XmlElementNode => c.kind === 'element' && c.name === 'w:document',
    );
    const bodyNode = docRoot?.children.find(
      (c): c is XmlElementNode => c.kind === 'element' && c.name === 'w:body',
    );
    if (!bodyNode) {
      throw new CorruptFile('INVALID_DOCX', 'word/document.xml thiếu phần tử w:document hoặc w:body');
    }

    const counts = new Map<string, number>();
    countElementsByName(tree, new Set(['w:p', 'w:tc']), counts);
    const expectedParagraphCount = counts.get('w:p') ?? 0;
    const expectedTableCellCount = counts.get('w:tc') ?? 0;

    const blocks: Sentence[] = [];
    const paragraphs: DocxParagraphSlot[] = [];
    const collector: WarningCollector = {
      unsupportedElements: new Map(),
      trackedChangesCount: 0,
    };

    traverseDocumentBody(bodyNode, documentXml, paragraphs, blocks, collector);

    for (const [elName, count] of collector.unsupportedElements) {
      const label = UNSUPPORTED_ELEMENT_LABELS[elName] ?? elName;
      warnings.push({
        code: 'UNSUPPORTED_ELEMENT',
        where: elName,
        count,
        message: `${label} (${count} vị trí) được giữ nguyên, không dịch`,
      });
    }

    if (collector.trackedChangesCount > 0) {
      warnings.push({
        code: 'TRACKED_CHANGES',
        where: 'word/document.xml',
        count: collector.trackedChangesCount,
        message: `Thay đổi có theo dõi (${collector.trackedChangesCount} vị trí w:ins/w:del): dịch phần chèn như văn bản thường và bỏ qua phần đã xóa`,
      });
    }

    const entrySkeletons: DocxZipEntrySkeleton[] = entries.map((e) => ({
      name: e.name,
      compressionMethod: e.compressionMethod,
      compressedBase64:
        e.name === 'word/document.xml' ? '' : Buffer.from(e.compressedData).toString('base64'),
      crc32: e.crc32,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      dosTime: e.dosTime,
      dosDate: e.dosDate,
      externalAttrs: e.externalAttrs,
    }));

    const skeleton: DocxSkeleton = {
      v: 1,
      format: 'DOCX',
      documentXml,
      paragraphs,
      entries: entrySkeletons,
      expectedParagraphCount,
      expectedTableCellCount,
    };

    return { blocks, skeleton, warnings };
  },

  rebuild(
    skeleton: Skeleton,
    translations: readonly (string | null | undefined)[],
    opts: RebuildOptions,
  ): { bytes: Uint8Array; stats: RebuildStats } {
    const sk = skeleton as DocxSkeleton;
    if (
      !sk ||
      sk.format !== 'DOCX' ||
      sk.v !== 1 ||
      typeof sk.documentXml !== 'string' ||
      !Array.isArray(sk.paragraphs) ||
      !Array.isArray(sk.entries) ||
      typeof sk.expectedParagraphCount !== 'number' ||
      typeof sk.expectedTableCellCount !== 'number' ||
      !sk.entries.some((e) => e && e.name === 'word/document.xml')
    ) {
      throw new CorruptFile('INVALID_SKELETON', 'Skeleton DOCX không hợp lệ');
    }

    const stats: RebuildStats = { sentences: 0, translated: 0, keptSource: 0, tagFallback: 0 };

    // Thay thế nội dung từng đoạn văn từ đầu tới cuối theo offset đã lưu
    let rebuiltXml = '';
    let cursor = 0;
    for (const slot of sk.paragraphs) {
      if (
        typeof slot.innerStart !== 'number' ||
        typeof slot.innerEnd !== 'number' ||
        slot.innerStart < cursor ||
        slot.innerEnd < slot.innerStart ||
        slot.innerEnd > sk.documentXml.length ||
        !Array.isArray(slot.segments)
      ) {
        throw new CorruptFile('INVALID_SKELETON', 'Vị trí đoạn văn trong Skeleton DOCX không hợp lệ');
      }
      rebuiltXml += sk.documentXml.slice(cursor, slot.innerStart);
      rebuiltXml += rebuildParagraphInnerXml(slot, translations, opts.targetLang, stats);
      cursor = slot.innerEnd;
    }
    rebuiltXml += sk.documentXml.slice(cursor);

    // Kiểm tra sau dựng (Mục 2.6.6): số w:p và w:tc phải bằng tệp gốc
    const { paragraphCount, tableCellCount } = countDocxStructure(rebuiltXml);
    if (
      paragraphCount !== sk.expectedParagraphCount ||
      tableCellCount !== sk.expectedTableCellCount
    ) {
      throw new CorruptFile(
        'REBUILD_VERIFICATION_FAILED',
        `Số đoạn văn hoặc ô bảng sau khi dựng (${paragraphCount} w:p, ${tableCellCount} w:tc) lệch với tệp gốc (${sk.expectedParagraphCount} w:p, ${sk.expectedTableCellCount} w:tc)`,
      );
    }

    const newDocXmlBytes = new TextEncoder().encode(rebuiltXml);
    const outBytes = writeZipArchive(sk.entries, newDocXmlBytes);

    // Kiểm tra tệp mới mở lại được bằng chính bộ phân tích
    try {
      docxParser.parse(outBytes, { maxBytes: Math.max(MAX_FILE_BYTES, outBytes.byteLength) });
    } catch (err) {
      throw new CorruptFile(
        'REBUILD_VERIFICATION_FAILED',
        `Tệp DOCX sau khi dựng không mở lại được: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { bytes: outBytes, stats };
  },
};
