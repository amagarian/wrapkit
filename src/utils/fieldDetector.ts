import * as pdfjsLib from "pdfjs-dist";
import type { OPS } from "pdfjs-dist";
import type {
  ConfidenceDetails,
  TemplateField,
  TemplateFieldKind,
  TemplateFieldSource,
} from "@/types";
import {
  CANONICAL_FIELD_DEFINITIONS,
  type CanonicalFieldDefinition,
} from "@/utils/fieldCatalog";

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface PositionedTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageNumber: number;
}

interface TextLine {
  id: string;
  text: string;
  normalized: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageNumber: number;
  items: PositionedTextItem[];
}

type GeometryKind = "underline" | "box" | "widget";

interface GeometryCandidate {
  id: string;
  kind: GeometryKind;
  x: number;
  y: number;
  width: number;
  height: number;
  pageNumber: number;
  source: TemplateFieldSource;
  consumed?: boolean;
}

interface DetectionContext {
  pageHeight: number;
  pageWidth: number;
  textItems: PositionedTextItem[];
  textLines: TextLine[];
  geometryCandidates: GeometryCandidate[];
}

interface InlineSpan {
  start: number;
  end: number;
  alias: string;
  score: number;
}

interface ScoredCandidate {
  field: TemplateField;
  confidenceDetails: ConfidenceDetails;
  geometryId?: string;
}

const UNDERSCORE_TEXT_REGEX = /_{2,}/g;
const CHECKBOX_GLYPH_REGEX = /[□☐☑]/;
const AMBIGUOUS_SINGLE_WORD_ALIASES = new Set(["date", "company", "address", "phone", "signature"]);
const SECTION_HINTS: Record<string, string[]> = {
  payment: ["credit card", "card type", "cardholder", "cvv", "security deposit", "billing"],
  authorization: ["authorize", "authorization", "charge", "approval", "future rentals"],
  signature: ["signature", "date", "authorized", "customer signature"],
  billing: ["billing", "address", "zip", "ap", "accounting"],
  job: ["job", "po", "project", "show"],
};

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function overlapsEnough(a: GeometryCandidate, b: GeometryCandidate): boolean {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return xOverlap > Math.min(a.width, b.width) * 0.6 && yOverlap > Math.min(a.height, b.height) * 0.6;
}

function dedupeGeometryCandidates(candidates: GeometryCandidate[]): GeometryCandidate[] {
  const deduped: GeometryCandidate[] = [];

  for (const candidate of candidates.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const duplicate = deduped.find(
      (existing) =>
        existing.kind === candidate.kind &&
        Math.abs(existing.x - candidate.x) <= 3 &&
        Math.abs(existing.y - candidate.y) <= 3 &&
        Math.abs(existing.width - candidate.width) <= 4 &&
        Math.abs(existing.height - candidate.height) <= 4
    );
    if (!duplicate) {
      deduped.push(candidate);
    }
  }

  return deduped;
}

function mergeTextLines(textItems: PositionedTextItem[]): TextLine[] {
  const sorted = [...textItems].sort((a, b) => a.y - b.y || a.x - b.x);
  const buckets: PositionedTextItem[][] = [];

  for (const item of sorted) {
    const bucket = buckets.find((group) => Math.abs(group[0].y - item.y) <= Math.max(4, item.height * 0.35));
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.push([item]);
    }
  }

  return buckets
    .map((bucket, index) => {
      const items = [...bucket].sort((a, b) => a.x - b.x);
      let text = "";
      let prevRight = items[0]?.x ?? 0;

      items.forEach((item, itemIndex) => {
        if (itemIndex > 0) {
          const gap = item.x - prevRight;
          if (gap > Math.max(2, item.height * 0.35)) {
            text += " ";
          }
        }
        text += item.text;
        prevRight = item.x + item.width;
      });

      const minX = Math.min(...items.map((item) => item.x));
      const maxRight = Math.max(...items.map((item) => item.x + item.width));
      const minY = Math.min(...items.map((item) => item.y));
      const maxBottom = Math.max(...items.map((item) => item.y + item.height));

      return {
        id: `line-${index + 1}`,
        text: text.trim(),
        normalized: normalizeText(text),
        x: minX,
        y: minY,
        width: maxRight - minX,
        height: maxBottom - minY,
        pageNumber: items[0]?.pageNumber ?? 1,
        items,
      };
    })
    .filter((line) => line.text.length > 0);
}

function createTextItemAnchors(textItems: PositionedTextItem[]): TextLine[] {
  return textItems
    .filter((item) => item.text.length > 0)
    .map((item, index) => ({
      id: `item-anchor-${index + 1}`,
      text: item.text,
      normalized: normalizeText(item.text),
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      pageNumber: item.pageNumber,
      items: [item],
    }));
}

