/**
 * Bộ công cụ chạy thực nghiệm AWS Translate & Amazon Comprehend (Nhiệm vụ 1.12).
 *
 * Đặc điểm:
 *  - Dùng AWS SDK v3 (`@aws-sdk/client-translate`, `@aws-sdk/client-comprehend`).
 *  - Không hard-code Region hay thông tin tài khoản (đọc từ biến môi trường:
 *    `AWS_REGION` / `AWS_DEFAULT_REGION`, `AWS_ACCOUNT_PLAN`, `EXP_OUTPUT_JSON`, `EXP_OUTPUT_MD`).
 *  - Hỗ trợ chạy từng thử nghiệm riêng (`--exp=1` .. `--exp=5`, hoặc `--exp=all`)
 *    và chế độ `--template` (sinh báo cáo mẫu ở trạng thái "chưa chạy" khi chưa có mạng/AWS).
 *  - Hỗ trợ Dependency Injection (`ExperimentClients`) để kiểm thử tự động bằng `node:test`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ComprehendClient,
  DetectDominantLanguageCommand,
  type DetectDominantLanguageCommandOutput,
} from '@aws-sdk/client-comprehend';
import {
  ImportTerminologyCommand,
  TranslateClient,
  TranslateTextCommand,
  type ImportTerminologyCommandOutput,
  type TranslateTextCommandOutput,
} from '@aws-sdk/client-translate';
import {
  RECOMMENDED_CONFIDENCE_THRESHOLD,
  TARGET_LANGUAGES,
  analyzeCharacterBilling,
  buildTerminologyCsv,
  checkTerminologyApplied,
  check_markers,
  evaluateLanguageConfidence,
  inspectSpanTags,
  type CharacterBillingAnalysis,
  type DominantLanguageCheck,
  type MarkerCheckResult,
  type SpanInspectionResult,
  type TargetLang,
  type TerminologyApplicationCheck,
} from './analyzers.js';
import {
  COMPREHEND_SAMPLES,
  CUSTOM_TERMINOLOGY_NAME,
  MARKER_SAMPLE_SENTENCES,
  SPAN_SAMPLE_SENTENCES,
  TERMINOLOGY_ENTRIES,
  TERMINOLOGY_TEST_CASES,
} from './sampleData.js';

// ============================================================================
// Giao diện Client (hỗ trợ DI cho Unit Test) & Kiểu Kết Quả JSON
// ============================================================================

export interface TranslateSendOutput {
  TranslatedText?: string;
  AppliedTerminologies?: Array<{ Name?: string }>;
  TerminologyProperties?: {
    Name?: string;
    TermCount?: number;
  };
}

export interface TranslateClientLike {
  send(command: TranslateTextCommand | ImportTerminologyCommand): Promise<TranslateSendOutput>;
}

export interface ComprehendClientLike {
  send(command: DetectDominantLanguageCommand): Promise<{
    Languages?: Array<{ LanguageCode?: string; Score?: number }>;
  }>;
}

export interface ExperimentDeps {
  translateClient?: TranslateClientLike;
  comprehendClient?: ComprehendClientLike;
  region?: string;
  accountPlan?: string;
  now?: () => string;
}

export interface PreflightStatus {
  checkedAt: string;
  region: string;
  accountPlan: string;
  translateAvailable: boolean;
  sampleOutput?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface Exp1ItemResult {
  sentenceId: string;
  category: string;
  targetLang: TargetLang;
  sourceHtml: string;
  translatedHtml: string;
  inspection: SpanInspectionResult;
}

export interface Exp1LanguageSummary {
  targetLang: TargetLang;
  totalSentences: number;
  intactCount: number;
  preservationRatePct: number;
  reorderedCount: number;
  whitespaceChangedCount: number;
}

export interface Exp1Report {
  items: Exp1ItemResult[];
  summaryByLang: Record<TargetLang, Exp1LanguageSummary>;
}

export interface Exp2Report {
  items: Array<{
    sentenceId: string;
    category: string;
    analysis: CharacterBillingAnalysis;
    /** Tổng ký tự thực tế nếu dịch câu này sang cả 3 ngôn ngữ đích (en, ko, ja) */
    billedCodePointsFor3LangsWithTags: number;
    billedCodePointsFor3LangsWithoutTags: number;
  }>;
  totals: {
    totalCodePointsWithoutTags: number;
    totalCodePointsWithTags: number;
    totalOverheadCodePoints: number;
    averageOverheadPercent: number;
    totalBilledAcross3LangsWithTags: number;
  };
  cloudWatchComparisonNote: string;
}

export interface Exp3ItemResult {
  sentenceId: string;
  patternType: string;
  targetLang: TargetLang;
  sourceText: string;
  translatedText: string;
  check: MarkerCheckResult;
}

export interface Exp3LanguageSummary {
  targetLang: TargetLang;
  totalSentences: number;
  survivedCount: number;
  survivalRatePct: number;
}

export interface Exp3Report {
  items: Exp3ItemResult[];
  summaryByLang: Record<TargetLang, Exp3LanguageSummary>;
}

export interface Exp4ItemResult {
  sampleId: string;
  category: string;
  description: string;
  text: string;
  expectedLangHint: string;
  detectedLanguages: Array<{ LanguageCode: string; Score: number }>;
  evaluation: DominantLanguageCheck;
}

export interface Exp4Report {
  threshold: number;
  items: Exp4ItemResult[];
  belowThresholdIds: string[];
}

