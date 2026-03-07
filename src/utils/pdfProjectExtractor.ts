import * as pdfjsLib from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type { Project, CreditCardType } from "@/types";
import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";

if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

interface TextSpan {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ExtractedCandidate {
  projectKey: keyof Project;
  value: string;
  score: number;
}

function extractTextSpans(items: TextItem[], pageHeight: number): TextSpan[] {
  return items
    .filter((item) => !!item.str?.trim())
    .map((item) => {
      const fontSize = Math.sqrt(
        item.transform[0] ** 2 + item.transform[1] ** 2
      );
      return {
        text: item.str.trim(),
        x: item.transform[4],
        y: pageHeight - item.transform[5] - fontSize,
        width: item.width || fontSize * item.str.length * 0.6,
        height: fontSize,
      };
    });
}

function groupIntoLines(spans: TextSpan[]): TextSpan[][] {
  const sorted = [...spans].sort((a, b) => a.y - b.y || a.x - b.x);
  const buckets: TextSpan[][] = [];

  for (const span of sorted) {
    const bucket = buckets.find(
      (g) => Math.abs(g[0].y - span.y) <= Math.max(4, span.height * 0.4)
    );
    if (bucket) bucket.push(span);
    else buckets.push([span]);
  }

  return buckets.map((bucket) => [...bucket].sort((a, b) => a.x - b.x));
}

/* ------------------------------------------------------------------ */
/*  Alias index                                                        */
/* ------------------------------------------------------------------ */

type FieldAlias = {
  alias: string;
  aliasWords: string[];
  projectKey: keyof Project;
  checkboxValue?: string;
  fieldKind: string;
};

function buildAliasIndex(): FieldAlias[] {
  const aliases: FieldAlias[] = [];
  for (const def of CANONICAL_FIELD_DEFINITIONS) {
    if (!def.mappedProjectKey) continue;
    const all = [def.label, ...def.aliases];
    const seen = new Set<string>();
    for (const raw of all) {
      const lower = raw.toLowerCase().trim();
      if (seen.has(lower)) continue;
      seen.add(lower);
      aliases.push({
        alias: lower,
        aliasWords: lower.split(/\s+/),
        projectKey: def.mappedProjectKey as keyof Project,
        checkboxValue: def.checkboxValue,
        fieldKind: def.fieldKind,
      });
    }
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  return aliases;
}

const ALIAS_INDEX = buildAliasIndex();

/* ------------------------------------------------------------------ */
/*  Value cleaning                                                     */
/* ------------------------------------------------------------------ */

const JUNK_RE = /^[_\s.:;\-–—*]+$/;

function cleanSpanText(s: string): string {
  return s
    .replace(/_+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s:;\-–—.]+/, "")
    .replace(/[\s:;\-–—.]+$/, "")
    .trim();
}

function isJunk(text: string): boolean {
  if (!text || text.length === 0) return true;
  if (JUNK_RE.test(text)) return true;
  const alphaNum = (text.match(/[a-zA-Z0-9]/g) || []).length;
  return alphaNum < 1;
}

function isFillerSpan(raw: string): boolean {
  return /^[_\s.:;\-–—]+$/.test(raw);
}

/* ------------------------------------------------------------------ */
/*  Label matching on a line of spans                                  */
/* ------------------------------------------------------------------ */

interface LabelHit {
  projectKey: keyof Project;
  checkboxValue?: string;
  fieldKind: string;
  startSpanIdx: number;
  endSpanIdx: number; // exclusive
  labelEndX: number;
}

function normalizeLabelText(s: string): string {
  return normalizeWhitespace(
    s.toLowerCase().replace(/^[\s:;\-–—.,#]+|[\s:;\-–—.,#]+$/g, "")
  );
}

/**
 * Walk the spans and find all alias matches, longest-first.
 * A matched alias consumes its spans so shorter aliases cannot re-match them.
 */
function findLabelsInLine(spans: TextSpan[]): LabelHit[] {
  const hits: LabelHit[] = [];
  const consumedSpans = new Set<number>();

  for (const entry of ALIAS_INDEX) {
    if (entry.checkboxValue) continue;

    for (let si = 0; si < spans.length; si++) {
      if (consumedSpans.has(si)) continue;

      let matchedEnd = -1;
      for (let end = si; end < spans.length; end++) {
        if (consumedSpans.has(end) && end !== si) break;
        const combined = normalizeLabelText(
          spans.slice(si, end + 1).map((span) => span.text).join(" ")
        );
        if (!combined) continue;

        if (
          combined === entry.alias ||
          combined.startsWith(`${entry.alias}:`) ||
          combined.startsWith(`${entry.alias} :`) ||
          combined.startsWith(`${entry.alias}#`) ||
          combined.startsWith(`${entry.alias} #`) ||
          combined.startsWith(`${entry.alias}.`) ||
          combined.startsWith(`${entry.alias} `)
        ) {
          matchedEnd = end + 1;
          break;
        }

        if (combined.length > entry.alias.length + 12) {
          break;
        }
      }

      if (matchedEnd === -1) continue;

      const alreadyFound = hits.some((h) => h.projectKey === entry.projectKey);
      if (alreadyFound) continue;

      const lastSpan = spans[matchedEnd - 1];
      const labelEndX = lastSpan.x + lastSpan.width;

      for (let k = si; k < matchedEnd; k++) consumedSpans.add(k);

      hits.push({
        projectKey: entry.projectKey,
        fieldKind: entry.fieldKind,
        checkboxValue: entry.checkboxValue,
        startSpanIdx: si,
        endSpanIdx: matchedEnd,
        labelEndX,
      });
    }
  }

  hits.sort((a, b) => a.startSpanIdx - b.startSpanIdx);
  return hits;
}

/* ------------------------------------------------------------------ */
/*  Value extraction                                                   */
/* ------------------------------------------------------------------ */

/**
 * Collect value spans between labelEndX and nextLabelStartX.
 * Skips filler (underscores), stops at known labels.
 */
function extractValueBetween(
  spans: TextSpan[],
  startX: number,
  endX: number | null,
  consumedIndices: Set<number>
): string {
  const parts: string[] = [];

  for (let i = 0; i < spans.length; i++) {
    if (consumedIndices.has(i)) continue;
    const span = spans[i];
    if (span.x + span.width < startX - 2) continue;
    if (endX !== null && span.x >= endX - 2) break;
    if (isFillerSpan(span.text)) continue;

    const cleaned = cleanSpanText(span.text);
    if (cleaned && !isJunk(cleaned)) {
      parts.push(cleaned);
    }
  }

  return parts.join(" ").trim();
}

/* ------------------------------------------------------------------ */
/*  Card type detection                                                */
/* ------------------------------------------------------------------ */

const CARD_TYPE_PATTERNS: { pattern: RegExp; value: CreditCardType }[] = [
  { pattern: /\bvisa\b/i, value: "visa" },
  { pattern: /\bmastercard\b|\bmaster\s*card\b/i, value: "mastercard" },
  { pattern: /\bdiscover\b/i, value: "discover" },
  { pattern: /\bamex\b|\bamerican\s*express\b/i, value: "amex" },
];

const CHECK_SELECTION_RE = /(?:\([xX]\)|\[[xX]\]|☑|✓|✔|■|●|☒|✗|✘)/;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_RE =
  /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]*)?\d{3}[\s.-]*\d{4}/;
const DATE_RE =
  /\b(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}[/-]\d{2,4})\b/;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const CARD_NUMBER_RE =
  /\b(?:\*{4,}|\d{4,})(?:[\s-]?(?:\*{2,}|\d{2,})){2,}\b/;