function parseConstructPath(
  ops: number[],
  coords: number[],
  pageHeight: number,
  candidatePrefix: string,
  source: TemplateFieldSource
): GeometryCandidate[] {
  const candidates: GeometryCandidate[] = [];
  let coordIndex = 0;
  let currentPoint: [number, number] | null = null;
  const pdfOps = pdfjsLib.OPS as typeof OPS;

  const addUnderline = (x1: number, y1: number, x2: number, y2: number) => {
    const width = Math.abs(x2 - x1);
    if (width < 28 || width > 520) return;
    if (Math.abs(y1 - y2) > 1.75) return;
    const left = Math.min(x1, x2);
    const top = pageHeight - y1 - 1;
    candidates.push({
      id: `${candidatePrefix}-line-${candidates.length + 1}`,
      kind: "underline",
      x: left,
      y: top,
      width,
      height: 2,
      pageNumber: 1,
      source,
    });
  };

  const addRectangle = (x: number, y: number, width: number, height: number) => {
    const absWidth = Math.abs(width);
    const absHeight = Math.abs(height);
    const left = width >= 0 ? x : x + width;
    const top = pageHeight - (height >= 0 ? y + height : y);

    if (absWidth >= 8 && absWidth <= 20 && absHeight >= 8 && absHeight <= 20) {
      candidates.push({
        id: `${candidatePrefix}-box-${candidates.length + 1}`,
        kind: "box",
        x: left,
        y: top,
        width: absWidth,
        height: absHeight,
        pageNumber: 1,
        source,
      });
      return;
    }

    if (absWidth >= 28 && absWidth <= 520 && absHeight <= 3) {
      candidates.push({
        id: `${candidatePrefix}-rect-line-${candidates.length + 1}`,
        kind: "underline",
        x: left,
        y: top,
        width: absWidth,
        height: Math.max(absHeight, 2),
        pageNumber: 1,
        source,
      });
    }
  };

  for (const op of ops) {
    if (op === pdfOps.moveTo) {
      currentPoint = [coords[coordIndex], coords[coordIndex + 1]];
      coordIndex += 2;
      continue;
    }

    if (op === pdfOps.lineTo) {
      const nextPoint: [number, number] = [coords[coordIndex], coords[coordIndex + 1]];
      coordIndex += 2;
      if (currentPoint) {
        addUnderline(currentPoint[0], currentPoint[1], nextPoint[0], nextPoint[1]);
      }
      currentPoint = nextPoint;
      continue;
    }

    if (op === pdfOps.rectangle) {
      addRectangle(coords[coordIndex], coords[coordIndex + 1], coords[coordIndex + 2], coords[coordIndex + 3]);
      coordIndex += 4;
      continue;
    }

    if (op === pdfOps.curveTo) {
      coordIndex += 6;
      currentPoint = [coords[coordIndex - 2], coords[coordIndex - 1]];
      continue;
    }

    if (op === pdfOps.curveTo2 || op === pdfOps.curveTo3) {
      coordIndex += 4;
      currentPoint = [coords[coordIndex - 2], coords[coordIndex - 1]];
    }
  }

  return candidates;
}

async function buildDetectionContext(
  pdfBytes: Uint8Array,
  pageNumber: number
): Promise<DetectionContext> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const pageHeight = viewport.height;
  const pageWidth = viewport.width;

  const textContent = await page.getTextContent();
  const textItems = (textContent.items as TextItem[])
    .filter((item) => !!item.str)
    .map((item) => {
      const fontSize = Math.sqrt(item.transform[0] ** 2 + item.transform[1] ** 2);
      return {
        text: item.str.trim(),
        x: item.transform[4],
        y: pageHeight - item.transform[5] - fontSize,
        width: item.width || fontSize * item.str.length * 0.6,
        height: fontSize,
        pageNumber,
      };
    })
    .filter((item) => item.text.length > 0);

  const textLines = mergeTextLines(textItems.filter((item) => item.text.length > 0));
  const geometryCandidates: GeometryCandidate[] = [];

  for (const line of textLines) {
    const matches = [...line.text.matchAll(UNDERSCORE_TEXT_REGEX)];
    if (matches.length === 0) continue;
    const charWidth = line.width / Math.max(line.text.length, 1);
    for (const match of matches) {
      if (match.index === undefined) continue;
      const width = Math.max(28, match[0].length * charWidth);
      geometryCandidates.push({
        id: `inline-underscore-${geometryCandidates.length + 1}`,
        kind: "underline",
        x: line.x + match.index * charWidth,
        y: line.y,
        width,
        height: Math.max(2, line.height * 0.14),
        pageNumber,
        source: "text-inline",
      });
    }
  }

  const annotations = await page.getAnnotations();
  annotations.forEach((annotation, index) => {
    if (!annotation.rect || annotation.rect.length !== 4) return;
    const [x1, y1, x2, y2] = annotation.rect;
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    geometryCandidates.push({
      id: `acroform-${index + 1}`,
      kind: width <= 20 && height <= 20 ? "box" : "widget",
      x: Math.min(x1, x2),
      y: pageHeight - Math.max(y1, y2),
      width,
      height,
      pageNumber,
      source: "acroform",
    });
  });

  const operatorList = await page.getOperatorList();
  operatorList.fnArray.forEach((fn, index) => {
    if (fn !== pdfjsLib.OPS.constructPath) return;
    const [ops, coords] = operatorList.argsArray[index] as [number[], number[], number[]?];
    geometryCandidates.push(
      ...parseConstructPath(ops, coords, pageHeight, `path-${index + 1}`, "geometry-line")
    );
  });

  const glyphBoxes = textItems
    .filter((item) => CHECKBOX_GLYPH_REGEX.test(item.text))
    .map<GeometryCandidate>((item, index) => ({
      id: `glyph-${index + 1}`,
      kind: "box",
      x: item.x,
      y: item.y,
      width: Math.min(14, Math.max(10, item.width)),
      height: Math.min(18, Math.max(10, item.height)),
      pageNumber,
      source: "glyph-checkbox",
    }));
  geometryCandidates.push(...glyphBoxes);

  return {
    pageHeight,
    pageWidth,
    textItems,
    textLines,
    geometryCandidates: dedupeGeometryCandidates(geometryCandidates).filter(
      (candidate) =>
        candidate.x >= 0 &&
        candidate.y >= 0 &&
        candidate.width > 0 &&
        candidate.height > 0 &&
        candidate.width < pageWidth * 0.98
    ),
  };
}