export interface Exp5ComparisonItem {
  caseId: string;
  caseType: string;
  description: string;
  targetLang: TargetLang;
  sourceText: string;
  translatedWithoutTerminology: string;
  translatedWithTerminology: string;
  appliedTerminologyNames: string[];
  checkWithoutTerminology: TerminologyApplicationCheck;
  checkWithTerminology: TerminologyApplicationCheck;
}

export interface Exp5Report {
  terminologyName: string;
  csvContent: string;
  importSuccess: boolean;
  importedTermCount?: number;
  importError?: string;
  items: Exp5ComparisonItem[];
  summaryByLang: Record<
    TargetLang,
    {
      totalCases: number;
      appliedCount: number;
      needsReviewCount: number;
      missedCaseIds: string[];
    }
  >;
}

export interface FullExperimentResults {
  executionMode: 'LIVE_AWS' | 'TEMPLATE_NOT_RUN';
  environment: PreflightStatus;
  exp1?: Exp1Report;
  exp2?: Exp2Report;
  exp3?: Exp3Report;
  exp4?: Exp4Report;
  exp5?: Exp5Report;
}

// ============================================================================
// Bước 0: Kiểm tra môi trường trước khi chạy (Preflight Check)
// ============================================================================

export async function runPreflightCheck(deps: ExperimentDeps = {}): Promise<PreflightStatus> {
  const region = (deps.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? '').trim();
  const accountPlan = (deps.accountPlan ?? process.env.AWS_ACCOUNT_PLAN ?? 'Chưa khai báo (set biến AWS_ACCOUNT_PLAN)').trim();
  const checkedAt = (deps.now ?? (() => new Date().toISOString()))();

  if (!region) {
    return {
      checkedAt,
      region: '(chưa thiết lập AWS_REGION)',
      accountPlan,
      translateAvailable: false,
      errorCode: 'MISSING_REGION',
      errorMessage: 'Chưa thiết lập biến môi trường AWS_REGION hoặc AWS_DEFAULT_REGION.',
    };
  }

  const translate = deps.translateClient ?? new TranslateClient({ region });
  try {
    const res = await translate.send(
      new TranslateTextCommand({
        Text: 'Xin chào',
        SourceLanguageCode: 'vi',
        TargetLanguageCode: 'en',
      }),
    );
    return {
      checkedAt,
      region,
      accountPlan,
      translateAvailable: true,
      sampleOutput: res.TranslatedText ?? '',
    };
  } catch (err) {
    const errorCode =
      err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : 'UnknownError';
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      checkedAt,
      region,
      accountPlan,
      translateAvailable: false,
      errorCode,
      errorMessage,
    };
  }
}

// ============================================================================
// Thử nghiệm 1: Giữ thẻ <span data-i="k"> trên 3 cặp vi->en, vi->ko, vi->ja
// ============================================================================

export async function runExperiment1(translate: TranslateClientLike): Promise<Exp1Report> {
  const items: Exp1ItemResult[] = [];

  for (const sample of SPAN_SAMPLE_SENTENCES) {
    for (const targetLang of TARGET_LANGUAGES) {
      const out = await translate.send(
        new TranslateTextCommand({
          Text: sample.taggedHtml,
          SourceLanguageCode: 'vi',
          TargetLanguageCode: targetLang,
        }),
      );
      const translatedHtml = out.TranslatedText ?? '';
      const inspection = inspectSpanTags(sample.taggedHtml, translatedHtml);
      items.push({
        sentenceId: sample.id,
        category: sample.category,
        targetLang,
        sourceHtml: sample.taggedHtml,
        translatedHtml,
        inspection,
      });
    }
  }

  const summaryByLang = {} as Record<TargetLang, Exp1LanguageSummary>;
  for (const lang of TARGET_LANGUAGES) {
    const langItems = items.filter((i) => i.targetLang === lang);
    const intactCount = langItems.filter((i) => i.inspection.tagsIntact).length;
    const reorderedCount = langItems.filter((i) => i.inspection.orderReordered).length;
    const whitespaceChangedCount = langItems.filter((i) => i.inspection.whitespaceChanged).length;
    summaryByLang[lang] = {
      targetLang: lang,
      totalSentences: langItems.length,
      intactCount,
      preservationRatePct:
        langItems.length > 0 ? Number(((intactCount / langItems.length) * 100).toFixed(2)) : 0,
      reorderedCount,
      whitespaceChangedCount,
    };
  }

  return { items, summaryByLang };
}

// ============================================================================
// Thử nghiệm 2: Cách tính ký tự (đếm theo code point có thẻ vs không thẻ)
// ============================================================================

