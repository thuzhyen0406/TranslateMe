export interface ExtractOptions {
  customExclusionSelectors?: string[]; 
}

export interface ExtractResult {
  skeletonHtml: string;
  
  sentences: string[];
  
  placeholders: Record<string, string>;
}

/**
 * Hàm tách câu từ HTML
 * @param html String HTML nguyên bản nhận từ safe_fetch
 * @param options Cấu hình bổ sung (bộ chọn CSS bỏ qua...)
 */
export function extract(html: string, options?: ExtractOptions): ExtractResult;


export interface RebuildOptions {
  targetLang: string;     
  originalUrl: string;    
  slug: string;           
}

/**
 * Hàm ráp lại HTML hoàn chỉnh
 * @param skeletonHtml Cây HTML khung từ bước extract
 * @param translations Mảng các câu đã được dịch (theo đúng thứ tự mảng sentences)
 * @param placeholders Map ký hiệu mỏ neo khôi phục thẻ nội tuyến
 * @param options Các thông số cấu hình để rewrite URL, hreflang, widget...
 */
export function rebuild(
  skeletonHtml: string, 
  translations: string[], 
  placeholders: Record<string, string>,
  options: RebuildOptions
): string;


/**
 * ============================================================================
 * 3. NORMALIZE & CHUNK (TV3 phụ trách)
 * Nhiệm vụ: Chuẩn hóa Unicode/Hash và gom khối văn bản để gửi AWS Translate.
 * ============================================================================
 */

/**
 * Chuẩn hóa chuỗi (NFC, trim, gộp khoảng trắng) và trả về mã băm SHA-256
 * @param text Câu thuần văn bản
 * @returns Chuỗi Hash Hex 64 ký tự (dùng làm SK trong DynamoDB)
 */
export function normalize_hash(text: string): { normalizedText: string; hash: string };

/**
 * Gom các câu thành từng khối (chunk) không vượt quá giới hạn byte UTF-8 của AWS Translate
 * @param sentences Mảng các câu cần gom
 * @param maxBytes Giới hạn byte tối đa cho 1 request (mặc định: 10000 bytes)
 */
export function chunk_by_bytes(sentences: string[], maxBytes?: number): string[][];

export interface FetchOptions {
  timeoutMs?: number;      
  maxSizeBytes?: number;   
}

export interface FetchResult {
  status: number;                      
  headers: Record<string, string>;      
  body: string;                         
  finalUrl: string;                     
  isHtml: boolean;                       
}

/**
 * Hàm gọi HTTP an toàn chặn SSRF
 * @param targetUrl URL cần tải từ Website gốc
 * @param options Tùy chọn timeout và max size
 */
export function safe_fetch(targetUrl: string, options?: FetchOptions): Promise<FetchResult>;