function inferSectionId(line: TextLine, lines: TextLine[]): string | undefined {
  const nearbyText = lines
    .filter((candidate) => candidate.y <= line.y && line.y - candidate.y <= 120)
    .map((candidate) => candidate.normalized)
    .join(" ");

  let bestSection: string | undefined;
  let bestScore = 0;

  for (const [sectionId, keywords] of Object.entries(SECTION_HINTS)) {
    const score = keywords.reduce((total, keyword) => total + (nearbyText.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestSection = sectionId;
    }
  }

  return bestSection;
}

function findAliasSpan(text: string, aliases: string[]): InlineSpan | null {
  const lower = text.toLowerCase();
  let best: InlineSpan | null = null;

  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase();
    const singleWord = aliasLower.split(" ").length === 1;
    let start = singleWord ? (lower.trim().startsWith(aliasLower) ? lower.indexOf(aliasLower) : -1) : lower.indexOf(aliasLower);
    let end = start >= 0 ? start + aliasLower.length : -1;

    if (start < 0 && singleWord && !AMBIGUOUS_SINGLE_WORD_ALIASES.has(aliasLower)) {
      const wordMatch = lower.match(new RegExp(`(^|[^a-z0-9])(${escapeRegExp(aliasLower)})(?=$|[^a-z0-9])`));
      if (wordMatch && wordMatch.index !== undefined) {
        const aliasIndex = wordMatch.index + wordMatch[1].length;
        start = aliasIndex;
        end = aliasIndex + aliasLower.length;
      }
    }

    if (start < 0 && !singleWord) {
      const tokenPattern = aliasLower
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => escapeRegExp(token))
        .join("[^a-z0-9]*");
      const match = lower.match(new RegExp(tokenPattern));
      if (match && match.index !== undefined) {
        start = match.index;
        end = start + match[0].length;
      }
    }

    if (start < 0) continue;
    const score =
      lower.trim() === aliasLower
        ? 1
        : lower.trim().startsWith(aliasLower)
          ? 0.97
          : lower.includes(aliasLower)
            ? 0.92
            : 0.9;
    const candidate = { start, end: end >= 0 ? end : start + aliasLower.length, alias, score };
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
}

function inferFieldTypeFromKind(fieldKind: TemplateFieldKind): "text" | "checkbox" {
  return fieldKind === "checkbox-group" || fieldKind === "boolean-checkbox" ? "checkbox" : "text";
}

function buildTemplateField(
  definition: CanonicalFieldDefinition,
  bbox: { x: number; y: number; width: number; height: number; pageNumber: number },
  details: {
    confidence: ConfidenceDetails;
    detectionSource: TemplateFieldSource;
    sectionId?: string;
    anchorText?: string;
  },
  idSuffix: string
): TemplateField {
  return {
    id: `${definition.id}-${idSuffix}`,
    label: definition.label,
    mappedProjectKey: definition.mappedProjectKey,
    canonicalFieldId: definition.id,
    pageNumber: bbox.pageNumber,
    x: Math.round(bbox.x),
    y: Math.round(bbox.y),
    width: Math.round(bbox.width),
    height: Math.round(bbox.height),
    confidence: clamp(details.confidence.total),
    fieldType: inferFieldTypeFromKind(definition.fieldKind),
    fieldKind: definition.fieldKind,
    detectionSource: details.detectionSource,
    sectionId: details.sectionId,
    groupId: definition.groupId,
    anchorText: details.anchorText,
    confidenceDetails: details.confidence,
    checkboxValue: definition.checkboxValue,
  };
}

function getSpanBounds(line: TextLine, span: InlineSpan | null): { startX: number; endX: number; centerX: number } {
  if (!span) {
    const startX = line.x;
    const endX = line.x + Math.min(line.width, 140);
    return {
      startX,
      endX,
      centerX: startX + (endX - startX) / 2,
    };
  }

  const textLength = Math.max(line.text.length, 1);
  const startX = line.x + (span.start / textLength) * line.width;
  const endX = line.x + (span.end / textLength) * line.width;
  return {
    startX,
    endX,
    centerX: startX + (endX - startX) / 2,
  };
}

function scoreUnderlineCandidate(
  definition: CanonicalFieldDefinition,
  line: TextLine,
  candidate: GeometryCandidate,
  aliasSpan: InlineSpan | null,
  sectionId?: string
): ConfidenceDetails {
  let labelScore = aliasSpan?.score ?? 0;
  let geometryScore = 0;
  let sectionScore = 0;
  const { startX: labelStartX, endX: labelEndX, centerX: labelCenterX } = getSpanBounds(line, aliasSpan);
  const sameRow = Math.abs(candidate.y - line.y) <= Math.max(14, line.height * 1.3);
  const belowLabel = candidate.y > line.y && candidate.y - line.y <= 38;
  const aboveLabel = candidate.y < line.y && line.y - candidate.y <= 24;
  const candidateEndX = candidate.x + candidate.width;
  const gapAfterLabel = candidate.x - labelEndX;
  const coversLabelCenter = candidate.x - 16 <= labelCenterX && candidateEndX + 16 >= labelCenterX;
  const trailingField =
    gapAfterLabel >= -18 &&
    gapAfterLabel <= Math.max(240, Math.min(line.width * 0.9, 320));
  const normalizedGap = Math.min(Math.max(gapAfterLabel, 0), 180) / 180;

  if (sameRow && trailingField) {
    geometryScore = 0.56 - normalizedGap * 0.08;
  } else if (belowLabel && trailingField) {
    geometryScore = 0.54 - normalizedGap * 0.08;
  } else if (aboveLabel && coversLabelCenter) {
    geometryScore = 0.42;
  } else if ((sameRow || belowLabel) && coversLabelCenter) {
    geometryScore = 0.4;
  }

  if (candidate.x < labelStartX - 20) {
    geometryScore -= 0.08;
  }
  if (gapAfterLabel > 320) {
    geometryScore -= 0.1;
  }
  if (candidate.width > 420 && definition.fieldKind !== "signature") {
    geometryScore -= definition.multiline ? 0.08 : 0.16;
  } else if (candidate.width > 320 && definition.fieldKind === "date") {
    geometryScore -= 0.12;
  }

  if (definition.fieldKind === "date" && candidate.width >= 45 && candidate.width <= 180) {
    geometryScore += 0.08;
  }
  if (definition.fieldKind === "signature" && candidate.width >= 110) {
    geometryScore += 0.08;
  }
  if (definition.multiline && candidate.width >= 100) {
    geometryScore += 0.05;
  }
  if (sectionId && definition.sectionHints.includes(sectionId)) {
    sectionScore = 0.1;
  }

  const total = clamp(labelScore * 0.45 + geometryScore + sectionScore);
  return {
    total,
    label: labelScore,
    geometry: geometryScore,
    section: sectionScore,
    reason: sameRow
      ? "matched label to same-row geometry"
      : belowLabel
        ? "matched label to trailing geometry below"
        : aboveLabel
          ? "matched label to centered geometry above"
          : "weak geometry match",
  };
}

