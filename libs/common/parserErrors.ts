/**
 * parserErrors – các hằng số và lớp lỗi dùng chung cho các bộ phân tích định dạng (TXT, HTML, DOCX) của F10.
 */

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

/** Định dạng không hỗ trợ (hoặc chưa cắm vào) */
export class UnsupportedFormat extends Error {
  override name = 'UnsupportedFormat';
  constructor(public format: string) {
    super(`Định dạng không hỗ trợ: ${format}`);
  }
}
