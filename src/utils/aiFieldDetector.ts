import * as pdfjsLib from "pdfjs-dist";
import type { TemplateField, CanonicalFieldId, TemplateFieldKind } from "@/types";
import {
  buildDetectionContext,
  type DetectionContext,
  type PositionedTextItem,
  type TextLine,
  type GeometryCandidate,
} from "@/utils/fieldDetector";
import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";

interface AiIdentifiedField {
  canonicalFieldId: string | null;
  label: string;
  nearbyText: string;
  fieldType: "text" | "checkbox";
  fieldKind: TemplateFieldKind;
  checkboxValue?: string | null;
  groupId?: string | null;
  optional?: boolean;
}

interface AiDetectionResponse {
  fields: AiIdentifiedField[];
  pageDescription?: string;
}

interface DocAIField {
  label: string;
  canonicalFieldId: string | null;
  fieldType: "text" | "checkbox";
  fieldKind: string;
  checkboxValue?: string | null;
  groupId?: string | null;
  boundingBox: { x: number; y: number; width: number; height: number };
  isCheckbox: boolean;
  isChecked: boolean;
}

interface DocAIDetectionResponse {
  fields: DocAIField[];
}

interface VisualMatchField {
  markerNumber: number;
  canonicalFieldId: string | null;
  label: string;
  fieldType: "text" | "checkbox";
  fieldKind: TemplateFieldKind;
  checkboxValue?: string | null;
  groupId?: string | null;
  optional?: boolean;
}

interface VisualMatchResponse {
  fields: VisualMatchField[];
  pageDescription?: string;
}

const VALID_CANONICAL_IDS = new Set<string>(
  CANONICAL_FIELD_DEFINITIONS.map((d) => d.id)
);

function getEdgeFunctionUrl(version: "v1" | "v2" | "v3" | "v4" | "v5" = "v1"): string {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  if (!supabaseUrl) throw new Error("VITE_SUPABASE_URL not configured");
  const fnNames: Record<string, string> = {
    v1: "detect-fields",
    v2: "detect-fields-v2",
    v3: "detect-fields-v3",
    v4: "detect-fields-v4",
    v5: "detect-fields-v5",
  };
  return `${supabaseUrl}/functions/v1/${fnNames[version]}`;
}

function getSupabaseAnonKey(): string {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!key) throw new Error("VITE_SUPABASE_ANON_KEY not configured");
  return key;
}


async function renderPageToBase64(pdfBytes: Uint8Array, pageNumber: number, dpi: number = 150): Promise<string> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);

  const scale = dpi / 72;
  const scaledViewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  const ctx = canvas.getContext("2d")!;

  await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");

  canvas.width = 0;
  canvas.height = 0;
  pdf.destroy();

  return base64;
}

async function callEdgeFunction(base64Image: string, fileName: string): Promise<AiDetectionResponse> {
  const url = getEdgeFunctionUrl("v1");
  const anonKey = getSupabaseAnonKey();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ image: base64Image, fileName }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Edge function error (${response.status}): ${errBody}`);
  }

  return response.json();
}

async function callAzureEdgeFunction(base64Image: string): Promise<DocAIDetectionResponse> {
  const url = getEdgeFunctionUrl("v4");
  const anonKey = getSupabaseAnonKey();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ image: base64Image }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Azure edge function error (${response.status}): ${errBody}`);
  }

  return response.json();
}