function createInlineUnderscoreField(
  definition: CanonicalFieldDefinition,
  line: TextLine,
  aliasSpan: InlineSpan,
  pageNumber: number,
  idSuffix: string,
  sectionId?: string
): TemplateField | null {
  const afterAlias = line.text.slice(aliasSpan.end);
  const underscoreMatch = afterAlias.match(/_{2,}/);
  if (!underscoreMatch || underscoreMatch.index === undefined) return null;

  const start = aliasSpan.end + underscoreMatch.index;
  const charWidth = line.width / Math.max(line.text.length, 1);
  const bbox = {
    x: line.x + start * charWidth,
    y: line.y,
    width: Math.max(40, underscoreMatch[0].length * charWidth),
    height: Math.max(14, line.height + 2),
    pageNumber,
  };

  return buildTemplateField(
    definition,
    bbox,
    {
      confidence: {
        total: 0.92,
        label: aliasSpan.score,
        geometry: 0.5,
        source: 0.1,
        reason: "matched inline underscore span in reconstructed text line",
      },
      detectionSource: "text-inline",
      sectionId,
      anchorText: line.text,
    },
    idSuffix
  );
}

function createUnderlineFieldBox(
  candidate: GeometryCandidate,
  definition: CanonicalFieldDefinition
): { x: number; y: number; width: number; height: number; pageNumber: number } {
  const baselinePadding = definition.multiline ? 10 : 12;
  const height = Math.max(14, candidate.height + baselinePadding);

  return {
    x: candidate.x,
    y: Math.max(0, candidate.y - baselinePadding),
    width: candidate.width,
    height,
    pageNumber: candidate.pageNumber,
  };
}

function expandMultilineBoundingBox(
  definition: CanonicalFieldDefinition,
  anchor: GeometryCandidate,
  geometryCandidates: GeometryCandidate[]
): GeometryCandidate {
  if (!definition.multiline) return anchor;

  const stacked = geometryCandidates
    .filter(
      (candidate) =>
        candidate.kind === "underline" &&
        candidate.id !== anchor.id &&
        Math.abs(candidate.x - anchor.x) <= 50 &&
        candidate.y > anchor.y &&
        candidate.y - anchor.y <= 50 &&
        Math.abs(candidate.width - anchor.width) <= 120
    )
    .sort((a, b) => a.y - b.y);

  if (stacked.length === 0) return anchor;

  const bottom = stacked[stacked.length - 1];
  return {
    ...anchor,
    width: Math.max(anchor.width, ...stacked.map((candidate) => candidate.width)),
    height: bottom.y + bottom.height - anchor.y,
  };
}

function dedupeScoredCandidates(matches: ScoredCandidate[]): ScoredCandidate[] {
  const deduped: ScoredCandidate[] = [];

  for (const match of [...matches].sort((a, b) => b.confidenceDetails.total - a.confidenceDetails.total)) {
    const duplicate = deduped.find((existing) => {
      if (existing.geometryId && match.geometryId) {
        return existing.geometryId === match.geometryId;
      }

      return (
        existing.field.pageNumber === match.field.pageNumber &&
        Math.abs(existing.field.x - match.field.x) <= 8 &&
        Math.abs(existing.field.y - match.field.y) <= 8 &&
        Math.abs(existing.field.width - match.field.width) <= 12 &&
        Math.abs(existing.field.height - match.field.height) <= 12
      );
    });

    if (!duplicate) {
      deduped.push(match);
    }
  }

  return deduped;
}

