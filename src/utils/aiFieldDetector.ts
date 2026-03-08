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
}

interface AiDetectionResponse {
  fields: AiIdentifiedField[];
  pageDescription?: string;
}

const VALID_CANONICAL_IDS = new Set<string>(
  CANONICAL_FIELD_DEFINITIONS.map((d) => d.id)
);

function getEdgeFunctionUrl(): string {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  if (!supabaseUrl) throw new Error("VITE_SUPABASE_URL not configured");
  return `${supabaseUrl}/functions/v1/detect-fields`;
}

function getSupabaseAnonKey(): string {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!key) throw new Error("VITE_SUPABASE_ANON_KEY not configured");
  return key;
}

async function renderPageToBase64(pdfBytes: Uint8Array, pageNumber: number): Promise<string> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);

  const scale = 150 / 72;
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
  const url = getEdgeFunctionUrl();
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
 * The fill area should be to the right of or below the label, NOT overlapping the label.
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

  // Search for geometry (underlines/widgets) near this label
  type ScoredGeo = { geo: GeometryCandidate; score: number };
  const candidates: ScoredGeo[] = [];

  for (const geo of context.geometryCandidates) {
    if (geo.kind === "box") continue;
    if (usedGeoIds.has(geo.id)) continue;

    const yDist = Math.abs(geo.y - labelY);
    if (yDist > 30) continue;

    // The geometry must start AFTER the label text (with small tolerance)
    // This prevents placing the field on top of the label
    const geoStartsAfterLabel = geo.x >= labelEndX - 8;
    const geoEndsAfterLabel = geo.x + geo.width > labelEndX + 5;

    if (!geoStartsAfterLabel && !geoEndsAfterLabel) continue;

    // Skip geometry that extends past the next label on this line
    if (labelItem && geo.x > nextLabelX + 5) continue;

    // Score: prefer close y-distance, starts right after label, reasonable width
    let score = 100;
    score -= yDist * 3;
    score -= Math.abs(geo.x - labelEndX) * 0.5;

    // Bonus for same-row geometry starting right after label
    if (yDist <= 8 && geo.x >= labelEndX - 4 && geo.x <= labelEndX + 40) {
      score += 50;
    }

    // Bonus for reasonable width
    if (geo.width >= 40 && geo.width <= 300) score += 10;

    // Penalty for geometry that overlaps the label text
    if (geo.x < labelStartX + 5) score -= 40;

    candidates.push({ geo, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0 && candidates[0].score > 20) {
    const bestGeo = candidates[0].geo;
    usedGeoIds.add(bestGeo.id);

    // Ensure the field box starts after the label, not on it
    const fieldX = Math.max(bestGeo.x, labelEndX + 2);
    const fieldWidth = bestGeo.width - Math.max(0, fieldX - bestGeo.x);

    // Underlines sit at the text baseline; widgets may also sit low.
    // Apply a baseline correction similar to the heuristic detector's
    // createUnderlineFieldBox so fields cover the text rendering area.
    const baselinePad = bestGeo.kind === "underline" ? 12 : 4;
    const correctedGeoY = Math.max(0, bestGeo.y - baselinePad);
    const fieldY = Math.min(correctedGeoY, labelY);
    const geoBottom = bestGeo.y + bestGeo.height;
    const fieldHeight = Math.max(geoBottom - fieldY, labelLine.height, 14);

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
      height: Math.max(labelLine.height, 14),
    };
  }

  // Last resort: fill area below the label
  return {
    x: labelLine.x,
    y: labelLine.y + labelLine.height + 4,
    width: Math.min(context.pageWidth - labelLine.x - 40, context.pageWidth * 0.5),
    height: Math.max(labelLine.height, 14),
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
  };
}

export async function detectFieldsWithAI(
  pdfBytes: Uint8Array,
  pageNumber: number = 1,
  onStatus?: (status: string) => void
): Promise<TemplateField[]> {
  console.log("[Wrapkit AI] Starting hybrid AI+PDF.js detection...");
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
      // Use pre-computed card type positions
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

  // Sweep for any remaining unused box geometry that the AI missed.
  // These are likely checkboxes that the model failed to list individually.
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