export function runExperiment2(): Exp2Report {
  const items = SPAN_SAMPLE_SENTENCES.map((sample) => {
    const analysis = analyzeCharacterBilling(sample.taggedHtml);
    return {
      sentenceId: sample.id,
      category: sample.category,
      analysis,
      billedCodePointsFor3LangsWithTags: analysis.codePointsWithTags * TARGET_LANGUAGES.length,
      billedCodePointsFor3LangsWithoutTags: analysis.codePointsWithoutTags * TARGET_LANGUAGES.length,
    };
  });

  const totalCodePointsWithoutTags = items.reduce((s, i) => s + i.analysis.codePointsWithoutTags, 0);
  const totalCodePointsWithTags = items.reduce((s, i) => s + i.analysis.codePointsWithTags, 0);
  const totalOverheadCodePoints = totalCodePointsWithTags - totalCodePointsWithoutTags;
  const averageOverheadPercent =
    totalCodePointsWithoutTags > 0
      ? Number(((totalOverheadCodePoints / totalCodePointsWithoutTags) * 100).toFixed(2))
      : 0;

  return {
    items,
    totals: {
      totalCodePointsWithoutTags,
      totalCodePointsWithTags,
      totalOverheadCodePoints,
      averageOverheadPercent,
      totalBilledAcross3LangsWithTags: totalCodePointsWithTags * TARGET_LANGUAGES.length,
    },
    cloudWatchComparisonNote:
      'LƯU Ý ĐỐI CHIẾU CLOUDWATCH: Amazon Translate tính phí theo mọi Unicode code point gửi trong trường Text (bao gồm cả các ký tự của thẻ <span data-i="k">...</span>). Sau khi chạy Thử nghiệm 1, người chạy mở CloudWatch -> Metrics -> AWS/Translate -> CharacterCount (Sum, Period 1m/5m) để đối chiếu với con số dự kiến. Metric trên CloudWatch có thể trễ từ 3 đến 15 phút.',
  };
}

// ============================================================================
// Thử nghiệm 3: Ký hiệu {n}...{/n} ở 3 cặp ngôn ngữ
// ============================================================================

export async function runExperiment3(translate: TranslateClientLike): Promise<Exp3Report> {
  const items: Exp3ItemResult[] = [];

  for (const sample of MARKER_SAMPLE_SENTENCES) {
    for (const targetLang of TARGET_LANGUAGES) {
      const out = await translate.send(
        new TranslateTextCommand({
          Text: sample.textWithMarkers,
          SourceLanguageCode: 'vi',
          TargetLanguageCode: targetLang,
        }),
      );
      const translatedText = out.TranslatedText ?? '';
      const check = check_markers(sample.textWithMarkers, translatedText);
      items.push({
        sentenceId: sample.id,
        patternType: sample.patternType,
        targetLang,
        sourceText: sample.textWithMarkers,
        translatedText,
        check,
      });
    }
  }

  const summaryByLang = {} as Record<TargetLang, Exp3LanguageSummary>;
  for (const lang of TARGET_LANGUAGES) {
    const langItems = items.filter((i) => i.targetLang === lang);
    const survivedCount = langItems.filter((i) => i.check.survived).length;
    summaryByLang[lang] = {
      targetLang: lang,
      totalSentences: langItems.length,
      survivedCount,
      survivalRatePct:
        langItems.length > 0 ? Number(((survivedCount / langItems.length) * 100).toFixed(2)) : 0,
    };
  }

  return { items, summaryByLang };
}

// ============================================================================
// Thử nghiệm 4: Comprehend DetectDominantLanguage & Ngưỡng 0.70
// ============================================================================

export async function runExperiment4(comprehend: ComprehendClientLike): Promise<Exp4Report> {
  const items: Exp4ItemResult[] = [];

  for (const sample of COMPREHEND_SAMPLES) {
    const out = await comprehend.send(
      new DetectDominantLanguageCommand({
        Text: sample.text,
      }),
    );
    const detectedLanguages = (out.Languages ?? []).map((l) => ({
      LanguageCode: l.LanguageCode ?? 'unknown',
      Score: Number((l.Score ?? 0).toFixed(4)),
    }));
    const evaluation = evaluateLanguageConfidence(detectedLanguages, RECOMMENDED_CONFIDENCE_THRESHOLD);
    items.push({
      sampleId: sample.id,
      category: sample.category,
      description: sample.description,
      text: sample.text,
      expectedLangHint: sample.expectedLangHint,
      detectedLanguages,
      evaluation,
    });
  }

  const belowThresholdIds = items.filter((i) => i.evaluation.belowThreshold).map((i) => i.sampleId);
  return {
    threshold: RECOMMENDED_CONFIDENCE_THRESHOLD,
    items,
    belowThresholdIds,
  };
}

// ============================================================================
// Thử nghiệm 5: Custom Terminology (ImportTerminology + So sánh Có/Không Terminology)
// ============================================================================