function detectSemanticFields(context: DetectionContext): TemplateField[] {
  const rankedMatches: Array<ScoredCandidate & { definitionId: string; allowDuplicates: boolean }> = [];
  const chosen: Array<ScoredCandidate & { definitionId: string; allowDuplicates: boolean }> = [];
  const usedGeometryIds = new Set<string>();
  const usedDefinitionIds = new Set<string>();
  let idCounter = 1;
  const anchorLines = [...context.textLines, ...createTextItemAnchors(context.textItems)];

  for (const definition of CANONICAL_FIELD_DEFINITIONS.filter(
    (field) => field.fieldKind !== "checkbox-group" && field.fieldKind !== "boolean-checkbox"
  )) {
    const matches: ScoredCandidate[] = [];

    for (const line of anchorLines) {
      const aliasSpan = findAliasSpan(line.text, definition.aliases);
      if (!aliasSpan) continue;

      const sectionId = inferSectionId(line, context.textLines);
      const inlineField = createInlineUnderscoreField(definition, line, aliasSpan, line.pageNumber, `${idCounter}`, sectionId);
      if (inlineField) {
        matches.push({
          field: inlineField,
          confidenceDetails: inlineField.confidenceDetails ?? { total: inlineField.confidence },
        });
        idCounter += 1;
        continue;
      }

      const geometryCandidates = context.geometryCandidates.filter(
        (candidate) =>
          candidate.kind === "underline" &&
          !candidate.consumed &&
          candidate.pageNumber === line.pageNumber &&
          candidate.width >= 28
      );

      const scored = geometryCandidates
        .map((candidate) => {
          const expanded = expandMultilineBoundingBox(definition, candidate, geometryCandidates);
          const confidence = scoreUnderlineCandidate(definition, line, expanded, aliasSpan, sectionId);
          return {
            candidate: expanded,
            confidence,
          };
        })
        .filter(({ confidence }) => confidence.total >= 0.58)
        .sort((a, b) => b.confidence.total - a.confidence.total);

      const best = scored[0];
      if (!best) continue;

      matches.push({
        field: buildTemplateField(
          definition,
          createUnderlineFieldBox(best.candidate, definition),
          {
            confidence: best.confidence,
            detectionSource: best.candidate.source,
            sectionId,
            anchorText: line.text,
          },
          `${idCounter}`
        ),
        confidenceDetails: best.confidence,
        geometryId: best.candidate.id,
      });
      idCounter += 1;
    }

    rankedMatches.push(
      ...dedupeScoredCandidates(matches).map((match) => ({
        ...match,
        definitionId: definition.id,
        allowDuplicates: Boolean(definition.allowDuplicates),
      }))
    );
  }

  rankedMatches.sort((a, b) => b.confidenceDetails.total - a.confidenceDetails.total);

  for (const candidate of rankedMatches) {
    if (candidate.geometryId && usedGeometryIds.has(candidate.geometryId)) {
      continue;
    }
    if (!candidate.allowDuplicates && usedDefinitionIds.has(candidate.definitionId)) {
      continue;
    }

    const overlapsExisting = chosen.some(
      (existing) =>
        existing.definitionId === candidate.definitionId &&
        existing.field.pageNumber === candidate.field.pageNumber &&
        Math.abs(existing.field.y - candidate.field.y) < 30 &&
        Math.abs(existing.field.x - candidate.field.x) < 50
    );
    if (overlapsExisting) {
      continue;
    }

    chosen.push(candidate);
    if (candidate.geometryId) {
      usedGeometryIds.add(candidate.geometryId);
    }
    if (!candidate.allowDuplicates) {
      usedDefinitionIds.add(candidate.definitionId);
    }
  }

  for (const kept of chosen) {
    if (kept.geometryId) {
      const geometry = context.geometryCandidates.find((candidate) => candidate.id === kept.geometryId);
      if (geometry) geometry.consumed = true;
    }
  }

  return chosen.map((result) => result.field);
}

function findNearbyCheckboxLabel(
  context: DetectionContext,
  geometry: GeometryCandidate
): { text: string; definition: CanonicalFieldDefinition; sectionId?: string; confidence: number } | null {
  const checkboxDefinitions = CANONICAL_FIELD_DEFINITIONS.filter(
    (field) => field.fieldKind === "checkbox-group" || field.fieldKind === "boolean-checkbox"
  );
  const directRightLabel = context.textItems
    .filter(
      (item) =>
        item.pageNumber === geometry.pageNumber &&
        Math.abs(item.y - geometry.y) <= 12 &&
        item.x >= geometry.x + geometry.width - 4 &&
        item.x - (geometry.x + geometry.width) <= 56
    )
    .sort((a, b) => a.x - b.x)[0];

  if (directRightLabel) {
    const normalized = normalizeText(directRightLabel.text);
    const directDefinition = checkboxDefinitions.find((field) =>
      field.aliases.some((alias) => normalized === normalizeText(alias))
    );

    if (directDefinition) {
      return {
        text: directRightLabel.text,
        definition: directDefinition,
        sectionId: directDefinition.sectionHints[0],
        confidence: 1,
      };
    }
  }

  const anchorPasses: Array<{
    lines: TextLine[];
    definitions: CanonicalFieldDefinition[];
  }> = [
    {
      lines: createTextItemAnchors(context.textItems),
      definitions: checkboxDefinitions.filter((field) => field.fieldKind === "checkbox-group"),
    },
    {
      lines: [...createTextItemAnchors(context.textItems), ...context.textLines],
      definitions: checkboxDefinitions,
    },
  ];
  let best:
    | { text: string; definition: CanonicalFieldDefinition; sectionId?: string; confidence: number }
    | null = null;

  for (const pass of anchorPasses) {
    for (const line of pass.lines) {
      if (line.pageNumber !== geometry.pageNumber) continue;
      if (Math.abs(line.y - geometry.y) > 24) continue;

      for (const definition of pass.definitions) {
        const aliasSpan = findAliasSpan(line.text, definition.aliases);
        if (!aliasSpan) continue;

        const { startX: aliasStartX, endX: aliasEndX } = getSpanBounds(line, aliasSpan);
        const boxRightX = geometry.x + geometry.width;
        const gapBeforeLabel = aliasStartX - boxRightX;
        const gapAfterLabel = geometry.x - aliasEndX;
        const lineGap = line.x - boxRightX;
        let geometryScore = 0;

        if (gapBeforeLabel >= -12 && gapBeforeLabel <= 48) {
          geometryScore = 0.64;
        } else if (gapAfterLabel >= -12 && gapAfterLabel <= 32) {
          geometryScore = 0.56;
        } else if (line.width >= 140 && lineGap >= -12 && lineGap <= 32) {
          geometryScore = 0.46;
        }

        if (geometryScore === 0) continue;

        const verticalScore = Math.max(0, 0.2 - Math.abs(line.y - geometry.y) * 0.01);
        const confidence = clamp(aliasSpan.score * 0.45 + geometryScore + verticalScore);
        if (!best || confidence > best.confidence) {
          best = {
            text: line.text,
            definition,
            sectionId: inferSectionId(line, context.textLines) ?? definition.sectionHints[0],
            confidence,
          };
        }
      }
    }

    const confidentBest = best;
    if (confidentBest && confidentBest.confidence >= 0.9) {
      return confidentBest;
    }
  }

  return best;
}

