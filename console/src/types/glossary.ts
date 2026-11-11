/**
 * Kiểu dữ liệu màn Quản lý Thuật ngữ và Nhập CSV (Q3, Nhiệm vụ 4.11 – TV4).
 * Kết nối với dịch vụ F4 (Task 2.8 – services/api/glossary/glossaryManager.ts),
 * Hình 1.9, mục 1.3.3, Bảng 2.9 và Bảng 2.10 của báo cáo.
 */

export type GlossaryTermType = 'KEEP' | 'FIXED';

export type DuplicateHandlingMode = 'OVERWRITE' | 'KEEP_EXISTING';

export interface GlossaryTermEntry {
  /** Khóa chuẩn hóa NFC chữ thường của từ nguồn */
  normalizedTerm: string;
  /** Từ nguồn hiển thị (ví dụ: "Homestay ABC", "phố cổ Hội An") */
  sourceTerm: string;
  /** Ngôn ngữ nguồn (mặc định "vi") */
  sourceLang: string;
  /** KEEP = Giữ nguyên; FIXED = Dịch cố định */
  type: GlossaryTermType;
  /** Bản dịch theo mã ngôn ngữ đích (ví dụ { en: "Hoi An Ancient Town", ko: "호이안 구시가지" }) */
  translations: Record<string, string>;
  /** Phiên bản bảng thuật ngữ khi mục này được tạo/cập nhật */
  updatedInVersion: number;
  updatedAt: string;
}

export interface GlossaryStateResponse {
  version: number;
  terminologyName?: string;
  terms: GlossaryTermEntry[];
}

export interface UpsertGlossaryTermInput {
  sourceTerm: string;
  sourceLang: string;
  type: GlossaryTermType;
  translations: Record<string, string>;
  targetLangs: string[];
}

export interface UpsertGlossaryTermResponse {
  term: GlossaryTermEntry;
  version: number;
  terminologySynced?: boolean;
}

export interface DeleteGlossaryTermResponse {
  deleted: boolean;
  version: number;
  terminologySynced?: boolean;
}

export interface CsvImportRowError {
  row: number;
  reason: string;
}

export interface CsvImportPreviewOrCommitResult {
  validRows: number;
  errors: CsvImportRowError[];
  duplicates: { term: string }[];
  addedCount: number;
  overwrittenCount: number;
  skippedCount: number;
  version: number;
  terminologySynced?: boolean;
}