async function callVisualMatchEdgeFunction(
  base64Image: string,
  geometryList: string
): Promise<VisualMatchResponse> {
  const url = getEdgeFunctionUrl("v5");
  const anonKey = getSupabaseAnonKey();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ image: base64Image, geometryList }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Visual match edge function error (${response.status}): ${errBody}`);
  }

  return response.json();
}

/**
 * Determine whether a geometry candidate is likely a fillable area
 * (text input, checkbox, signature line) rather than decorative chrome.
 */
function isLikelyFillGeometry(
  geo: GeometryCandidate,
  pageWidth: number,
  pageHeight: number
): boolean {
  // AcroForm widgets are always relevant
  if (geo.source === "acroform") return true;
  // Glyph checkboxes are always relevant
  if (geo.source === "glyph-checkbox") return true;
  // Inline underscores from text are relevant
  if (geo.source === "text-inline") return true;

  // Skip elements spanning nearly the full page width (borders, headers, section bars)
  if (geo.width > pageWidth * 0.85) return false;

  // Skip very large rectangles that are likely background fills or section boxes
  const area = geo.width * geo.height;
  if (area > pageWidth * pageHeight * 0.15) return false;

  // Skip very small geometry that's unlikely to be a fill area or checkbox
  if (geo.width < 8 && geo.height < 8) return false;

  // Small boxes are likely checkboxes
  if (geo.kind === "box") return geo.width >= 6 && geo.height >= 6;

  // Underlines: thin horizontal lines are often fill areas (signature lines, text
  // entry underlines) — keep anything with reasonable width regardless of height
  if (geo.kind === "underline") return geo.width >= 15;

  // Widgets: keep if not tiny
  if (geo.kind === "widget") return geo.width >= 10 || geo.height >= 10;

  // General geometry: keep lines/shapes with reasonable width
  // Thin horizontal lines (height < 3) with decent width are likely fill underlines
  if (geo.height < 3 && geo.width >= 30) return true;

  return geo.width >= 15;
}

/**
 * Find the nearest text label for a geometry candidate.
 * Checks below, to the left, and above the geometry element.
 */
function findNearbyLabel(
  geo: GeometryCandidate,
  context: DetectionContext
): string {
  let bestText = "";
  let bestDist = Infinity;

  for (const item of context.textItems) {
    if (item.pageNumber !== geo.pageNumber) continue;
    if (item.text.length < 2) continue;

    const itemCenterX = item.x + item.width / 2;
    const geoCenterX = geo.x + geo.width / 2;
    const itemCenterY = item.y + item.height / 2;
    const geoCenterY = geo.y + geo.height / 2;

    // Only consider text that's horizontally near or overlapping with the geometry
    const hOverlap = Math.max(
      0,
      Math.min(item.x + item.width, geo.x + geo.width) - Math.max(item.x, geo.x)
    );
    const horizontallyNear = hOverlap > 0 || Math.abs(itemCenterX - geoCenterX) < geo.width;
    if (!horizontallyNear && Math.abs(item.x - geo.x) > 80) continue;

    // Text below geometry (label below fill area)
    const belowDist = (item.y - (geo.y + geo.height));
    if (belowDist >= -5 && belowDist <= 25) {
      const dist = Math.abs(belowDist) + Math.abs(itemCenterX - geoCenterX) * 0.3;
      if (dist < bestDist) { bestDist = dist; bestText = item.text; }
    }

    // Text to the left of geometry (label left of fill area)
    const leftDist = geo.x - (item.x + item.width);
    if (leftDist >= -5 && leftDist <= 30 && Math.abs(itemCenterY - geoCenterY) < 15) {
      const dist = Math.abs(leftDist) + Math.abs(itemCenterY - geoCenterY) * 0.5;
      if (dist < bestDist) { bestDist = dist; bestText = item.text; }
    }

    // Text above geometry (less common but possible)
    const aboveDist = geo.y - (item.y + item.height);
    if (aboveDist >= -5 && aboveDist <= 20 && hOverlap > 0) {
      const dist = Math.abs(aboveDist) + Math.abs(itemCenterX - geoCenterX) * 0.3 + 5;
      if (dist < bestDist) { bestDist = dist; bestText = item.text; }
    }
  }

  return bestText;
}

/**
 * Render the PDF page with numbered markers on likely fill areas.
 * Pre-filters geometry to skip decorative elements, includes nearby text
 * labels in the geometry list for GPT-4o context.
 */
async function renderAnnotatedPage(
  pdfBytes: Uint8Array,
  pageNumber: number,
  context: DetectionContext,
  dpi: number = 300
): Promise<{ annotatedBase64: string; markerMap: Map<number, GeometryCandidate>; geometryListText: string }> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);

  const scale = dpi / 72;
  const scaledViewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  const ctx = canvas.getContext("2d")!;

  await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

  // Filter to only likely fill areas
  const fillCandidates = context.geometryCandidates.filter(
    (g) => g.pageNumber === pageNumber && isLikelyFillGeometry(g, context.pageWidth, context.pageHeight)
  );

  console.log(
    `[Wrapkit Visual] Filtered ${context.geometryCandidates.length} geometry → ${fillCandidates.length} fill candidates`
  );

  const markerMap = new Map<number, GeometryCandidate>();
  const geometryLines: string[] = [];
  let markerNum = 0;

  for (const geo of fillCandidates) {
    const px = geo.x * scale;
    const py = geo.y * scale;
    const pw = geo.width * scale;
    const ph = geo.height * scale;

    const isCheckbox = geo.kind === "box" || (geo.kind === "widget" && geo.width <= 28 && geo.height <= 28);
    const markerColor = isCheckbox ? "rgba(30, 130, 220, 0.9)" : "rgba(220, 30, 30, 0.9)";
    const highlightColor = isCheckbox ? "rgba(30, 130, 220, 0.4)" : "rgba(220, 30, 30, 0.3)";

    ctx.save();

    // Draw a highlight rectangle on the geometry
    ctx.strokeStyle = highlightColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);

    // Draw numbered marker ABOVE the geometry (so it doesn't obscure the form)
    const radius = Math.max(9, 12 * (dpi / 300));
    const markerX = px + pw / 2;
    const markerY = Math.max(radius + 2, py - radius - 3);

    // White background circle for contrast
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(markerX, markerY, radius + 2, 0, Math.PI * 2);
    ctx.fill();

    // Colored marker circle
    ctx.fillStyle = markerColor;
    ctx.beginPath();
    ctx.arc(markerX, markerY, radius, 0, Math.PI * 2);
    ctx.fill();

    // Number text
    ctx.fillStyle = "#FFFFFF";
    const fontSize = markerNum >= 10 ? Math.round(radius * 0.95) : Math.round(radius * 1.15);
    ctx.font = `bold ${fontSize}px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(markerNum), markerX, markerY);

    ctx.restore();

    markerMap.set(markerNum, geo);

    // Include nearby text label for context
    const nearbyText = findNearbyLabel(geo, context);
    const nearbyPart = nearbyText ? `, near text "${nearbyText}"` : "";
    const typePart = isCheckbox ? "checkbox" : geo.kind;

    geometryLines.push(
      `#${markerNum}: ${typePart} at (${Math.round(geo.x)}, ${Math.round(geo.y)}), ` +
      `size ${Math.round(geo.width)}x${Math.round(geo.height)}${nearbyPart}`
    );
    markerNum++;
  }

  const dataUrl = canvas.toDataURL("image/png");
  const annotatedBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");

  canvas.width = 0;
  canvas.height = 0;
  pdf.destroy();

  return {
    annotatedBase64,
    markerMap,
    geometryListText: geometryLines.join("\n"),
  };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9#\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Score how well a text string matches a search query.
 * Returns 0-1, where 1 is a perfect match.
 */
function scoreTextMatch(haystack: string, needle: string): number {
  const hNorm = normalize(haystack);
  const nNorm = normalize(needle);

  if (!hNorm || !nNorm) return 0;

  // Exact match
  if (hNorm === nNorm) return 1.0;

  // Substring containment — scale score by how much of the haystack the
  // needle covers so short needles in long haystacks score lower than
  // the same needle in a shorter, more specific haystack.
  if (hNorm.includes(nNorm)) {
    const coverage = nNorm.length / hNorm.length;
    return 0.80 + 0.15 * coverage;          // range: 0.80 → 0.95
  }
  if (nNorm.includes(hNorm)) return 0.85;

  // Token overlap
  const needleTokens = nNorm.split(/\s+/).filter(Boolean);
  const haystackTokens = new Set(hNorm.split(/\s+/).filter(Boolean));
  let matched = 0;
  for (const token of needleTokens) {
    for (const hToken of haystackTokens) {
      if (hToken.includes(token) || token.includes(hToken)) {
        matched++;
        break;
      }
    }
  }
  const tokenScore = needleTokens.length > 0 ? matched / needleTokens.length : 0;
  return tokenScore * 0.7;
}

/**
 * Find the best matching text line + item for an AI-identified field.
 * Prefers exact substring matches over loose token matching.
 */
function findLabelInContext(
  aiField: AiIdentifiedField,
  context: DetectionContext
): { line: TextLine; labelItem: PositionedTextItem | null } | null {
  const searchTexts = [aiField.nearbyText, aiField.label].filter(Boolean);

  let bestLine: TextLine | null = null;
  let bestItem: PositionedTextItem | null = null;
  let bestScore = 0;

  for (const line of context.textLines) {
    for (const search of searchTexts) {
      const lineScore = scoreTextMatch(line.text, search);
      if (lineScore < 0.5) continue;

      let itemScore = 0;
      let itemMatch: PositionedTextItem | null = null;

      for (const item of line.items) {
        const s = scoreTextMatch(item.text, search);
        if (s > itemScore) {
          itemScore = s;
          itemMatch = item;
        }
      }

      const effectiveScore = Math.max(lineScore, itemScore);

      if (effectiveScore > bestScore) {
        bestScore = effectiveScore;
        bestLine = line;
        bestItem = itemMatch && itemScore >= 0.5 ? itemMatch : null;
      }
    }
  }

  if (!bestLine || bestScore < 0.5) return null;
  return { line: bestLine, labelItem: bestItem };
}