function detectCheckboxFields(context: DetectionContext): TemplateField[] {
  const results: TemplateField[] = [];
  const checkboxCandidates = context.geometryCandidates.filter((candidate) => candidate.kind === "box");
  const usedCheckboxValues = new Set<string>();
  let idCounter = 1;

  for (const candidate of checkboxCandidates) {
    if (candidate.consumed) continue;
    const nearby = findNearbyCheckboxLabel(context, candidate);
    if (!nearby?.definition) continue;
    if (
      nearby.definition.checkboxValue &&
      usedCheckboxValues.has(`${nearby.definition.id}:${candidate.pageNumber}:${nearby.definition.checkboxValue}`)
    ) {
      continue;
    }

    const field = buildTemplateField(
      nearby.definition,
      {
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        pageNumber: candidate.pageNumber,
      },
      {
        confidence: {
          total: candidate.source === "glyph-checkbox" ? Math.max(0.9, nearby.confidence) : nearby.confidence,
          label: 0.9,
          geometry: 0.56,
          source: candidate.source === "glyph-checkbox" ? 0.1 : 0.05,
          section: nearby.sectionId ? 0.1 : undefined,
          reason: "matched checkbox glyph/box to nearest label",
        },
        detectionSource: candidate.source,
        sectionId: nearby.sectionId,
        anchorText: nearby.text,
      },
      `${idCounter}`
    );
    results.push(field);
    candidate.consumed = true;
    if (nearby.definition.checkboxValue) {
      usedCheckboxValues.add(`${nearby.definition.id}:${candidate.pageNumber}:${nearby.definition.checkboxValue}`);
    }
    idCounter += 1;
  }

  return results;
}

function detectExplicitGlyphCheckboxFields(context: DetectionContext): TemplateField[] {
  const checkboxDefinitions = CANONICAL_FIELD_DEFINITIONS.filter((field) => field.fieldKind === "checkbox-group");
  const results: TemplateField[] = [];
  const usedIds = new Set<string>();
  let idCounter = 1;
  const glyphItems = context.textItems.filter((item) => CHECKBOX_GLYPH_REGEX.test(item.text));

  for (const glyph of glyphItems) {
    const rightCandidates = context.textItems
      .filter(
        (item) =>
          item.pageNumber === glyph.pageNumber &&
          !CHECKBOX_GLYPH_REGEX.test(item.text) &&
          Math.abs(item.y - glyph.y) <= 12 &&
          item.x >= glyph.x + glyph.width - 4 &&
          item.x - (glyph.x + glyph.width) <= 56
      )
      .sort((a, b) => a.x - b.x);
    const rightLabel = rightCandidates[0];

    if (!rightLabel) continue;

    const normalizedLabel = normalizeText(rightLabel.text);
    const matchedDefinition = checkboxDefinitions.find((field) =>
      field.aliases.some((alias) => normalizedLabel === normalizeText(alias))
    );

    if (!matchedDefinition || usedIds.has(matchedDefinition.id)) continue;

    results.push(
      buildTemplateField(
        matchedDefinition,
        {
          x: glyph.x,
          y: glyph.y,
          width: Math.min(14, Math.max(10, glyph.width)),
          height: Math.min(18, Math.max(10, glyph.height)),
          pageNumber: glyph.pageNumber,
        },
        {
          confidence: {
            total: 0.99,
            label: 1,
            geometry: 0.56,
            source: 0.1,
            reason: "matched checkbox glyph to exact right-side label",
          },
          detectionSource: "glyph-checkbox",
          sectionId: matchedDefinition.sectionHints[0],
          anchorText: rightLabel.text,
        },
        `explicit-glyph-${idCounter}`
      )
    );
    usedIds.add(matchedDefinition.id);
    idCounter += 1;
  }

  return results;
}

function detectMissingCheckboxFields(
  context: DetectionContext,
  detectedFields: TemplateField[]
): TemplateField[] {
  const detectedIds = new Set(detectedFields.map((field) => field.canonicalFieldId).filter(Boolean));
  const recovered: TemplateField[] = [];
  let recoveryCounter = 1;

  const checkboxDefinitions = CANONICAL_FIELD_DEFINITIONS.filter(
    (field) => field.fieldKind === "checkbox-group" || field.fieldKind === "boolean-checkbox"
  );
  const glyphCandidates = context.textItems.filter((item) => CHECKBOX_GLYPH_REGEX.test(item.text));

  for (const glyph of glyphCandidates) {
    const rightLabel = context.textItems
      .filter(
        (item) =>
          item.pageNumber === glyph.pageNumber &&
          Math.abs(item.y - glyph.y) <= 12 &&
          item.x >= glyph.x + glyph.width - 4 &&
          item.x - (glyph.x + glyph.width) <= 56
      )
      .sort((a, b) => a.x - b.x)[0];

    if (!rightLabel) continue;

    const normalizedLabel = normalizeText(rightLabel.text);
    const matchedDefinition = checkboxDefinitions.find((field) =>
      field.aliases.some((alias) => normalizedLabel === normalizeText(alias))
    );

    if (!matchedDefinition || detectedIds.has(matchedDefinition.id)) continue;

    recovered.push(
      buildTemplateField(
        matchedDefinition,
        {
          x: glyph.x,
          y: glyph.y,
          width: Math.min(14, Math.max(10, glyph.width)),
          height: Math.min(18, Math.max(10, glyph.height)),
          pageNumber: glyph.pageNumber,
        },
        {
          confidence: {
            total: 0.98,
            label: 1,
            geometry: 0.56,
            source: 0.1,
            reason: "recovered checkbox from glyph and exact right-side label",
          },
          detectionSource: "glyph-checkbox",
          sectionId: matchedDefinition.sectionHints[0],
          anchorText: rightLabel.text,
        },
        `checkbox-recovered-${recoveryCounter}`
      )
    );
    detectedIds.add(matchedDefinition.id);
    recoveryCounter += 1;
  }

  const boxCandidates = context.geometryCandidates.filter((geometry) => geometry.kind === "box");

  for (const candidate of boxCandidates) {
    const nearby = findNearbyCheckboxLabel(context, candidate);
    if (!nearby) continue;
    if (detectedIds.has(nearby.definition.id)) continue;

    recovered.push(
      buildTemplateField(
        nearby.definition,
        {
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height,
          pageNumber: candidate.pageNumber,
        },
        {
          confidence: {
            total: 0.92,
            label: 0.9,
            geometry: 0.56,
            source: candidate.source === "glyph-checkbox" ? 0.1 : 0.05,
            reason: "recovered missing checkbox from box and adjacent label",
          },
          detectionSource: candidate.source,
          sectionId: nearby.sectionId,
          anchorText: nearby.text,
        },
        `checkbox-recovered-${recoveryCounter}`
      )
    );
    detectedIds.add(nearby.definition.id);
    recoveryCounter += 1;
  }

  return recovered;
}

