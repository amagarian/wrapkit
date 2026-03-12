import * as pdfjsLib from "pdfjs-dist";
import type { CanonicalFieldId, Template, TemplateFingerprint } from "@/types";
import { embedDocument, classifyFormType } from "@/utils/embeddings";

interface TextItem {
  str: string;
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "your",
  "this",
  "that",
  "from",
  "into",
  "card",
  "credit",
  "form",
  "name",
  "date",
  "page",
  "use",
]);

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fp-${(hash >>> 0).toString(16)}`;
}

function deriveFileNameHints(fileName?: string, templateName?: string): string[] {
  return unique(
    [fileName, templateName]
      .filter(Boolean)
      .flatMap((value) => tokenize(value ?? ""))
      .slice(0, 12)
  );
}

export async function buildPdfFingerprint(
  pdfBytes: Uint8Array,
  fileName?: string
): Promise<TemplateFingerprint> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdf = await loadingTask.promise;
  const pageFingerprints: TemplateFingerprint["pageFingerprints"] = [];
  const aggregateTokens: string[] = [];
  const checkboxTerms: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const pageText = (textContent.items as TextItem[])
      .map((item) => item.str?.trim?.() ?? "")
      .filter(Boolean)
      .join(" ");
    const tokens = unique(tokenize(pageText)).slice(0, 24);
    aggregateTokens.push(...tokens);
    if (pageText.includes("☐") || pageText.includes("□")) {
      checkboxTerms.push("checkbox");
    }

    pageFingerprints.push({
      pageNumber,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      anchorTerms: tokens,
      textDigest: hashString(tokens.join("|")),
    });
  }

  const anchorTerms = unique(aggregateTokens).slice(0, 48);
  const fileNameHints = deriveFileNameHints(fileName);
  const fingerprintHash = hashString(
    JSON.stringify({
      pageCount: pdf.numPages,
      pageFingerprints: pageFingerprints.map((page) => ({
        width: page.width,
        height: page.height,
        textDigest: page.textDigest,
      })),
      anchorTerms,
      fileNameHints,
    })
  );

  let embedding: number[] | undefined;
  let formType: string | undefined;
  try {
    const base64 = uint8ArrayToBase64(bytesCopy);
    embedding = await embedDocument(base64);
    if (embedding && embedding.length > 0) {
      const classification = await classifyFormType(embedding);
      formType = classification.type;
      console.log(`[Wrapkit Embed] Form classified as "${formType}" (confidence: ${classification.confidence.toFixed(3)})`);
    }
  } catch (err) {
    console.warn("[Wrapkit Embed] Document embedding failed, falling back to token-only fingerprint:", err);
  }

  return {
    version: 1,
    pageCount: pdf.numPages,
    pageFingerprints,
    anchorTerms,
    checkboxTerms: unique(checkboxTerms),
    canonicalFieldIds: [],
    fileNameHints,
    fingerprintHash,
    embedding,
    formType,
  };
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function buildTemplateFingerprintFromTemplate(template: Template, fileName?: string): TemplateFingerprint {
  const canonicalFieldIds = unique(
    template.fields.map((field) => field.canonicalFieldId).filter(Boolean)
  ) as CanonicalFieldId[];
  const anchorTerms = unique(
    template.fields
      .flatMap((field) => tokenize(`${field.label} ${field.anchorText ?? ""}`))
      .concat(deriveFileNameHints(fileName, template.name))
  ).slice(0, 48);

  const pageFingerprints = unique(template.fields.map((field) => field.pageNumber)).map((pageNumber) => {
    const pageFields = template.fields.filter((field) => field.pageNumber === pageNumber);
    return {
      pageNumber,
      width: Math.max(...pageFields.map((field) => Math.round(field.x + field.width)), 0),
      height: Math.max(...pageFields.map((field) => Math.round(field.y + field.height)), 0),
      anchorTerms: unique(pageFields.flatMap((field) => tokenize(`${field.label} ${field.anchorText ?? ""}`))).slice(
        0,
        24
      ),
      textDigest: hashString(
        pageFields
          .map((field) => `${field.label}:${Math.round(field.x)}:${Math.round(field.y)}:${Math.round(field.width)}`)
          .join("|")
      ),
    };
  });

  return {
    version: 1,
    pageCount: template.pageCount ?? pageFingerprints.length ?? 1,
    pageFingerprints,
    anchorTerms,
    checkboxTerms: unique(
      template.fields
        .filter((field) => field.fieldType === "checkbox")
        .flatMap((field) => tokenize(`${field.label} ${field.checkboxValue ?? ""}`))
    ),
    canonicalFieldIds,
    fileNameHints: deriveFileNameHints(fileName, template.name),
    fingerprintHash: hashString(
      JSON.stringify({
        template: template.name,
        version: template.version,
        anchorTerms,
        canonicalFieldIds,
        pages: pageFingerprints.map((page) => ({
          pageNumber: page.pageNumber,
          textDigest: page.textDigest,
        })),
      })
    ),
    embedding: template.fingerprint?.embedding,
    formType: template.fingerprint?.formType,
  };
}

function overlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((value) => rightSet.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

export function scoreFingerprintMatch(
  incoming: TemplateFingerprint,
  candidate: TemplateFingerprint
): { total: number; detail: { page: number; anchors: number; fileName: number; checkbox: number; semantic: number } } {
  const pageScore =
    incoming.pageCount === candidate.pageCount
      ? 1
      : Math.max(0, 1 - Math.abs(incoming.pageCount - candidate.pageCount) * 0.35);
  const anchorScore = overlapScore(incoming.anchorTerms, candidate.anchorTerms);
  const fileNameScore = overlapScore(incoming.fileNameHints, candidate.fileNameHints);
  const checkboxScore = overlapScore(incoming.checkboxTerms, candidate.checkboxTerms);

  let semanticScore = 0;
  if (incoming.embedding && candidate.embedding) {
    semanticScore = embeddingCosineSimilarity(incoming.embedding, candidate.embedding);
    semanticScore = Math.max(0, semanticScore);
  }

  const hasEmbeddings = !!(incoming.embedding && candidate.embedding);
  const total = hasEmbeddings
    ? pageScore * 0.20 + anchorScore * 0.28 + semanticScore * 0.38 + fileNameScore * 0.08 + checkboxScore * 0.06
    : pageScore * 0.34 + anchorScore * 0.46 + fileNameScore * 0.12 + checkboxScore * 0.08;

  return {
    total,
    detail: {
      page: pageScore,
      anchors: anchorScore,
      fileName: fileNameScore,
      checkbox: checkboxScore,
      semantic: semanticScore,
    },
  };
}

function embeddingCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