/**
 * Find the fill area (underline/widget geometry) for a text field.
 * Supports two common form layouts:
 *   1. Fill area to the RIGHT of the label (same row)
 *   2. Fill area ABOVE the label (label sits below an underline)
 */
function findFillArea(
  labelLine: TextLine,
  labelItem: PositionedTextItem | null,
  context: DetectionContext,
  usedGeoIds: Set<string>
): { x: number; y: number; width: number; height: number } | null {
  const labelEndX = labelItem
    ? labelItem.x + labelItem.width
    : labelLine.x + labelLine.width;
  const labelStartX = labelItem ? labelItem.x : labelLine.x;
  const labelY = labelLine.y;
  const labelHeight = labelLine.height;

  // Find the next label on the same line to bound field width
  let nextLabelX = context.pageWidth;
  if (labelItem) {
    for (const item of labelLine.items) {
      if (item === labelItem) continue;
      if (item.x > labelEndX + 10 && item.x < nextLabelX) {
        nextLabelX = item.x;
      }
    }
  }

  type ScoredGeo = { geo: GeometryCandidate; score: number; mode: "right" | "above" };
  const candidates: ScoredGeo[] = [];

  for (const geo of context.geometryCandidates) {
    if (geo.kind === "box") continue;
    if (usedGeoIds.has(geo.id)) continue;
    if (geo.width < 20) continue;

    const yDist = Math.abs(geo.y - labelY);

    // --- Pattern 1: geometry to the RIGHT of the label (same row) ---
    if (yDist <= 30) {
      const geoStartsAfterLabel = geo.x >= labelEndX - 8;
      const geoEndsAfterLabel = geo.x + geo.width > labelEndX + 5;

      if (geoStartsAfterLabel || geoEndsAfterLabel) {
        if (!(labelItem && geo.x > nextLabelX + 5)) {
          let score = 100;
          score -= yDist * 3;
          score -= Math.abs(geo.x - labelEndX) * 0.5;
          if (yDist <= 8 && geo.x >= labelEndX - 4 && geo.x <= labelEndX + 40) {
            score += 50;
          }
          if (geo.width >= 40 && geo.width <= 300) score += 10;
          if (geo.x < labelStartX + 5) score -= 40;
          candidates.push({ geo, score, mode: "right" });
        }
      }
    }

    // --- Pattern 2: geometry ABOVE the label (label below underline) ---
    // The underline is on the immediately preceding line, so geo.y < labelY.
    // Max gap is tight (22px) to only match the directly adjacent row.
    const geoBottom = geo.y + geo.height;
    const geoIsAbove = geoBottom < labelY + 5 && geo.y < labelY;
    const verticalGap = labelY - geoBottom;

    if (geoIsAbove && verticalGap >= -5 && verticalGap <= 22 && geo.width >= 40) {
      const geoRight = geo.x + geo.width;
      const overlapLeft = Math.max(geo.x, labelStartX - 20);
      const overlapRight = Math.min(geoRight, nextLabelX + 20);
      const horizontalOverlap = overlapRight - overlapLeft;

      if (horizontalOverlap > 20) {
        // Check for intervening text lines or geometry between candidate and label
        let interveningCount = 0;
        for (const tl of context.textLines) {
          const tlCenter = tl.y + tl.height / 2;
          if (tlCenter > geoBottom + 2 && tlCenter < labelY - 2) {
            interveningCount++;
          }
        }
        for (const otherGeo of context.geometryCandidates) {
          if (otherGeo === geo) continue;
          if (otherGeo.width < 30) continue;
          const otherCenter = otherGeo.y + otherGeo.height / 2;
          if (otherCenter > geoBottom + 2 && otherCenter < labelY - 2) {
            interveningCount++;
          }
        }

        let score = 90;
        score -= verticalGap * 3;
        score -= interveningCount * 60;
        if (Math.abs(geo.x - labelStartX) < 20) score += 35;
        if (geo.width >= 50 && geo.width <= 400) score += 15;
        if (geo.kind === "underline" && verticalGap < 15) score += 30;
        candidates.push({ geo, score, mode: "above" });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0 && candidates[0].score > 20) {
    const best = candidates[0];
    const bestGeo = best.geo;
    usedGeoIds.add(bestGeo.id);

    if (best.mode === "above") {
      // For "above" pattern: the fill area IS the underline geometry
      const baselinePad = bestGeo.kind === "underline" ? 12 : 4;
      const correctedY = Math.max(0, bestGeo.y - baselinePad);
      const geoBottom = bestGeo.y + bestGeo.height;
      const fieldHeight = Math.max(geoBottom - correctedY, labelHeight, 14);

      return {
        x: bestGeo.x,
        y: correctedY,
        width: Math.max(bestGeo.width, 30),
        height: fieldHeight,
      };
    }

    // For "right" pattern: field starts after the label
    const fieldX = Math.max(bestGeo.x, labelEndX + 2);
    const fieldWidth = bestGeo.width - Math.max(0, fieldX - bestGeo.x);
    const baselinePad = bestGeo.kind === "underline" ? 12 : 4;
    const correctedGeoY = Math.max(0, bestGeo.y - baselinePad);
    const fieldY = Math.min(correctedGeoY, labelY);
    const geoBottom = bestGeo.y + bestGeo.height;
    const fieldHeight = Math.max(geoBottom - fieldY, labelHeight, 14);

    return {
      x: fieldX,
      y: fieldY,
      width: Math.max(fieldWidth, 30),
      height: fieldHeight,
    };
  }

  // Fallback: create synthetic fill area to the right of the label
  const maxWidth = nextLabelX - labelEndX - 10;
  if (maxWidth > 25) {
    return {
      x: labelEndX + 6,
      y: labelLine.y,
      width: Math.min(maxWidth, context.pageWidth * 0.45),
      height: Math.max(labelHeight, 14),
    };
  }

  // Last resort: fill area below the label
  return {
    x: labelLine.x,
    y: labelLine.y + labelHeight + 4,
    width: Math.min(context.pageWidth - labelLine.x - 40, context.pageWidth * 0.5),
    height: Math.max(labelHeight, 14),
  };
}

const CREDIT_CARD_CHECKBOX_IDS = new Set([
  "creditCardTypeVisa",
  "creditCardTypeMastercard",
  "creditCardTypeDiscover",
  "creditCardTypeAmex",
]);


const CARD_BRAND_SEARCHES: Record<string, string[]> = {
  creditCardTypeVisa: ["visa"],
  creditCardTypeMastercard: ["mastercard", "master card", "mc"],
  creditCardTypeDiscover: ["discover"],
  creditCardTypeAmex: ["amex", "american express"],
};

/**
 * Position all credit card type checkboxes as a group.
 * Finds the card-type row, locates ALL box geometry on it,
 * and assigns each box to the nearest brand label.
 */
function positionCardTypeCheckboxes(
  cardFields: AiIdentifiedField[],
  context: DetectionContext,
  usedGeoIds: Set<string>
): Map<string, { x: number; y: number; width: number; height: number }> {
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();

  // Step 1: Find text items for each card brand
  const brandTextItems = new Map<string, PositionedTextItem>();
  for (const field of cardFields) {
    const id = field.canonicalFieldId;
    if (!id) continue;
    const searches = CARD_BRAND_SEARCHES[id] ?? [normalize(field.nearbyText || field.label)];

    let bestItem: PositionedTextItem | null = null;
    let bestScore = 0;
    for (const item of context.textItems) {
      for (const search of searches) {
        const score = scoreTextMatch(item.text, search);
        if (score > bestScore) {
          bestScore = score;
          bestItem = item;
        }
      }
    }
    if (bestItem && bestScore >= 0.5) {
      brandTextItems.set(id, bestItem);
    }
  }

  if (brandTextItems.size === 0) return result;

  // Step 2: Determine the card type row y-coordinate from the found text items
  const yValues = [...brandTextItems.values()].map((t) => t.y);
  const rowY = yValues.reduce((sum, y) => sum + y, 0) / yValues.length;
  console.log(`[Wrapkit AI] Card type row at y≈${Math.round(rowY)}, found ${brandTextItems.size} brand labels`);

  // Step 3: Collect ALL box-like geometry on the card type row (within y tolerance)
  const rowBoxes: GeometryCandidate[] = [];
  for (const geo of context.geometryCandidates) {
    if (usedGeoIds.has(geo.id)) continue;
    if (Math.abs(geo.y - rowY) > 20) continue;

    const isBox = geo.kind === "box";
    const isSmallWidget = geo.kind === "widget" && geo.width <= 28 && geo.height <= 28;
    const isSmallFilledRect = geo.kind === "underline" && geo.width <= 28 && geo.height >= 5 && geo.height <= 28;
    if (!isBox && !isSmallWidget && !isSmallFilledRect) continue;

    rowBoxes.push(geo);
  }
  console.log(`[Wrapkit AI] Found ${rowBoxes.length} box candidates on card type row`);

  // Step 4: For each brand, find the closest box OR place synthetically
  const assignedBoxIds = new Set<string>();

  for (const [fieldId, textItem] of brandTextItems) {
    // Find the box closest to this brand's text, preferring boxes just before or after the label
    let bestBox: GeometryCandidate | null = null;
    let bestDist = Infinity;

    for (const box of rowBoxes) {
      if (assignedBoxIds.has(box.id)) continue;
      // Prefer boxes immediately before or after the text label
      const xDist = Math.min(
        Math.abs(box.x - (textItem.x + textItem.width)),
        Math.abs((box.x + box.width) - textItem.x)
      );
      if (xDist < bestDist && xDist < 50) {
        bestDist = xDist;
        bestBox = box;
      }
    }

    if (bestBox) {
      assignedBoxIds.add(bestBox.id);
      usedGeoIds.add(bestBox.id);
      result.set(fieldId, {
        x: bestBox.x,
        y: bestBox.y,
        width: Math.min(14, Math.max(10, bestBox.width)),
        height: Math.min(18, Math.max(10, bestBox.height)),
      });
      console.log(`[Wrapkit AI] Card checkbox "${fieldId}" matched box at (${Math.round(bestBox.x)}, ${Math.round(bestBox.y)})`);
    } else {
      // Synthetic fallback: place checkbox right after the brand text
      result.set(fieldId, {
        x: textItem.x + textItem.width + 4,
        y: textItem.y,
        width: 12,
        height: 12,
      });
      console.log(`[Wrapkit AI] Card checkbox "${fieldId}" placed synthetically after "${textItem.text}"`);
    }
  }

  return result;
}

/**
 * Find checkbox geometry near a label for non-credit-card checkboxes.
 * Searches for box-like geometry (AcroForm boxes, small widgets, glyphs)
 * near the label text, preferring boxes immediately to the left of the label.
 */
function findCheckboxGeometry(
  aiField: AiIdentifiedField,
  context: DetectionContext,
  usedGeoIds: Set<string>
): { x: number; y: number; width: number; height: number } | null {
  if (aiField.canonicalFieldId && CREDIT_CARD_CHECKBOX_IDS.has(aiField.canonicalFieldId)) {
    return null;
  }

  const labelMatch = findLabelInContext(aiField, context);
  if (!labelMatch) return null;

  const labelItem = labelMatch.labelItem;
  const labelLine = labelMatch.line;
  const labelX = labelItem ? labelItem.x : labelLine.x;
  const labelY = labelItem ? labelItem.y : labelLine.y;

  type ScoredBox = { geo: GeometryCandidate; score: number };
  const candidates: ScoredBox[] = [];

  for (const geo of context.geometryCandidates) {
    if (usedGeoIds.has(geo.id)) continue;
    if (geo.kind !== "box" && !(geo.kind === "widget" && geo.width <= 28 && geo.height <= 28)) continue;

    const yDist = Math.abs(geo.y - labelY);
    if (yDist > 15) continue;

    const geoRight = geo.x + geo.width;
    const distToLabel = labelX - geoRight;

    if (distToLabel < -5 || distToLabel > 40) continue;

    let score = 100 - yDist * 3 - Math.abs(distToLabel) * 1.5;
    if (distToLabel >= 0 && distToLabel <= 15) score += 30;

    candidates.push({ geo, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0 && candidates[0].score > 40) {
    const best = candidates[0].geo;
    usedGeoIds.add(best.id);
    return { x: best.x, y: best.y, width: best.width, height: best.height };
  }

  // Fallback: create a synthetic checkbox to the left of the label
  const size = Math.min(14, labelLine.height);
  return {
    x: Math.max(0, labelX - size - 6),
    y: labelY + (labelLine.height - size) / 2,
    width: size,
    height: size,
  };
}

function buildTemplateField(
  aiField: AiIdentifiedField,
  coords: { x: number; y: number; width: number; height: number },
  index: number,
  pageNumber: number
): TemplateField {
  const canonicalId = aiField.canonicalFieldId && VALID_CANONICAL_IDS.has(aiField.canonicalFieldId)
    ? (aiField.canonicalFieldId as CanonicalFieldId)
    : undefined;

  const canonicalDef = canonicalId
    ? CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === canonicalId)
    : undefined;

  const isCardCheckbox = canonicalId && CREDIT_CARD_CHECKBOX_IDS.has(canonicalId);
  const isBooleanCheckbox = aiField.fieldType === "checkbox" && !isCardCheckbox;

  const catalogKey = canonicalDef?.mappedProjectKey ?? "";
  const fieldLabel = aiField.label || canonicalDef?.label || `Field ${index + 1}`;

  // Fields without a project key mapping default to "prompt at fill time"
  const isUnmappedText = !isBooleanCheckbox && !isCardCheckbox && !catalogKey;
  const mappedKey = isBooleanCheckbox || isUnmappedText
    ? "__prompt__"
    : catalogKey;

  return {
    id: `ai-field-${Date.now()}-${index}`,
    label: fieldLabel,
    mappedProjectKey: (mappedKey || "") as TemplateField["mappedProjectKey"],
    canonicalFieldId: canonicalId,
    pageNumber,
    x: coords.x,
    y: coords.y,
    width: coords.width,
    height: coords.height,
    confidence: 0.9,
    fieldType: aiField.fieldType === "checkbox" ? "checkbox" : "text",
    fieldKind: isBooleanCheckbox ? "boolean-checkbox" : (canonicalDef?.fieldKind ?? aiField.fieldKind ?? "text"),
    detectionSource: "text-line",
    checkboxValue: aiField.checkboxValue ?? canonicalDef?.checkboxValue,
    groupId: aiField.groupId ?? canonicalDef?.groupId,
    promptLabel: (isBooleanCheckbox || isUnmappedText) ? fieldLabel : undefined,
    optional: aiField.optional || undefined,
  };
}


// --------------- Visual Geometry Matching (GPT-4o + numbered markers) ---------------

async function detectFieldsWithVisualMatching(
  pdfBytes: Uint8Array,
  pageNumber: number,
  onStatus?: (status: string) => void
): Promise<TemplateField[]> {
  console.log("[Wrapkit Visual] Starting visual geometry matching detection...");
  onStatus?.("Analyzing PDF structure…");

  const context = await buildDetectionContext(pdfBytes, pageNumber);
  console.log(
    `[Wrapkit Visual] Page: ${context.pageWidth}x${context.pageHeight}, ` +
    `${context.textLines.length} lines, ${context.geometryCandidates.length} geometry candidates`
  );

  if (context.geometryCandidates.length === 0) {
    console.warn("[Wrapkit Visual] No geometry candidates found on page");
    return [];
  }

  onStatus?.("Rendering annotated PDF…");
  const { annotatedBase64, markerMap, geometryListText } = await renderAnnotatedPage(
    pdfBytes, pageNumber, context
  );
  console.log(`[Wrapkit Visual] Drew ${markerMap.size} markers on page`);

  onStatus?.("Matching fields with GPT-4o Vision…");
  const response = await callVisualMatchEdgeFunction(annotatedBase64, geometryListText);
  const matchedFields = response.fields ?? [];
  console.log(`[Wrapkit Visual] GPT-4o matched ${matchedFields.length} fields`);
  if (response.pageDescription) {
    console.log(`[Wrapkit Visual] Form type: ${response.pageDescription}`);
  }

  if (matchedFields.length === 0) return [];

  onStatus?.("Building template fields…");

  const seenCanonicalIds = new Set<string>();
  const usedGeoIds = new Set<string>();
  const templateFields: TemplateField[] = [];

  for (const mf of matchedFields) {
    if (mf.canonicalFieldId) {
      const def = CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === mf.canonicalFieldId);
      if (!def?.allowDuplicates && seenCanonicalIds.has(mf.canonicalFieldId)) {
        console.log(`[Wrapkit Visual] Skipping duplicate: ${mf.canonicalFieldId}`);
        continue;
      }
      seenCanonicalIds.add(mf.canonicalFieldId);
    }

    const geo = markerMap.get(mf.markerNumber);
    if (!geo) {
      console.warn(`[Wrapkit Visual] Marker #${mf.markerNumber} not found in geometry map, skipping "${mf.label}"`);
      continue;
    }

    if (usedGeoIds.has(geo.id)) {
      console.log(`[Wrapkit Visual] Geometry ${geo.id} already used, skipping "${mf.label}"`);
      continue;
    }
    usedGeoIds.add(geo.id);

    const isCheckbox = mf.fieldType === "checkbox";

    let coords: { x: number; y: number; width: number; height: number };

    if (isCheckbox) {
      coords = {
        x: geo.x,
        y: geo.y,
        width: Math.min(14, Math.max(10, geo.width)),
        height: Math.min(18, Math.max(10, geo.height)),
      };
    } else {
      // For text fields on underlines, offset upward to create the text entry area
      const baselinePad = geo.kind === "underline" ? 12 : 4;
      const correctedY = Math.max(0, geo.y - baselinePad);
      const geoBottom = geo.y + geo.height;
      const fieldHeight = Math.max(geoBottom - correctedY, 14);

      coords = {
        x: geo.x,
        y: correctedY,
        width: Math.max(geo.width, 30),
        height: fieldHeight,
      };
    }

    // Clamp to page bounds
    coords.x = Math.max(0, coords.x);
    coords.y = Math.max(0, coords.y);
    if (coords.x + coords.width > context.pageWidth) {
      coords.width = context.pageWidth - coords.x;
    }

    const aiField: AiIdentifiedField = {
      canonicalFieldId: mf.canonicalFieldId,
      label: mf.label,
      nearbyText: mf.label,
      fieldType: mf.fieldType,
      fieldKind: mf.fieldKind,
      checkboxValue: mf.checkboxValue ?? null,
      groupId: mf.groupId ?? null,
      optional: mf.optional,
    };

    const field = buildTemplateField(aiField, coords, templateFields.length, pageNumber);
    console.log(
      `[Wrapkit Visual] #${mf.markerNumber} "${field.label}" → ` +
      `(${Math.round(coords.x)}, ${Math.round(coords.y)}) ` +
      `${Math.round(coords.width)}x${Math.round(coords.height)} [${geo.kind}]`
    );
    templateFields.push(field);
  }

  // Card-type checkbox refinement: if GPT-4o matched card types, try to refine using
  // the proven positionCardTypeCheckboxes logic for more precise box placement
  const cardFields = templateFields.filter(
    (f) => f.canonicalFieldId && CREDIT_CARD_CHECKBOX_IDS.has(f.canonicalFieldId)
  );
  if (cardFields.length > 0) {
    const cardAiFields = cardFields.map((f): AiIdentifiedField => ({
      canonicalFieldId: f.canonicalFieldId ?? null,
      label: f.label,
      nearbyText: f.label,
      fieldType: "checkbox",
      fieldKind: f.fieldKind ?? "checkbox-group",
      checkboxValue: f.checkboxValue,
      groupId: f.groupId,
    }));
    const refinedPositions = positionCardTypeCheckboxes(cardAiFields, context, usedGeoIds);
    for (const f of cardFields) {
      if (f.canonicalFieldId && refinedPositions.has(f.canonicalFieldId)) {
        const pos = refinedPositions.get(f.canonicalFieldId)!;
        f.x = pos.x;
        f.y = pos.y;
        f.width = pos.width;
        f.height = pos.height;
      }
    }
  }

  // Sweep for unclaimed checkboxes from geometry
  const supplementalCheckboxes = detectUnclaimedCheckboxes(context, usedGeoIds, pageNumber, templateFields.length);
  if (supplementalCheckboxes.length > 0) {
    console.log(`[Wrapkit Visual] Found ${supplementalCheckboxes.length} additional checkbox(es) from sweep`);
    templateFields.push(...supplementalCheckboxes);
  }

  // --- Supplemental pass: catch KNOWN fields GPT-4o missed ---
  // Only adds fields with a recognized canonical ID to avoid false positives
  // from paragraph text blanks (e.g. "I, _______, hereby authorize...")
  try {
    onStatus?.("Checking for missed fields…");
    const plainBase64 = await renderPageToBase64(pdfBytes, pageNumber);
    const v1Response = await callEdgeFunction(plainBase64, "");
    const v1Fields = v1Response.fields ?? [];

    const matchedCanonicalIds = new Set<string>(
      templateFields.filter((f) => f.canonicalFieldId).map((f) => f.canonicalFieldId as string)
    );

    let supplementCount = 0;
    for (const v1f of v1Fields) {
      // Only add fields with a recognized canonical ID — this filters out
      // spurious paragraph-text blanks and keeps only known field types
      if (!v1f.canonicalFieldId || !VALID_CANONICAL_IDS.has(v1f.canonicalFieldId)) continue;

      // Skip if already matched
      if (matchedCanonicalIds.has(v1f.canonicalFieldId)) continue;

      // Skip credit card checkboxes — already handled by visual matching
      if (CREDIT_CARD_CHECKBOX_IDS.has(v1f.canonicalFieldId)) continue;

      if (v1f.fieldType === "checkbox") {
        const coords = findCheckboxGeometry(v1f, context, usedGeoIds);
        if (!coords) continue;

        templateFields.push(buildTemplateField(v1f, coords, templateFields.length, pageNumber));
        supplementCount++;
      } else {
        const match = findLabelInContext(v1f, context);
        if (!match) continue;

        const coords = findFillArea(match.line, match.labelItem, context, usedGeoIds);
        if (!coords) continue;

        coords.x = Math.max(0, coords.x);
        coords.y = Math.max(0, coords.y);
        if (coords.x + coords.width > context.pageWidth) {
          coords.width = context.pageWidth - coords.x;
        }

        templateFields.push(buildTemplateField(v1f, coords, templateFields.length, pageNumber));
        supplementCount++;
      }

      matchedCanonicalIds.add(v1f.canonicalFieldId);
      console.log(`[Wrapkit Visual] Supplemental: added "${v1f.label}" (${v1f.canonicalFieldId})`);
    }

    if (supplementCount > 0) {
      console.log(`[Wrapkit Visual] Supplemental pass added ${supplementCount} missed canonical field(s)`);
    }
  } catch (err) {
    console.warn("[Wrapkit Visual] Supplemental pass failed (non-critical):", err);
  }

  console.log(`[Wrapkit Visual] Produced ${templateFields.length} total template fields`);
  return dedupeFields(templateFields);
}

// --------------- Azure Document Intelligence detection ---------------

async function detectFieldsWithAzure(
  pdfBytes: Uint8Array,
  pageNumber: number,
  onStatus?: (status: string) => void
): Promise<TemplateField[]> {
  console.log("[Wrapkit Azure] Starting Azure Document Intelligence + Gemini + PDF.js detection...");
  onStatus?.("Rendering PDF…");

  // Render image for Azure AND build PDF.js context for positioning in parallel
  const [base64, context] = await Promise.all([
    renderPageToBase64(pdfBytes, pageNumber, 300),
    buildDetectionContext(pdfBytes, pageNumber),
  ]);

  const pageWidth = context.pageWidth;
  const pageHeight = context.pageHeight;
  console.log(`[Wrapkit Azure] Page: ${pageWidth}x${pageHeight}, ${context.textLines.length} lines, ${context.geometryCandidates.length} geometry`);

  onStatus?.("Analyzing form with Azure…");
  const response = await callAzureEdgeFunction(base64);
  const azureFields = response.fields ?? [];
  console.log(`[Wrapkit Azure] Received ${azureFields.length} field(s) from Azure + Gemini`);

  if (azureFields.length === 0) return [];

  onStatus?.("Aligning to PDF structure…");

  const seenCanonicalIds = new Set<string>();
  const usedGeoIds = new Set<string>();
  const templateFields: TemplateField[] = [];

  // Separate checkboxes and text fields
  const checkboxFields = azureFields.filter((f) => f.fieldType === "checkbox");
  const textFields = azureFields.filter((f) => f.fieldType !== "checkbox");

  // --- Checkboxes: use Azure bounding boxes directly (they're precise) ---
  const cardCheckboxAzure = checkboxFields.filter(
    (f) => f.canonicalFieldId && CREDIT_CARD_CHECKBOX_IDS.has(f.canonicalFieldId)
  );
  // Convert to AiIdentifiedField for card type batch positioning
  const cardAiFields = cardCheckboxAzure.map((df): AiIdentifiedField => ({
    canonicalFieldId: df.canonicalFieldId,
    label: df.label,
    nearbyText: df.label,
    fieldType: "checkbox",
    fieldKind: (df.fieldKind as TemplateFieldKind) ?? "checkbox-group",
    checkboxValue: df.checkboxValue,
    groupId: df.groupId,
  }));
  const cardPositions = positionCardTypeCheckboxes(cardAiFields, context, usedGeoIds);

  for (const df of checkboxFields) {
    if (df.canonicalFieldId) {
      if (seenCanonicalIds.has(df.canonicalFieldId)) continue;
      seenCanonicalIds.add(df.canonicalFieldId);
    }

    const aiField: AiIdentifiedField = {
      canonicalFieldId: df.canonicalFieldId,
      label: df.label,
      nearbyText: df.label,
      fieldType: "checkbox",
      fieldKind: (df.fieldKind as TemplateFieldKind) ?? "boolean-checkbox",
      checkboxValue: df.checkboxValue,
      groupId: df.groupId,
    };

    let coords: { x: number; y: number; width: number; height: number } | null = null;

    if (df.canonicalFieldId && cardPositions.has(df.canonicalFieldId)) {
      coords = cardPositions.get(df.canonicalFieldId)!;
    } else {
      // Use Azure's bounding box for non-card checkboxes, converted to PDF coords
      const bb = df.boundingBox;
      coords = {
        x: bb.x * pageWidth,
        y: bb.y * pageHeight,
        width: Math.max(bb.width * pageWidth, 10),
        height: Math.max(bb.height * pageHeight, 12),
      };
    }

    console.log(`[Wrapkit Azure] Checkbox "${df.label}" → (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
    templateFields.push(buildTemplateField(aiField, coords, templateFields.length, pageNumber));
  }

  // --- Text fields: use PDF.js geometry for precise positioning ---
  for (const df of textFields) {
    if (df.canonicalFieldId) {
      if (seenCanonicalIds.has(df.canonicalFieldId)) {
        console.log(`[Wrapkit Azure] Skipping duplicate: ${df.canonicalFieldId}`);
        continue;
      }
      seenCanonicalIds.add(df.canonicalFieldId);
    }

    const aiField: AiIdentifiedField = {
      canonicalFieldId: df.canonicalFieldId,
      label: df.label,
      nearbyText: df.label,
      fieldType: "text",
      fieldKind: (df.fieldKind as TemplateFieldKind) ?? "text",
      checkboxValue: df.checkboxValue,
      groupId: df.groupId,
    };

    // Use label matching + geometry finding (handles labels-below-underlines)
    const match = findLabelInContext(aiField, context);
    if (!match) {
      // Fall back to Azure's raw bounding box if label not found in PDF
      const bb = df.boundingBox;
      const coords = {
        x: bb.x * pageWidth,
        y: bb.y * pageHeight,
        width: Math.max(bb.width * pageWidth, 10),
        height: Math.max(bb.height * pageHeight, 12),
      };
      console.log(`[Wrapkit Azure] "${df.label}" → raw Azure box (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
      templateFields.push(buildTemplateField(aiField, coords, templateFields.length, pageNumber));
      continue;
    }

    const coords = findFillArea(match.line, match.labelItem, context, usedGeoIds);
    if (!coords) {
      const bb = df.boundingBox;
      const fallback = {
        x: bb.x * pageWidth,
        y: bb.y * pageHeight,
        width: Math.max(bb.width * pageWidth, 10),
        height: Math.max(bb.height * pageHeight, 12),
      };
      console.log(`[Wrapkit Azure] "${df.label}" → no fill area, using Azure box`);
      templateFields.push(buildTemplateField(aiField, fallback, templateFields.length, pageNumber));
      continue;
    }

    // Clamp to page bounds
    coords.x = Math.max(0, coords.x);
    coords.y = Math.max(0, coords.y);
    if (coords.x + coords.width > pageWidth) {
      coords.width = pageWidth - coords.x;
    }

    console.log(`[Wrapkit Azure] "${df.label}" → PDF.js (${Math.round(coords.x)}, ${Math.round(coords.y)}) ${Math.round(coords.width)}x${Math.round(coords.height)}`);
    templateFields.push(buildTemplateField(aiField, coords, templateFields.length, pageNumber));
  }

  // Sweep for unclaimed checkboxes Azure may have missed
  const supplemental = detectUnclaimedCheckboxes(context, usedGeoIds, pageNumber, templateFields.length);
  if (supplemental.length > 0) {
    console.log(`[Wrapkit Azure] Found ${supplemental.length} additional checkbox(es)`);
    templateFields.push(...supplemental);
  }

  console.log(`[Wrapkit Azure] Produced ${templateFields.length} template fields`);
  return dedupeFields(templateFields);
}

export async function detectFieldsWithAI(
  pdfBytes: Uint8Array,
  pageNumber: number = 1,
  onStatus?: (status: string) => void
): Promise<TemplateField[]> {
  // Tier 1: Visual Geometry Matching (GPT-4o Vision + numbered PDF.js markers)
  // Highest accuracy: LLM visually matches numbered geometry to field labels
  try {
    const visualFields = await detectFieldsWithVisualMatching(pdfBytes, pageNumber, onStatus);
    if (visualFields.length > 0) {
      console.log(`[Wrapkit AI] Visual matching succeeded with ${visualFields.length} fields`);
      return visualFields;
    }
    console.log("[Wrapkit AI] Visual matching returned 0 fields, falling back…");
  } catch (err) {
    console.warn("[Wrapkit AI] Visual matching failed, falling back:", err);
  }

  // Tier 2: Azure Document Intelligence + Gemini (prebuilt-document model)
  try {
    const azureFields = await detectFieldsWithAzure(pdfBytes, pageNumber, onStatus);
    if (azureFields.length > 0) {
      console.log(`[Wrapkit AI] Azure succeeded with ${azureFields.length} fields`);
      return azureFields;
    }
    console.log("[Wrapkit AI] Azure returned 0 fields, falling back…");
  } catch (err) {
    console.warn("[Wrapkit AI] Azure detection failed, falling back:", err);
  }

  // Tier 3: GPT-4o + PDF.js hybrid (final fallback)
  console.log("[Wrapkit AI] Starting hybrid AI+PDF.js detection (GPT-4o fallback)...");
  onStatus?.("Rendering PDF…");

  const [base64, context] = await Promise.all([
    renderPageToBase64(pdfBytes, pageNumber),
    buildDetectionContext(pdfBytes, pageNumber),
  ]);

  console.log("[Wrapkit AI] Rendered page, calling AI for field identification...");
  console.log(`[Wrapkit AI] PDF.js found ${context.textLines.length} text lines, ${context.geometryCandidates.length} geometry candidates`);
  onStatus?.("Identifying fields with AI…");

  const response = await callEdgeFunction(base64, "");

  const aiFields = response.fields ?? [];
  console.log(`[Wrapkit AI] AI identified ${aiFields.length} field(s)`);
  if (response.pageDescription) {
    console.log(`[Wrapkit AI] Form type: ${response.pageDescription}`);
  }

  if (aiFields.length === 0) return [];

  onStatus?.("Mapping fields to PDF positions…");

  // Pre-deduplicate AI fields by canonicalFieldId
  const seenCanonicalIds = new Set<string>();
  const dedupedAiFields: AiIdentifiedField[] = [];
  for (const field of aiFields) {
    if (field.canonicalFieldId) {
      if (seenCanonicalIds.has(field.canonicalFieldId)) {
        console.log(`[Wrapkit AI] Skipping duplicate canonical ID: ${field.canonicalFieldId} ("${field.label}")`);
        continue;
      }
      seenCanonicalIds.add(field.canonicalFieldId);
    }
    dedupedAiFields.push(field);
  }

  const usedGeoIds = new Set<string>();
  const templateFields: TemplateField[] = [];

  // Batch-position all credit card type checkboxes first
  const cardCheckboxFields = dedupedAiFields.filter(
    (f) => f.fieldType === "checkbox" && f.canonicalFieldId && CREDIT_CARD_CHECKBOX_IDS.has(f.canonicalFieldId)
  );
  const cardPositions = positionCardTypeCheckboxes(cardCheckboxFields, context, usedGeoIds);

  for (let i = 0; i < dedupedAiFields.length; i++) {
    const aiField = dedupedAiFields[i];
    let coords: { x: number; y: number; width: number; height: number } | null = null;

    if (aiField.fieldType === "checkbox") {
      if (aiField.canonicalFieldId && cardPositions.has(aiField.canonicalFieldId)) {
        coords = cardPositions.get(aiField.canonicalFieldId)!;
      } else {
        coords = findCheckboxGeometry(aiField, context, usedGeoIds);
      }
      if (!coords) {
        console.log(`[Wrapkit AI] Could not locate checkbox for: "${aiField.label}"`);
        continue;
      }
    } else {
      const match = findLabelInContext(aiField, context);
      if (!match) {
        console.log(`[Wrapkit AI] Could not locate label for: "${aiField.label}" (nearbyText: "${aiField.nearbyText}")`);
        continue;
      }

      coords = findFillArea(match.line, match.labelItem, context, usedGeoIds);
      if (!coords) {
        console.log(`[Wrapkit AI] Could not find fill area for: "${aiField.label}"`);
        continue;
      }

      console.log(`[Wrapkit AI] Positioned "${aiField.label}" at (${Math.round(coords.x)}, ${Math.round(coords.y)}) ${Math.round(coords.width)}x${Math.round(coords.height)}`);
    }

    // Clamp to page bounds
    if (coords.x < 0) coords.x = 0;
    if (coords.y < 0) coords.y = 0;
    if (coords.x + coords.width > context.pageWidth) {
      coords.width = context.pageWidth - coords.x;
    }

    templateFields.push(buildTemplateField(aiField, coords, i, pageNumber));
  }

  console.log(`[Wrapkit AI] Positioned ${templateFields.length}/${dedupedAiFields.length} fields using PDF.js`);

  const supplementalCheckboxes = detectUnclaimedCheckboxes(context, usedGeoIds, pageNumber, templateFields.length);
  if (supplementalCheckboxes.length > 0) {
    console.log(`[Wrapkit AI] Found ${supplementalCheckboxes.length} additional checkbox(es) from geometry sweep`);
    templateFields.push(...supplementalCheckboxes);
  }

  return dedupeFields(templateFields);
}

/**
 * Scan for unclaimed box geometry (AcroForm checkboxes the AI didn't list).
 * For each unused box, look for a text label immediately to the right and
 * create a boolean-checkbox field.
 */
function detectUnclaimedCheckboxes(
  context: DetectionContext,
  usedGeoIds: Set<string>,
  pageNumber: number,
  startIndex: number
): TemplateField[] {
  const fields: TemplateField[] = [];
  let idx = startIndex;

  for (const geo of context.geometryCandidates) {
    if (usedGeoIds.has(geo.id)) continue;
    if (geo.kind !== "box" && !(geo.kind === "widget" && geo.width <= 28 && geo.height <= 28)) continue;
    if (geo.pageNumber !== pageNumber) continue;

    // Look for text labels to the right of this box on the same row
    const geoCenter = geo.y + geo.height / 2;
    const nearbyItems = context.textItems
      .filter(
        (item) =>
          item.pageNumber === pageNumber &&
          Math.abs((item.y + item.height / 2) - geoCenter) <= 15 &&
          item.x >= geo.x + geo.width - 6 &&
          item.text.length >= 2
      )
      .sort((a, b) => a.x - b.x);

    // Take the closest text item, or join adjacent items into a label
    if (nearbyItems.length === 0) continue;

    const firstItem = nearbyItems[0];
    // Allow up to 60px gap between checkbox and first text
    if (firstItem.x - (geo.x + geo.width) > 60) continue;

    // Build label from consecutive nearby text items on the same row
    let labelText = firstItem.text;
    let lastRight = firstItem.x + firstItem.width;
    for (let j = 1; j < nearbyItems.length && j < 12; j++) {
      const gap = nearbyItems[j].x - lastRight;
      if (gap > 20) break;
      labelText += " " + nearbyItems[j].text;
      lastRight = nearbyItems[j].x + nearbyItems[j].width;
    }
    labelText = labelText.trim();

    // Skip if this looks like a credit card type checkbox
    const lbl = labelText.toLowerCase();
    if (["visa", "mastercard", "master card", "mc", "discover", "amex", "american express"].some(
      (brand) => lbl.includes(brand)
    )) continue;

    usedGeoIds.add(geo.id);
    fields.push({
      id: `ai-field-${Date.now()}-sweep-${idx}`,
      label: labelText,
      mappedProjectKey: "__prompt__",
      pageNumber,
      x: geo.x,
      y: geo.y,
      width: geo.width,
      height: geo.height,
      confidence: 0.8,
      fieldType: "checkbox",
      fieldKind: "boolean-checkbox",
      detectionSource: "text-line",
      promptLabel: labelText,
    });
    idx++;
  }

  return fields;
}

/**
 * Remove fields that overlap spatially or share a canonical ID.
 */
function dedupeFields(fields: TemplateField[]): TemplateField[] {
  const result: TemplateField[] = [];
  const usedCanonicalIds = new Set<string>();

  for (const field of fields) {
    // Skip if we already have a field with this canonical ID (unless it allows duplicates like signatures)
    if (field.canonicalFieldId) {
      const def = CANONICAL_FIELD_DEFINITIONS.find((d) => d.id === field.canonicalFieldId);
      if (!def?.allowDuplicates && usedCanonicalIds.has(field.canonicalFieldId)) {
        continue;
      }
    }

    // Skip if spatially overlapping with an existing field
    const overlapping = result.find(
      (existing) =>
        Math.abs(existing.x - field.x) < 12 &&
        Math.abs(existing.y - field.y) < 12 &&
        existing.fieldType === field.fieldType
    );
    if (overlapping) continue;

    result.push(field);
    if (field.canonicalFieldId) {
      usedCanonicalIds.add(field.canonicalFieldId);
    }
  }
  return result;
}