function detectSyntheticTrailingFields(
  context: DetectionContext,
  detectedFields: TemplateField[]
): TemplateField[] {
  const detectedIds = new Set(detectedFields.map((field) => field.canonicalFieldId).filter(Boolean));
  const synthetic: TemplateField[] = [];
  let idCounter = 1;

  const targetDefinitions = CANONICAL_FIELD_DEFINITIONS.filter(
    (field) => field.id === "ccv" && !detectedIds.has(field.id)
  );

  for (const definition of targetDefinitions) {
    for (const line of context.textLines) {
      const aliasSpan = findAliasSpan(line.text, definition.aliases);
      if (!aliasSpan) continue;

      const { endX: labelEndX } = getSpanBounds(line, aliasSpan);
      const rowBoundary = context.geometryCandidates
        .filter(
          (candidate) =>
            candidate.pageNumber === line.pageNumber &&
            candidate.kind === "widget" &&
            candidate.y <= line.y &&
            line.y <= candidate.y + candidate.height + 6
        )
        .sort((a, b) => b.width - a.width)[0];

      const maxWidth = 64;
      const x = labelEndX + 6;
      const width = Math.min(maxWidth, Math.max(36, (rowBoundary?.x ?? context.pageWidth - 24) - x - 8));
      if (width < 30) continue;

      synthetic.push(
        buildTemplateField(
          definition,
          {
            x,
            y: Math.max(0, line.y - 2),
            width,
            height: Math.max(14, line.height + 2),
            pageNumber: line.pageNumber,
          },
          {
            confidence: {
              total: 0.7,
              label: aliasSpan.score,
              geometry: 0.24,
              source: 0.02,
              reason: "synthesized short trailing field from inline label with no isolated underline",
            },
            detectionSource: "text-line",
            sectionId: inferSectionId(line, context.textLines),
            anchorText: line.text,
          },
          `synthetic-${idCounter}`
        )
      );
      idCounter += 1;
      break;
    }
  }

  return synthetic;
}

function detectMissingSemanticFields(
  context: DetectionContext,
  detectedFields: TemplateField[]
): TemplateField[] {
  const detectedIds = new Set(detectedFields.map((field) => field.canonicalFieldId).filter(Boolean));
  const recovered: TemplateField[] = [];
  let recoveryCounter = 1;

  for (const definition of CANONICAL_FIELD_DEFINITIONS.filter(
    (field) =>
      field.fieldKind !== "checkbox-group" &&
      field.fieldKind !== "boolean-checkbox" &&
      !detectedIds.has(field.id)
  )) {
    let best:
      | {
          line: TextLine;
          candidate: GeometryCandidate;
          confidence: ConfidenceDetails;
          sectionId?: string;
        }
      | null = null;

    for (const line of context.textLines) {
      const aliasSpan = findAliasSpan(line.text, definition.aliases);
      if (!aliasSpan) continue;

      const sectionId = inferSectionId(line, context.textLines);
      const { endX: labelEndX } = getSpanBounds(line, aliasSpan);
      const candidates = context.geometryCandidates
        .filter(
          (candidate) =>
            candidate.kind === "underline" &&
            !candidate.consumed &&
            candidate.pageNumber === line.pageNumber &&
            candidate.width >= 28 &&
            candidate.x >= labelEndX - 12 &&
            candidate.x - labelEndX <= 240 &&
            candidate.y >= line.y - 6 &&
            candidate.y - line.y <= 28
        )
        .sort(
          (a, b) =>
            Math.abs(a.y - line.y) - Math.abs(b.y - line.y) ||
            Math.abs(a.x - labelEndX) - Math.abs(b.x - labelEndX)
        );

      const candidate = candidates[0];
      if (!candidate) continue;

      const confidence = scoreUnderlineCandidate(definition, line, candidate, aliasSpan, sectionId);
      if (confidence.total < 0.48) continue;

      if (!best || confidence.total > best.confidence.total) {
        best = {
          line,
          candidate,
          confidence,
          sectionId,
        };
      }
    }

    if (!best) continue;

    best.candidate.consumed = true;
    recovered.push(
      buildTemplateField(
        definition,
        createUnderlineFieldBox(best.candidate, definition),
        {
          confidence: {
            ...best.confidence,
            total: Math.max(best.confidence.total, 0.72),
            reason: "recovered missing field from nearby label and underline",
          },
          detectionSource: best.candidate.source,
          sectionId: best.sectionId,
          anchorText: best.line.text,
        },
        `recovered-${recoveryCounter}`
      )
    );
    recoveryCounter += 1;
  }

  return recovered;
}

