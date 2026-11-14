/**
 * Bản giả tạm thời theo B.14 (Phần B) – thay bằng bản thật khi các hạng mục liên quan xong.
 *
 *  - hashSentenceStub: chỉ còn dùng trong test. Proxy dùng normalize_hash của thư viện 1.8 (defaultHashSentence
 *    trong handler.ts); test/handler.test.ts kiểm tra hai hàm cho cùng kết quả nên TM đã ghi bằng bản tạm vẫn trúng.
 *  - getGlossaryStateStub: chờ getGlossaryState của 2.8 (TV4).
 *  - countCharsStub: chờ countChars của thư viện 1.8 (chưa có). Theo đề xuất mục 7.1 Phần A: số code point của
 *    câu đã chuẩn hoá NFC, không tính ký hiệu {n} và thẻ hệ thống thêm (khác số ký tự AWS tính phí – xem charsSent).
 */
import { createHash } from 'node:crypto';
import { stripMarkers } from '../../libs/common/markers.js';
import { EMPTY_GLOSSARY_STATE, type GlossaryState } from '../../libs/common/tm.js';
import type { Ctx, Sha256Hex } from '../../libs/common/types.js';

export function hashSentenceStub(text: string): Sha256Hex {
  const normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export async function getGlossaryStateStub(_ctx: Ctx): Promise<GlossaryState> {
  return EMPTY_GLOSSARY_STATE;
}

export function countCharsStub(text: string): number {
  return Array.from(stripMarkers(text).normalize('NFC').replace(/\s+/gu, ' ').trim()).length;
}