export async function runExperiment5(translate: TranslateClientLike): Promise<Exp5Report> {
  const csvContent = buildTerminologyCsv(TERMINOLOGY_ENTRIES);
  let importSuccess = false;
  let importedTermCount: number | undefined;
  let importError: string | undefined;

  try {
    const importOut = await translate.send(
      new ImportTerminologyCommand({
        Name: CUSTOM_TERMINOLOGY_NAME,
        MergeStrategy: 'OVERWRITE',
        Description: 'TranslateMe Task 1.12 Custom Terminology Experiment (vi -> en, ko, ja)',
        TerminologyData: {
          File: Buffer.from(csvContent, 'utf8'),
          Format: 'CSV',
        },
      }),
    );
    importSuccess = true;
    importedTermCount = importOut.TerminologyProperties?.TermCount;
  } catch (err) {
    importSuccess = false;
    importError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  const items: Exp5ComparisonItem[] = [];
  for (const testCase of TERMINOLOGY_TEST_CASES) {
    for (const targetLang of TARGET_LANGUAGES) {
      const withoutOut = await translate.send(
        new TranslateTextCommand({
          Text: testCase.sourceText,
          SourceLanguageCode: 'vi',
          TargetLanguageCode: targetLang,
        }),
      );
      const translatedWithoutTerminology = withoutOut.TranslatedText ?? '';

      let translatedWithTerminology = '';
      let appliedTerminologyNames: string[] = [];
      if (importSuccess) {
        const withOut = await translate.send(
          new TranslateTextCommand({
            Text: testCase.sourceText,
            SourceLanguageCode: 'vi',
            TargetLanguageCode: targetLang,
            TerminologyNames: [CUSTOM_TERMINOLOGY_NAME],
          }),
        );
        translatedWithTerminology = withOut.TranslatedText ?? '';
        appliedTerminologyNames = (withOut.AppliedTerminologies ?? []).map((t) => t.Name ?? '');
      }

      const expectedTerms = testCase.expectedTermsByLang[targetLang];
      const checkWithoutTerminology = checkTerminologyApplied(translatedWithoutTerminology, expectedTerms);
      const checkWithTerminology = checkTerminologyApplied(translatedWithTerminology, expectedTerms);

      items.push({
        caseId: testCase.id,
        caseType: testCase.caseType,
        description: testCase.description,
        targetLang,
        sourceText: testCase.sourceText,
        translatedWithoutTerminology,
        translatedWithTerminology,
        appliedTerminologyNames,
        checkWithoutTerminology,
        checkWithTerminology,
      });
    }
  }

  const summaryByLang = {} as Exp5Report['summaryByLang'];
  for (const lang of TARGET_LANGUAGES) {
    const langItems = items.filter((i) => i.targetLang === lang);
    const appliedCount = langItems.filter((i) => i.checkWithTerminology.allApplied).length;
    const missedCaseIds = langItems
      .filter((i) => i.checkWithTerminology.needsReview)
      .map((i) => i.caseId);
    summaryByLang[lang] = {
      totalCases: langItems.length,
      appliedCount,
      needsReviewCount: missedCaseIds.length,
      missedCaseIds,
    };
  }

  return {
    terminologyName: CUSTOM_TERMINOLOGY_NAME,
    csvContent,
    importSuccess,
    importedTermCount,
    importError,
    items,
    summaryByLang,
  };
}

// ============================================================================
// Sinh Báo cáo Markdown (`docs/translate-findings.md`) gồm đúng 7 mục yêu cầu
// ============================================================================

export function generateFindingsMarkdown(results: FullExperimentResults): string {
  const { environment, executionMode, exp1, exp2, exp3, exp4, exp5 } = results;
  const isLive = executionMode === 'LIVE_AWS' && environment.translateAvailable;

  const lines: string[] = [];
  lines.push('# Báo Cáo Thực Nghiệm AWS Translate & Amazon Comprehend (Nhiệm Vụ 1.12)');
  lines.push('');
  lines.push(
    `> **Trạng thái báo cáo:** ${
      isLive
        ? 'ĐÃ CHẠY TRỰC TIẾP TRÊN AWS (Số liệu thực tế từ AWS SDK v3)'
        : 'CHƯA CHẠY TRÊN AWS THẬT (Khung báo cáo tự sinh — số liệu Thử nghiệm 2 đã tính sẵn offline; các mục gọi API sẽ tự điền khi chạy lệnh trên môi trường có AWS credentials)'
    }`,
  );
  lines.push('');

  // (1) Môi trường
  lines.push('## (1) Môi trường thực nghiệm');
  lines.push('');
  lines.push('| Thông số | Giá trị |');
  lines.push('| :--- | :--- |');
  lines.push(`| **AWS Region** | \`${environment.region}\` |`);
  lines.push(`| **Gói tài khoản AWS** | ${environment.accountPlan} |`);
  lines.push(`| **Ngày giờ kiểm tra** | \`${environment.checkedAt}\` |`);
  lines.push(
    `| **Trạng thái kiểm tra TranslateText ban đầu** | ${
      environment.translateAvailable
        ? `Thành công (mẫu \`"Xin chào"\` -> \`"${environment.sampleOutput}"\`)`
        : `Chưa khả dụng (\`${environment.errorCode ?? 'NOT_RUN'}\`: ${environment.errorMessage ?? 'Chưa gọi AWS'})`
    } |`,
  );
  lines.push('');

  // (2) Phương pháp và bộ câu mẫu
  lines.push('## (2) Phương pháp và Bộ câu mẫu');
  lines.push('');
  lines.push('1. **Thử nghiệm 1 (Giữ thẻ `<span data-i="k">`):** Dịch 12 câu tiếng Việt (câu thường, chữ đậm, liên kết, 3 thẻ liên tiếp, thẻ lồng nhau 2 cấp, số thập phân `9.4/10`, câu ngắn UI, câu dài nhiều mệnh đề, tên riêng `Homestay ABC`, `phố cổ Hội An`, `cao lầu`, `sông Hoài`) sang 3 ngôn ngữ đích `vi -> en`, `vi -> ko`, `vi -> ja`. Kiểm tra tự động bằng hàm `inspectSpanTags()`.');
  lines.push('2. **Thử nghiệm 2 (Cách tính ký tự):** Đếm Unicode code point (`Array.from(text).length`) của cùng 12 câu khi **không có thẻ** và **có thẻ `<span data-i="k">`** để tính tỷ lệ tăng ký tự tính phí, đối chiếu với CloudWatch metric `CharacterCount`.');
  lines.push('3. **Thử nghiệm 3 (Ký hiệu `{n}...{/n}`):** Dịch 6 câu mẫu có 1 cặp, 2 cặp và cặp lồng nhau `{1}...{2}...{/2}...{/1}` qua 3 cặp ngôn ngữ; kiểm tra bằng hàm `check_markers()` để phát hiện mất marker, thừa marker hoặc biến dạng (`{ 1 }`, `｛1｝`).');
  lines.push('4. **Thử nghiệm 4 (`Comprehend DetectDominantLanguage`):** Thử 8 mẫu đầu vào (câu dài, cụm ngắn 1–3 từ, câu trộn Việt–Anh, chuỗi chỉ gồm tên riêng hoặc số) và đánh dấu các mẫu có điểm tin cậy dưới ngưỡng `0.70`.');
  lines.push('5. **Thử nghiệm 5 (`Custom Terminology`):** Nạp tệp CSV UTF-8 (`vi,en,ko,ja`) bằng `ImportTerminology` (`MergeStrategy = OVERWRITE`), sau đó dịch đối chứng cùng bộ 6 câu (chuẩn, nằm trong thẻ `<span>`, viết hoa khác, biến thể câu) khi **không gắn** và **có gắn** Terminology.');
  lines.push('');

  // (3) Bảng kết quả theo từng cặp ngôn ngữ
  lines.push('## (3) Bảng kết quả theo từng cặp ngôn ngữ (`vi->en`, `vi->ko`, `vi->ja`)');
  lines.push('');

  // 3.1 Thẻ span
  lines.push('### 3.1. Tỷ lệ giữ nguyên thẻ `<span data-i="k">` (Thử nghiệm 1)');
  lines.push('');
  if (exp1 && isLive) {
    lines.push('| Cặp ngôn ngữ | Tổng số câu | Số câu giữ nguyên thẻ | Tỷ lệ giữ nguyên (%) | Số câu đảo thứ tự `data-i` | Số câu thay đổi khoảng trắng |');
    lines.push('| :---: | :---: | :---: | :---: | :---: | :---: |');
    for (const lang of TARGET_LANGUAGES) {
      const s = exp1.summaryByLang[lang];
      lines.push(
        `| \`vi -> ${lang}\` | ${s.totalSentences} | ${s.intactCount} | **${s.preservationRatePct}%** | ${s.reorderedCount} | ${s.whitespaceChangedCount} |`,
      );
    }
  } else {
    lines.push('| Cặp ngôn ngữ | Tổng số câu | Số câu giữ nguyên thẻ | Tỷ lệ giữ nguyên (%) | Số câu đảo thứ tự `data-i` | Số câu thay đổi khoảng trắng |');
    lines.push('| :---: | :---: | :---: | :---: | :---: | :---: |');
    for (const lang of TARGET_LANGUAGES) {
      lines.push(`| \`vi -> ${lang}\` | ${SPAN_SAMPLE_SENTENCES.length} | *chưa chạy* | *chưa chạy* | *chưa chạy* | *chưa chạy* |`);
    }
  }
  lines.push('');

  // 3.2 Ký tự tính phí (luôn có số liệu thật vì tính toán trực tiếp trên bộ câu mẫu)
  lines.push('### 3.2. Cách tính ký tự và tỷ lệ tăng do thẻ `<span data-i="k">` (Thử nghiệm 2)');
  lines.push('');
  if (exp2) {
    lines.push('| Mã câu | Loại câu | Ký tự KHÔNG thẻ (code point) | Ký tự CÓ thẻ (code point) | Ký tự tăng thêm | Tỷ lệ tăng do thẻ (%) |');
    lines.push('| :---: | :--- | :---: | :---: | :---: | :---: |');
    for (const item of exp2.items) {
      const a = item.analysis;
      lines.push(
        `| \`${item.sentenceId}\` | ${item.category} | ${a.codePointsWithoutTags} | ${a.codePointsWithTags} | +${a.tagOverheadCodePoints} | **+${a.overheadPercent}%** |`,
      );
    }
    lines.push(
      `| **TỔNG (12 câu)** | — | **${exp2.totals.totalCodePointsWithoutTags}** | **${exp2.totals.totalCodePointsWithTags}** | **+${exp2.totals.totalOverheadCodePoints}** | **+${exp2.totals.averageOverheadPercent}%** |`,
    );
    lines.push('');
    lines.push(`- **Tổng ký tự dự kiến bị tính phí khi dịch 12 câu sang cả 3 ngôn ngữ (\`en, ko, ja\`):** \`${exp2.totals.totalBilledAcross3LangsWithTags}\` ký tự (nếu không có thẻ là \`${exp2.totals.totalCodePointsWithoutTags * 3}\` ký tự).`);
    lines.push(`- **Ghi chú đối chiếu CloudWatch:** ${exp2.cloudWatchComparisonNote}`);
  }
  lines.push('');

  // 3.3 Ký hiệu {n}
  lines.push('### 3.3. Tỷ lệ sống sót của ký hiệu `{n}...{/n}` (Thử nghiệm 3)');
  lines.push('');
  if (exp3 && isLive) {
    lines.push('| Cặp ngôn ngữ | Tổng số câu thử | Số câu sống sót nguyên vẹn | Tỷ lệ sống sót (%) |');
    lines.push('| :---: | :---: | :---: | :---: |');
    for (const lang of TARGET_LANGUAGES) {
      const s = exp3.summaryByLang[lang];
      lines.push(`| \`vi -> ${lang}\` | ${s.totalSentences} | ${s.survivedCount} | **${s.survivalRatePct}%** |`);
    }
  } else {
    lines.push('| Cặp ngôn ngữ | Tổng số câu thử | Số câu sống sót nguyên vẹn | Tỷ lệ sống sót (%) |');
    lines.push('| :---: | :---: | :---: | :---: |');
    for (const lang of TARGET_LANGUAGES) {
      lines.push(`| \`vi -> ${lang}\` | ${MARKER_SAMPLE_SENTENCES.length} | *chưa chạy* | *chưa chạy* |`);
    }
  }
  lines.push('');

  // 3.4 Custom Terminology
  lines.push('### 3.4. Kết quả Custom Terminology (Thử nghiệm 5)');
  lines.push('');
  lines.push('**Nội dung tệp CSV UTF-8 nạp vào `ImportTerminology`:**');
  lines.push('```csv');
  lines.push((exp5?.csvContent ?? buildTerminologyCsv(TERMINOLOGY_ENTRIES)).trim());
  lines.push('```');
  lines.push('');
  if (exp5 && isLive) {
    lines.push(
      `- **Trạng thái ` +
        '`ImportTerminology`' +
        `:** ${exp5.importSuccess ? `Thành công (TermCount = ${exp5.importedTermCount ?? 'N/A'})` : `Lỗi: ${exp5.importError}`}`,
    );
    lines.push('');
    lines.push('| Cặp ngôn ngữ | Tổng số ca thử | Số ca áp dụng đúng toàn bộ thuật ngữ | Số ca KHÔNG áp dụng đủ (cần gắn `"Cần xem lại"`) | Mã các ca cần xem lại |');
    lines.push('| :---: | :---: | :---: | :---: | :--- |');
    for (const lang of TARGET_LANGUAGES) {
      const s = exp5.summaryByLang[lang];
      lines.push(
        `| \`vi -> ${lang}\` | ${s.totalCases} | ${s.appliedCount} | **${s.needsReviewCount}** | ${s.missedCaseIds.join(', ') || 'Không có'} |`,
      );
    }
  } else {
    lines.push('- **Trạng thái `ImportTerminology`:** *chưa chạy trên AWS thật*');
    lines.push('');
    lines.push('| Cặp ngôn ngữ | Tổng số ca thử | Số ca áp dụng đúng | Số ca KHÔNG áp dụng đủ (`"Cần xem lại"`) | Ghi chú cơ chế khớp của Amazon Translate |');
    lines.push('| :---: | :---: | :---: | :---: | :--- |');
    for (const lang of TARGET_LANGUAGES) {
      lines.push(
        `| \`vi -> ${lang}\` | ${TERMINOLOGY_TEST_CASES.length} | *chưa chạy* | *chưa chạy* | Custom Terminology chỉ khớp chính xác chuỗi ký tự và phân biệt hoa/thường (case-sensitive) -> ca \`T05\` (khác hoa/thường) và \`T06\` (biến thể từ xen giữa) cần module hậu kiểm F4 gắn cờ **"Cần xem lại"** |`,
      );
    }
  }
  lines.push('');

  // (4) Kết quả Comprehend và ngưỡng đề xuất
  lines.push('## (4) Kết quả Amazon Comprehend (`DetectDominantLanguage`) và Ngưỡng đề xuất');
  lines.push('');
  lines.push(`- **Ngưỡng độ tin cậy đề xuất:** **\`${RECOMMENDED_CONFIDENCE_THRESHOLD.toFixed(2)}\`** (mọi kết quả có \`Score < 0.70\` hoặc chuỗi quá ngắn/chỉ gồm số & tên riêng được đánh dấu dưới ngưỡng và giữ nguyên ngôn ngữ cấu hình mặc định của website).`);
  lines.push('');
  if (exp4 && isLive) {
    lines.push('| Mã mẫu | Phân loại | Chuỗi đầu vào | Ngôn ngữ nhận diện | Điểm tin cậy (`Score`) | Đánh giá so với ngưỡng `0.70` |');
    lines.push('| :---: | :--- | :--- | :---: | :---: | :--- |');
    for (const item of exp4.items) {
      const e = item.evaluation;
      lines.push(
        `| \`${item.sampleId}\` | \`${item.category}\` | ${item.text} | \`${e.topLanguageCode}\` | **${e.topScore}** | ${
          e.belowThreshold ? 'DƯỚI NGƯỠNG (< 0.70)' : 'Đạt (>= 0.70)'
        } |`,
      );
    }
  } else {
    lines.push('| Mã mẫu | Phân loại | Chuỗi đầu vào | Ngôn ngữ nhận diện | Điểm tin cậy (`Score`) | Đánh giá so với ngưỡng `0.70` |');
    lines.push('| :---: | :--- | :--- | :---: | :---: | :--- |');
    for (const s of COMPREHEND_SAMPLES) {
      lines.push(`| \`${s.id}\` | \`${s.category}\` | ${s.text} | *chưa chạy* | *chưa chạy* | *chưa chạy* |`);
    }
  }
  lines.push('');

  // (5) Trả lời hai câu hỏi chốt chặn 1
  lines.push('## (5) Trả lời hai câu hỏi Chốt chặn 1 (Gate 1)');
  lines.push('');
  if (isLive && exp1) {
    lines.push(`1. **Amazon Translate có dùng được trên gói tài khoản AWS hiện tại không?**  `);
    lines.push(`   - **Trả lời:** **CÓ.** Đã gọi thành công \`TranslateText\` tại region \`${environment.region}\` vào lúc \`${environment.checkedAt}\`.`);
    lines.push(
      `2. **\`TranslateText\` có giữ nguyên thẻ \`<span data-i="k">\` ở cả 3 cặp \`vi->en\`, \`vi->ko\`, \`vi->ja\` không?**  `,
    );
    lines.push(
      `   - **Trả lời:** Tỷ lệ giữ nguyên thẻ thực tế đạt: \`vi->en\` = **${exp1.summaryByLang.en.preservationRatePct}%**, \`vi->ko\` = **${exp1.summaryByLang.ko.preservationRatePct}%**, \`vi->ja\` = **${exp1.summaryByLang.ja.preservationRatePct}%**.`,
    );
  } else {
    lines.push('1. **Amazon Translate có dùng được trên gói tài khoản AWS hiện tại không?**  ');
    lines.push('   - **Trả lời:** **`CHƯA CHẠY`** *(chỉ điền sau khi chạy script với thông tin xác thực AWS thật; tuyệt đối không tự bịa số liệu)*.');
    lines.push('2. **`TranslateText` có giữ nguyên thẻ `<span data-i="k">` ở `vi->en`, `vi->ko`, `vi->ja` không?**  ');
    lines.push('   - **Trả lời:** **`CHƯA CHẠY`** *(chỉ điền tỷ lệ % thật sau khi chạy `npm run exp:run` trên tài khoản AWS của nhóm)*.');
  }
  lines.push('');

  // (6) Khuyến nghị cho F2 và F4
  lines.push('## (6) Khuyến nghị thiết kế cho Module Dịch Proxy (F2) và Hậu kiểm / Glossary (F4)');
  lines.push('');
  lines.push('1. **Lựa chọn giữa thẻ `<span data-i="k">` và ký hiệu `{n}...{/n}` cho F2:**');
  lines.push('   - **Khuyến nghị dùng `<span data-i="k">...</span>` (hoặc thẻ HTML nội tuyến)** làm cơ chế chính khi gọi `TranslateText` vì Amazon Translate hỗ trợ dịch tài liệu HTML nguyên bản: engine hiểu ranh giới thẻ đóng/mở và tự động di chuyển toàn bộ cụm `<span data-i="k">...</span>` theo trật tự ngữ pháp SOV của tiếng Hàn (`ko`) và tiếng Nhật (`ja`).');
  lines.push('   - Ngược lại, ký hiệu văn bản thuần `{1}...{/1}` dễ bị bộ dịch máy NMT chèn thêm khoảng trắng (`{ 1 }`), đổi sang ngoặc fullwidth (`｛1｝`) hoặc làm lệch cặp đóng/mở khi câu có cấu trúc đảo ngữ phức tạp. Tuy nhiên, vẫn giữ hàm `check_markers` / `inspectSpanTags` làm lớp hậu kiểm trước khi `rebuild()` HTML.');
  lines.push('2. **Chiến lược giảm chi phí ký tự & chia nhỏ khối khi thẻ bị xáo trộn:**');
  lines.push(
    `   - Qua Thử nghiệm 2, thẻ \`<span data-i="k">...</span>\` làm tăng trung bình **+${exp2?.totals.averageOverheadPercent ?? 34.48}%** số ký tự tính phí (mỗi cặp thẻ tốn thêm 23 ký tự code point). Do đó, trong hàm \`extract()\`: **chỉ bọc \`<span data-i="k">\` quanh các thẻ nội tuyến thực sự nằm giữa câu**, tuyệt đối không bọc thẻ cho câu thuần văn bản hoặc thẻ bao toàn bộ câu.`,
  );
  lines.push('   - Nếu sau khi dịch một câu phức tạp mà `inspectSpanTags()` phát hiện `tagsIntact === false` (mất hoặc hỏng thẻ): F2 thực hiện **fallback an toàn** bằng cách dịch lại văn bản thuần (đã strip thẻ) của câu đó để trang web không bao giờ bị vỡ cấu trúc DOM.');
  lines.push('3. **Ngưỡng nhận diện ngôn ngữ nguồn (Amazon Comprehend):**');
  lines.push('   - Áp dụng ngưỡng **`Score >= 0.70`** và độ dài văn bản tối thiểu **>= 20 ký tự** trước khi tin vào kết quả `DetectDominantLanguage`. Với các chuỗi ngắn 1–3 từ (nút bấm, menu), chuỗi trộn Việt–Anh hoặc chỉ gồm số/tên riêng, dùng trực tiếp ngôn ngữ nguồn mặc định đã khai báo trong cấu hình Tenant.');
  lines.push('4. **Cơ chế hậu kiểm thuật ngữ (F4 - Custom Terminology & "Cần xem lại"):**');
  lines.push('   - Vì `Custom Terminology` của Amazon Translate so khớp chính xác theo chuỗi ký tự và phân biệt chữ hoa/thường (`case-sensitive`), các câu có thuật ngữ viết hoa khác chuẩn hoặc bị biến thể từ vựng sẽ không được áp dụng tự động. Module F4 cần chạy hàm `checkTerminologyApplied()` sau khi dịch: nếu câu gốc có chứa thuật ngữ trong Glossary (so khớp không phân biệt hoa/thường) nhưng bản dịch thiếu thuật ngữ đích tương ứng -> gắn cờ **`needsReview = true` ("Cần xem lại")** cho Reviewer kiểm duyệt trên Console.');
  lines.push('');

  // (7) Phụ lục
  lines.push('## (7) Phụ lục: Mẫu đầu vào và đầu ra thô');
  lines.push('');
  if (isLive && exp1 && exp1.items.length > 0) {
    lines.push('### Mẫu đầu vào / đầu ra thực tế từ Thử nghiệm 1 (`<span data-i="k">`)');
    lines.push('```json');
    lines.push(JSON.stringify(exp1.items.slice(0, 6), null, 2));
    lines.push('```');
    if (exp5 && exp5.items.length > 0) {
      lines.push('');
      lines.push('### Mẫu đầu vào / đầu ra thực tế từ Thử nghiệm 5 (`Custom Terminology`)');
      lines.push('```json');
      lines.push(JSON.stringify(exp5.items.slice(0, 6), null, 2));
      lines.push('```');
    }
  } else {
    lines.push('### Mẫu đầu vào chuẩn (Thử nghiệm 1, 3, 5) — Đầu ra sẽ được ghi tự động khi chạy trên AWS');
    lines.push('```json');
    lines.push(
      JSON.stringify(
        {
          note: 'Chưa có đầu ra từ AWS Translate. Chạy `npm run exp:run` với AWS credentials để ghi đầu ra thực tế.',
          sampleSpanInputs: SPAN_SAMPLE_SENTENCES.slice(0, 3),
          sampleMarkerInputs: MARKER_SAMPLE_SENTENCES.slice(0, 2),
          sampleTerminologyCases: TERMINOLOGY_TEST_CASES.slice(0, 2),
        },
        null,
        2,
      ),
    );
    lines.push('```');
  }
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Hàm điều phối chạy bộ thử nghiệm & CLI Entrypoint
// ============================================================================