const CCV_RE = /\b\d{3,4}\b/;
const BOILERPLATE_RE =
  /\b(authorize|authorization|terms|agreement|policy|conditions|payment authorization|whichever occurs first|please note|minimum rental|hours of operation)\b/i;
const LABELISH_VALUE_RE =
  /^(job date|acct\.?\s*code|print|date|signature|full name|description(?: of goods\/services)?)$/i;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function joinLineText(spans: TextSpan[]): string {
  return normalizeWhitespace(spans.map((span) => span.text).join(" "));
}

function parseCityStateZip(text: string): Partial<Project> {
  const cleaned = normalizeWhitespace(text.replace(/^[,.\s]+|[,.\s]+$/g, ""));
  const match = cleaned.match(/^(.+?),\s*([A-Z]{2})[,\s]+(\d{5}(?:-\d{4})?)$/i);
  if (!match) return {};
  return {
    billingCity: match[1].trim(),
    billingState: match[2].trim().toUpperCase(),
    billingZipCode: match[3].trim(),
  };
}

function looksLikeKnownLabelText(text: string): boolean {
  const normalized = normalizeLabelText(text);
  return ALIAS_INDEX.some((entry) => normalized === entry.alias);
}

function normalizeFieldValue(projectKey: keyof Project, value: string): string {
  const cleaned = normalizeWhitespace(value);
  switch (projectKey) {
    case "creditCardNumber": {
      const masked = cleaned.match(/[\d*\s-]{12,}/);
      return masked ? masked[0].replace(/[\s-]+/g, "") : cleaned;
    }
    case "expDate":
    case "authorizationDate":
      return cleaned
        .replace(/(?<=\d)\s+(?=\d)/g, "")
        .replace(/\s*([/-])\s*/g, "$1");
    case "billingZipCode": {
      const zip = cleaned.match(ZIP_RE);
      return zip ? zip[0] : cleaned;
    }
    default:
      return cleaned;
  }
}