function detectFallbackGeometryFields(context: DetectionContext, detectedFields: TemplateField[]): TemplateField[] {
  if (detectedFields.length >= 4) return [];

  const fallbacks: TemplateField[] = [];
  let fallbackCounter = 1;

  for (const candidate of context.geometryCandidates) {
    if (candidate.consumed || candidate.kind !== "underline" || candidate.width < 40) continue;
    const overlaps = detectedFields.some(
      (field) =>
        field.pageNumber === candidate.pageNumber &&
        overlapsEnough(
          {
            ...candidate,
            source: candidate.source,
          },
          {
            id: field.id,
            kind: "underline",
            x: field.x,
            y: field.y,
            width: field.width,
            height: field.height,
            pageNumber: field.pageNumber,
            source: field.detectionSource ?? "manual",
          }
        )
    );
    if (overlaps) continue;

    fallbacks.push({
      id: `detected-generic-${fallbackCounter}`,
      label: `Detected field ${fallbackCounter}`,
      mappedProjectKey: "",
      pageNumber: candidate.pageNumber,
      x: Math.round(candidate.x),
      y: Math.round(candidate.y),
      width: Math.round(candidate.width),
      height: Math.round(Math.max(candidate.height, 14)),
      confidence: 0.35,
      fieldType: "text",
      fieldKind: "text",
      detectionSource: candidate.source,
      sectionId: "generic",
      confidenceDetails: {
        total: 0.35,
        geometry: 0.35,
        reason: "unmapped fallback from unused underline geometry",
      },
    });
    fallbackCounter += 1;
    if (fallbacks.length >= 4) break;
  }

  return fallbacks;
}

function clampFieldsToPage(fields: TemplateField[], pageWidth: number, pageHeight: number): TemplateField[] {
  return fields.map((field) => {
    const width = field.x + field.width > pageWidth - 8 ? Math.max(24, pageWidth - 8 - field.x) : field.width;
    const height = field.y + field.height > pageHeight - 8 ? Math.max(10, pageHeight - 8 - field.y) : field.height;
    return {
      ...field,
      x: Math.max(0, field.x),
      y: Math.max(0, field.y),
      width,
      height,
    };
  });
}

function dedupeDetectedFields(fields: TemplateField[]): TemplateField[] {
  const sorted = [...fields].sort((a, b) => b.confidence - a.confidence);
  const kept: TemplateField[] = [];

  for (const field of sorted) {
    const duplicate = kept.find((existing) => {
      const samePage = existing.pageNumber === field.pageNumber;
      const similarPosition =
        Math.abs(existing.x - field.x) <= 8 &&
        Math.abs(existing.y - field.y) <= 8 &&
        Math.abs(existing.width - field.width) <= 12 &&
        Math.abs(existing.height - field.height) <= 12;
      const sameMeaning =
        existing.canonicalFieldId === field.canonicalFieldId ||
        (existing.mappedProjectKey !== "" && existing.mappedProjectKey === field.mappedProjectKey);
      return samePage && similarPosition && sameMeaning;
    });

    if (!duplicate) {
      kept.push(field);
    }
  }

  return kept;
}

function sortFields(fields: TemplateField[]): TemplateField[] {
  return [...fields].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) < 10) return a.x - b.x;
    return yDiff;
  });
}

export async function detectFieldsFromPdf(
  pdfBytes: Uint8Array,
  pageNumber: number = 1
): Promise<TemplateField[]> {
  const context = await buildDetectionContext(pdfBytes, pageNumber);
  const semanticFields = detectSemanticFields(context);
  const explicitGlyphCheckboxFields = detectExplicitGlyphCheckboxFields(context);
  const checkboxFields = detectCheckboxFields(context);
  const recoveredCheckboxFields = detectMissingCheckboxFields(context, [
    ...semanticFields,
    ...explicitGlyphCheckboxFields,
    ...checkboxFields,
  ]);
  const recoveredFields = detectMissingSemanticFields(context, [
    ...semanticFields,
    ...explicitGlyphCheckboxFields,
    ...checkboxFields,
    ...recoveredCheckboxFields,
  ]);
  const syntheticTrailingFields = detectSyntheticTrailingFields(context, [
    ...semanticFields,
    ...explicitGlyphCheckboxFields,
    ...checkboxFields,
    ...recoveredCheckboxFields,
    ...recoveredFields,
  ]);
  const fallbackFields = detectFallbackGeometryFields(context, [
    ...semanticFields,
    ...explicitGlyphCheckboxFields,
    ...checkboxFields,
    ...recoveredCheckboxFields,
    ...recoveredFields,
    ...syntheticTrailingFields,
  ]);

  return sortFields(
    dedupeDetectedFields(
      clampFieldsToPage(
        [
          ...semanticFields,
          ...explicitGlyphCheckboxFields,
          ...checkboxFields,
          ...recoveredCheckboxFields,
          ...recoveredFields,
          ...syntheticTrailingFields,
          ...fallbackFields,
        ],
        context.pageWidth,
        context.pageHeight
      )
    )
  );
}

export function createTemplateFromDetectedFields(
  fields: TemplateField[],
  pdfFileName: string
): {
  id: string;
  name: string;
  status: "local-draft";
  fields: TemplateField[];
  pageCount: number;
  createdAt: string;
  updatedAt: string;
} {
  const now = new Date().toISOString();
  const baseName = pdfFileName.replace(/\.pdf$/i, "").slice(0, 40);
  
  return {
    id: `tpl-detected-${Date.now()}`,
    name: `${baseName} — draft`,
    status: "local-draft",
    fields,
    pageCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}