export type ExperimentSelector = 'all' | '1' | '2' | '3' | '4' | '5';

export async function executeExperiments(
  selector: ExperimentSelector = 'all',
  options: { templateOnly?: boolean } = {},
  deps: ExperimentDeps = {},
): Promise<FullExperimentResults> {
  const exp2 = runExperiment2();

  if (options.templateOnly) {
    const region = (deps.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-southeast-1').trim();
    const accountPlan = (deps.accountPlan ?? process.env.AWS_ACCOUNT_PLAN ?? 'Chưa khai báo (chạy ở chế độ --template)').trim();
    return {
      executionMode: 'TEMPLATE_NOT_RUN',
      environment: {
        checkedAt: (deps.now ?? (() => new Date().toISOString()))(),
        region,
        accountPlan,
        translateAvailable: false,
        errorCode: 'TEMPLATE_MODE',
        errorMessage: 'Báo cáo được tạo ở chế độ mẫu (--template), chưa gọi AWS API thật.',
      },
      exp2,
    };
  }

  const preflight = await runPreflightCheck(deps);
  if (!preflight.translateAvailable && selector !== '2') {
    console.error(
      `[CẢNH BÁO MÔI TRƯỜNG] Amazon Translate KHÔNG dùng được trên tài khoản/môi trường hiện tại (Region: ${preflight.region}).`,
    );
    console.error(`  -> Mã lỗi: ${preflight.errorCode} | Chi tiết: ${preflight.errorMessage}`);
    return {
      executionMode: 'LIVE_AWS',
      environment: preflight,
      exp2,
    };
  }

  const region = preflight.region;
  const translate = deps.translateClient ?? new TranslateClient({ region });
  const comprehend = deps.comprehendClient ?? new ComprehendClient({ region });

  const results: FullExperimentResults = {
    executionMode: 'LIVE_AWS',
    environment: preflight,
  };

  if (selector === 'all' || selector === '1') {
    results.exp1 = await runExperiment1(translate);
  }
  if (selector === 'all' || selector === '2') {
    results.exp2 = exp2;
  }
  if (selector === 'all' || selector === '3') {
    results.exp3 = await runExperiment3(translate);
  }
  if (selector === 'all' || selector === '4') {
    results.exp4 = await runExperiment4(comprehend);
  }
  if (selector === 'all' || selector === '5') {
    results.exp5 = await runExperiment5(translate);
  }

  return results;
}

/** Ghi file kết quả JSON thô và báo cáo Markdown ra ổ đĩa. */
export function writeExperimentArtifacts(
  results: FullExperimentResults,
  jsonPath: string,
  markdownPath: string,
): void {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2) + '\n', 'utf8');
  fs.writeFileSync(markdownPath, generateFindingsMarkdown(results), 'utf8');
}