function inferCardTypeFromNumber(cardNumber: string): CreditCardType | "" {
  const digits = cardNumber.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("34") || digits.startsWith("37")) return "amex";
  if (digits.startsWith("4")) return "visa";
  if (/^5[1-5]/.test(digits) || /^2(2[2-9]|[3-6]|7[01])/.test(digits)) {
    return "mastercard";
  }
  if (
    digits.startsWith("6011") ||
    digits.startsWith("65") ||
    /^64[4-9]/.test(digits)
  ) {
    return "discover";
  }
  return "";
}

function scorePage(lines: TextSpan[][]): number {
  const pageText = lines.map(joinLineText).join("\n").toLowerCase();
  let score = 0;
  if (pageText.includes("credit card one sheet")) score += 4;
  if (pageText.includes("credit card information")) score += 3;
  if (pageText.includes("card holder information")) score += 2;
  if (pageText.includes("job information")) score += 1;
  if (pageText.includes("driver")) score -= 2;
  if (pageText.includes("policy")) score -= 4;
  if (pageText.includes("hours of operation")) score -= 3;
  if (lines.length > 35) score -= 2;
  return score;
}

function scoreCandidateValue(
  projectKey: keyof Project,
  value: string,
  sameLine: boolean,
  pageScore: number
): number | null {
  const cleaned = normalizeFieldValue(projectKey, value);
  if (!cleaned || cleaned.length === 0) return null;
  if (BOILERPLATE_RE.test(cleaned)) return null;
  if (looksLikeKnownLabelText(cleaned)) return null;
  if (LABELISH_VALUE_RE.test(cleaned)) return null;

  let score = pageScore + (sameLine ? 2 : 1);

  switch (projectKey) {
    case "email":
      if (!EMAIL_RE.test(cleaned)) return null;
      score += 4;
      break;
    case "phone":
      if (!PHONE_RE.test(cleaned)) return null;
      score += 4;
      break;
    case "creditCardNumber":
      if (!CARD_NUMBER_RE.test(cleaned)) return null;
      score += 5;
      score += Math.min(2, cleaned.replace(/\D/g, "").length / 8);
      break;
    case "expDate":
    case "authorizationDate":
      if (!DATE_RE.test(cleaned)) return null;
      score += 4;
      break;
    case "ccv":
      if (!CCV_RE.test(cleaned)) return null;
      score += 4;
      break;
    case "billingZipCode":
      if (!ZIP_RE.test(cleaned)) return null;
      score += 4;
      break;
    case "billingAddress":
      if (cleaned.length < 6) return null;
      if (!/\d|[a-z]/i.test(cleaned)) return null;
      score += 2;
      break;
    case "creditCardHolder":
    case "productionCompany":
    case "jobName":
    case "label":
    case "producer":
      if (cleaned.length < 2 || cleaned.length > 80) return null;
      score += 2;
      break;
    case "cardholderSignature":
      if (cleaned.length < 2 || cleaned.length > 80) return null;
      if (
        /^(print|date|signature|authorized cardholders signature)$/i.test(
          cleaned
        )
      ) {
        return null;
      }
      score += 2;
      break;
    case "jobNumber":
    case "poNumber":
      if (cleaned.length < 2 || cleaned.length > 40) return null;
      score += 2;
      break;
    default:
      if (cleaned.length < 1) return null;
  }

  if (/[A-Za-z]/.test(cleaned) && !/\b(?:name|address|phone|email|date|signature)\b/i.test(cleaned)) {
    score += 0.5;
  }

  return score;
}