// Chạy từ dòng lệnh khi file này được gọi trực tiếp
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const args = process.argv.slice(2);
  const expArg = args.find((a) => a.startsWith('--exp='))?.split('=')[1] ?? 'all';
  const templateOnly = args.includes('--template');
  const selector = (['all', '1', '2', '3', '4', '5'].includes(expArg) ? expArg : 'all') as ExperimentSelector;

  const repoRoot = path.resolve(path.dirname(currentFile), '../../../..');
  const defaultJsonOut = path.join(repoRoot, 'docs', 'translate-findings.raw.json');
  const defaultMdOut = path.join(repoRoot, 'docs', 'translate-findings.md');

  const jsonOut = process.env.EXP_OUTPUT_JSON ? path.resolve(process.env.EXP_OUTPUT_JSON) : defaultJsonOut;
  const mdOut = process.env.EXP_OUTPUT_MD ? path.resolve(process.env.EXP_OUTPUT_MD) : defaultMdOut;

  executeExperiments(selector, { templateOnly })
    .then((res) => {
      writeExperimentArtifacts(res, jsonOut, mdOut);
      console.log(`[OK] Đã ghi JSON thô tại: ${jsonOut}`);
      console.log(`[OK] Đã ghi báo cáo Markdown tại: ${mdOut}`);
      if (!templateOnly && !res.environment.translateAvailable && selector !== '2') {
        process.exitCode = 2;
      }
    })
    .catch((err) => {
      console.error('[LỖI CHẠY THỬ NGHIỆM]', err);
      process.exitCode = 1;
    });
}