function upsertCandidate(
  bestCandidates: Map<keyof Project, ExtractedCandidate>,
  projectKey: keyof Project,
  value: string,
  score: number
) {
  const normalizedValue = normalizeFieldValue(projectKey, value);
  const existing = bestCandidates.get(projectKey);
  if (!existing || score > existing.score) {
    bestCandidates.set(projectKey, {
      projectKey,
      value: normalizedValue,
      score,
    });
  }
}

function getContextualCandidates(
  lines: TextSpan[][],
  lineIndex: number,
  pageScore: number
): ExtractedCandidate[] {
  const candidates: ExtractedCandidate[] = [];
  const currentLine = joinLineText(lines[lineIndex]);
  const previousLines = [
    lineIndex > 2 ? joinLineText(lines[lineIndex - 3]) : "",
    lineIndex > 1 ? joinLineText(lines[lineIndex - 2]) : "",
    lineIndex > 0 ? joinLineText(lines[lineIndex - 1]) : "",
  ].filter(Boolean);
  const nextLine = lineIndex + 1 < lines.length ? joinLineText(lines[lineIndex + 1]) : "";
  const localContext = `${previousLines.join("\n")}\n${currentLine}\n${nextLine}`.toLowerCase();

  const cardSection =
    /\b(credit card information|credit card one sheet|card holder information)\b/i.test(
      localContext
    );

  if (cardSection) {
    const nameMatch = currentLine.match(/^name\s*:\s*(.+)$/i);
    if (nameMatch) {
      candidates.push({
        projectKey: "creditCardHolder",
        value: nameMatch[1],
        score: pageScore + 6,
      });
    }

    const cardMatch = currentLine.match(/^(?:cc\s*#|cc#|credit card #|card #)\s*:?\s*(.+)$/i);
    if (cardMatch) {
      candidates.push({
        projectKey: "creditCardNumber",
        value: cardMatch[1],
        score: pageScore + 7,
      });
    }

    const codeMatch = currentLine.match(/^security code\s*:\s*(.+)$/i);
    if (codeMatch) {
      candidates.push({
        projectKey: "ccv",
        value: codeMatch[1],
        score: pageScore + 7,
      });
    }

    const expMatch = currentLine.match(/^(?:expiration|exp(?:iration)?(?: date)?)\s*:\s*(.+)$/i);
    if (expMatch) {
      candidates.push({
        projectKey: "expDate",
        value: expMatch[1],
        score: pageScore + 7,
      });
    }
  }

  return candidates;
}

/* ------------------------------------------------------------------ */
/*  Main extraction                                                    */
/* ------------------------------------------------------------------ */

export async function extractProjectFromPdf(
  pdfBytes: Uint8Array
): Promise<{ fields: Partial<Project>; fieldCount: number }> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const documentInit = {
    data: bytesCopy,
    disableWorker: typeof window === "undefined",
  } as Parameters<typeof pdfjsLib.getDocument>[0] & { disableWorker?: boolean };
  const doc = await pdfjsLib.getDocument(documentInit).promise;
  const result: Partial<Project> = {};
  const bestCandidates = new Map<keyof Project, ExtractedCandidate>();

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const allSpans = extractTextSpans(
      textContent.items as TextItem[],
      viewport.height
    );
    const lines = groupIntoLines(allSpans);
    const pageScore = scorePage(lines);

    for (let li = 0; li < lines.length; li++) {
      const spans = lines[li];
      const hits = findLabelsInLine(spans);
      const contextualCandidates = getContextualCandidates(lines, li, pageScore);

      const consumedIndices = new Set<number>();
      for (const h of hits) {
        for (let k = h.startSpanIdx; k < h.endSpanIdx; k++) {
          consumedIndices.add(k);
        }
      }

      for (const candidate of contextualCandidates) {
        const validatedScore = scoreCandidateValue(
          candidate.projectKey,
          candidate.value,
          true,
          pageScore
        );
        if (validatedScore !== null) {
          upsertCandidate(
            bestCandidates,
            candidate.projectKey,
            candidate.value,
            validatedScore + (candidate.score - pageScore)
          );
        }
      }

      for (let hi = 0; hi < hits.length; hi++) {
        const hit = hits[hi];

        const nextHit = hits[hi + 1];
        const boundaryX = nextHit ? spans[nextHit.startSpanIdx].x : null;

        let value = extractValueBetween(
          spans,
          hit.labelEndX,
          boundaryX,
          consumedIndices
        );

        // If no value on this line, try the next line (value might be below)
        if (!value && li + 1 < lines.length) {
          const nextLine = lines[li + 1];
          const thisLineY = Math.min(...spans.map((s) => s.y));
          const nextLineY = Math.min(...nextLine.map((s) => s.y));
          const yGap = nextLineY - thisLineY;

          if (yGap > 0 && yGap < 30) {
            const nextHits = findLabelsInLine(nextLine);
            if (nextHits.length === 0) {
              const nextConsumed = new Set<number>();
              const candidate = extractValueBetween(
                nextLine,
                0,
                null,
                nextConsumed
              );
              if (candidate) value = candidate;
            }
          }
        }

        const score = scoreCandidateValue(
          hit.projectKey,
          value,
          Boolean(value && extractValueBetween(
            spans,
            hit.labelEndX,
            boundaryX,
            consumedIndices
          )),
          pageScore
        );
        if (score !== null) {
          upsertCandidate(bestCandidates, hit.projectKey, value, score);

          if (hit.projectKey === "billingAddress" && li + 2 < lines.length) {
            const maybeCityStateZip = joinLineText(lines[li + 2]);
            const parsed = parseCityStateZip(maybeCityStateZip);
            if (parsed.billingCity) {
              upsertCandidate(bestCandidates, "billingCity", parsed.billingCity, score + 1);
            }
            if (parsed.billingState) {
              upsertCandidate(bestCandidates, "billingState", parsed.billingState, score + 1);
            }
            if (parsed.billingZipCode) {
              upsertCandidate(
                bestCandidates,
                "billingZipCode",
                parsed.billingZipCode,
                score + 1
              );
            }
          }
        }
      }

      // Card type via check glyphs on same line
      const lineText = spans.map((s) => s.text).join(" ");
      if (CHECK_SELECTION_RE.test(lineText)) {
        for (const { pattern, value } of CARD_TYPE_PATTERNS) {
          if (pattern.test(lineText)) {
            upsertCandidate(bestCandidates, "creditCardType", value, pageScore + 5);
            break;
          }
        }
      }
    }
  }

  for (const [projectKey, candidate] of bestCandidates.entries()) {
    (result as Record<string, string>)[projectKey] = candidate.value;
  }

  if (!result.creditCardType && result.creditCardNumber) {
    const inferred = inferCardTypeFromNumber(result.creditCardNumber);
    if (inferred) {
      result.creditCardType = inferred;
    }
  }

  // Imported PDFs often expose signature labels or illegible script text.
  // For project creation, mirror the imported cardholder name into signature.
  if (result.creditCardHolder) {
    result.cardholderSignature = result.creditCardHolder;
  }

  return { fields: result, fieldCount: Object.keys(result).length };
}
