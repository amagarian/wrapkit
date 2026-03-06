import * as pdfjsLib from "pdfjs-dist";
import type { TemplateField, Project } from "@/types";

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface DetectedLabel {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pageNumber: number;
}

const CREDIT_CARD_CHECKBOXES: Record<string, string> = {
  "visa": "visa",
  "mastercard": "mastercard",
  "master card": "mastercard", 
  "discover": "discover",
  "american express": "amex",
  "american": "amex",
  "amex": "amex",
};

// Words that are part of checkbox labels and should not be detected as text fields
const CHECKBOX_WORDS = new Set(["visa", "mastercard", "discover", "american", "express", "amex"]);

const LABEL_TO_PROJECT_KEY: Record<string, keyof Project> = {
  // Production company
  "production company": "productionCompany",
  "production co": "productionCompany",
  "prod co": "productionCompany",
  "business": "productionCompany",
  
  // Job/project name
  "job name": "jobName",
  "project name": "jobName",
  "show": "jobName",
  
  // Job number
  "job number": "jobNumber",
  "job #": "jobNumber",
  "job no": "jobNumber",
  "job no.": "jobNumber",
  
  // PO Number (maps to jobNumber for now, but could be separate field)
  "po number": "jobNumber",
  "po #": "jobNumber",
  "po no": "jobNumber",
  "po no.": "jobNumber",
  
  // Address
  "credit card billing address": "billingAddress",
  "billing address": "billingAddress",
  "bill to": "billingAddress",
  
  // Producer
  "producer": "producer",
  "producer name": "producer",
  
  // Email
  "email": "email",
  "e-mail": "email",
  "email address": "email",
  
  // Phone
  "phone numbers": "phone",
  "phone number": "phone",
  "phone": "phone",
  "telephone": "phone",
  "tel": "phone",
  "cell": "phone",
  "mobile": "phone",
  
  // Credit card number
  "credit card number": "creditCardNumber",
  "credit card": "creditCardNumber",
  "card number": "creditCardNumber",
  "cc #": "creditCardNumber",
  "card #": "creditCardNumber",
  
  // Cardholder
  "name of cardholder": "creditCardHolder",
  "cardholder name": "creditCardHolder",
  "cardholder": "creditCardHolder",
  "card holder": "creditCardHolder",
  "name on card": "creditCardHolder",
  "signature of cardholder": "creditCardHolder",
  
  // Expiration
  "expiration date": "expDate",
  "exp date": "expDate",
  "expiration": "expDate",
  "expiry": "expDate",
  "exp": "expDate",
  
  // Security code
  "security code": "ccv",
  "cvv": "ccv",
  "cvc": "ccv",
  "ccv": "ccv",
};

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function findBestMatch(labelText: string): keyof Project | null {
  const normalized = normalizeText(labelText);
  
  // Skip if it looks like body text (too long or contains certain phrases)
  if (normalized.length > 40) return null;
  if (normalized.includes("hereby") || normalized.includes("agree")) return null;
  if (normalized.includes("please") || normalized.includes("must be")) return null;
  
  // Skip checkbox-related words - these are handled separately as checkboxes
  if (CHECKBOX_WORDS.has(normalized)) return null;
  
  for (const [pattern, key] of Object.entries(LABEL_TO_PROJECT_KEY)) {
    if (normalized.includes(pattern) || pattern.includes(normalized)) {
      return key;
    }
  }
  
  return null;
}

function isLikelyFormLabel(text: string): boolean {
  const trimmed = text.trim();
  // Labels often end with colon or underscore
  if (trimmed.endsWith(":") || trimmed.endsWith("_")) return true;
  // Contains underscores (fill line)
  if (trimmed.includes("_")) return true;
  // Ends with period (like "Job No." or "PO No.")
  if (trimmed.endsWith(".") && trimmed.length < 20) return true;
  // Short text that matches our known labels
  if (trimmed.length < 35 && findBestMatch(trimmed)) return true;
  // Short text followed by colon pattern (covers most form labels)
  if (trimmed.length < 25) return true;
  return false;
}

function extractLabelOnly(text: string): { label: string; underlineStart: number } {
  // Remove trailing underscores and find where the actual label ends
  const trimmed = text.trim();
  
  // Find where underscores start (the fill line)
  const underscoreMatch = trimmed.match(/[_]{2,}/);
  if (underscoreMatch && underscoreMatch.index !== undefined) {
    const labelPart = trimmed.slice(0, underscoreMatch.index).trim();
    return { 
      label: labelPart.replace(/:$/, "").trim(), 
      underlineStart: underscoreMatch.index 
    };
  }
  
  // No underscores, just clean up the label
  return { 
    label: trimmed.replace(/:$/, "").trim(), 
    underlineStart: -1 
  };
}

export async function detectFieldsFromPdf(
  pdfBytes: Uint8Array,
  pageNumber: number = 1
): Promise<TemplateField[]> {
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: bytesCopy });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);
  
  const viewport = page.getViewport({ scale: 1 });
  const pageHeight = viewport.height;
  const pageWidth = viewport.width;
  
  const textContent = await page.getTextContent();
  const textItems = textContent.items as TextItem[];
  
  const detectedLabels: DetectedLabel[] = [];
  
  for (const item of textItems) {
    if (!item.str || item.str.trim().length < 2) continue;
    
    const transform = item.transform;
    const xPdf = transform[4];
    const yPdf = transform[5];
    
    // Convert PDF coords (bottom-left origin) to screen coords (top-left origin)
    const x = xPdf;
    const y = pageHeight - yPdf;
    
    const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
    const width = item.width || fontSize * item.str.length * 0.6;
    const height = fontSize;
    
    detectedLabels.push({
      text: item.str.trim(),
      x,
      y: y - height,
      width,
      height,
      pageNumber,
    });
  }
  
  // Sort labels by Y position (top to bottom), then X (left to right)
  detectedLabels.sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) < 5) return a.x - b.x; // Same line
    return yDiff;
  });
  
  const fields: TemplateField[] = [];
  const usedKeys = new Set<string>();
  let fieldId = 1;
  
  
  // Group labels by line (Y position) to detect multiple fields on same line
  const labelsByLine = new Map<number, DetectedLabel[]>();
  for (const label of detectedLabels) {
    const yKey = Math.round(label.y / 8) * 8; // Group by ~8px bands (same line)
    if (!labelsByLine.has(yKey)) labelsByLine.set(yKey, []);
    labelsByLine.get(yKey)!.push(label);
  }
  
  // Sort labels within each line by X position
  for (const labels of labelsByLine.values()) {
    labels.sort((a, b) => a.x - b.x);
  }

  for (const label of detectedLabels) {
    // Skip if not a form label
    if (!isLikelyFormLabel(label.text)) continue;
    
    // Check if this label contains multiple fields (e.g., "Job Name : ___ Job No. : ___ PO No. : ___")
    // Split by common separators that indicate multiple fields
    const multiFieldPattern = /([A-Za-z\s]+(?::|\.)\s*_{2,})/g;
    const subFields = label.text.match(multiFieldPattern);
    
    if (subFields && subFields.length > 1) {
      // Multiple fields in one text item - process each separately
      const charWidth = label.width / label.text.length;
      
      for (const subField of subFields) {
        const subFieldStart = label.text.indexOf(subField);
        const subFieldX = label.x + (subFieldStart * charWidth);
        const subFieldWidth = subField.length * charWidth;
        
        const { label: cleanLabel, underlineStart } = extractLabelOnly(subField);
        const projectKey = findBestMatch(subField);
        const finalProjectKey = projectKey && !usedKeys.has(projectKey) ? projectKey : "";
        if (projectKey && !usedKeys.has(projectKey)) {
          usedKeys.add(projectKey);
        }
        
        let fieldX: number;
        let fieldWidth: number;
        
        if (underlineStart > 0) {
          const charRatio = underlineStart / subField.length;
          fieldX = subFieldX + (subFieldWidth * charRatio);
          fieldWidth = subFieldWidth * (1 - charRatio);
        } else {
          fieldX = subFieldX + subFieldWidth * 0.4;
          fieldWidth = subFieldWidth * 0.55;
        }
        
        fields.push({
          id: `detected-${fieldId++}`,
          label: cleanLabel || subField.slice(0, 15),
          mappedProjectKey: finalProjectKey,
          pageNumber: label.pageNumber,
          x: Math.round(fieldX),
          y: Math.round(label.y),
          width: Math.round(fieldWidth),
          height: Math.round(Math.max(12, label.height)),
          confidence: finalProjectKey ? 0.7 : 0.5,
          fieldType: "text",
        });
      }
      continue; // Skip the normal single-field processing
    }
    
    const projectKey = findBestMatch(label.text);
    
    // Allow fields even without a project key match, or if key is already used
    // User can manually map them later
    const finalProjectKey = projectKey && !usedKeys.has(projectKey) ? projectKey : "";
    if (projectKey && !usedKeys.has(projectKey)) {
      usedKeys.add(projectKey);
    }
    
    // Extract the actual label text and find where underscores start
    const { label: cleanLabel, underlineStart } = extractLabelOnly(label.text);
    
    let fieldX: number;
    let fieldWidth: number;
    
    // Find the next label on the same line (if any) to limit field width
    const yKey = Math.round(label.y / 8) * 8;
    const lineLabels = labelsByLine.get(yKey) || [];
    const currentIndex = lineLabels.findIndex(l => l.x === label.x && l.text === label.text);
    const nextLabel = currentIndex >= 0 && currentIndex < lineLabels.length - 1 
      ? lineLabels[currentIndex + 1] 
      : null;
    
    if (underlineStart > 0) {
      // We know where the underline starts in the text
      const charRatio = underlineStart / label.text.length;
      fieldX = label.x + (label.width * charRatio);
      fieldWidth = label.width * (1 - charRatio);
    } else {
      // No underscores detected, position after the label
      fieldX = label.x + label.width + 5;
      
      // Determine the right edge of the field
      let rightEdge: number;
      if (nextLabel) {
        // Stop before the next label on the same line
        rightEdge = nextLabel.x - 10;
      } else {
        // No next label, extend to page margin
        rightEdge = pageWidth - 30;
      }
      
      fieldWidth = Math.max(50, rightEdge - fieldX);
    }
    
    // Field Y: align with the label baseline
    const fieldY = label.y;
    
    // Height: match the label height
    const fieldHeight = Math.max(12, label.height);
    
    fields.push({
      id: `detected-${fieldId++}`,
      label: cleanLabel || label.text.slice(0, 20),
      mappedProjectKey: finalProjectKey,
      pageNumber: label.pageNumber,
      x: Math.round(fieldX),
      y: Math.round(fieldY),
      width: Math.round(fieldWidth),
      height: Math.round(fieldHeight),
      confidence: finalProjectKey ? 0.75 + Math.random() * 0.2 : 0.5,
      fieldType: "text",
    });
  }
  
  // Detect credit card type checkboxes
  // Look for VISA, MasterCard, Discover, American Express text
  const addedCardTypes = new Set<string>();
  
  // Build a map of text on each line (by Y position) to help detect split text like "American Express"
  const lineTexts = new Map<number, { text: string; x: number; label: DetectedLabel }[]>();
  for (const label of detectedLabels) {
    const yKey = Math.round(label.y / 5) * 5; // Group by ~5px bands
    if (!lineTexts.has(yKey)) lineTexts.set(yKey, []);
    lineTexts.get(yKey)!.push({ text: label.text.toLowerCase().trim(), x: label.x, label });
  }
  
  // Check each line for credit card types
  for (const [, items] of lineTexts) {
    // Sort items by X position (left to right)
    items.sort((a, b) => a.x - b.x);
    
    // Combine all text on this line
    const lineText = items.map(i => i.text).join(" ");
    
    // Check for American Express specifically (often split)
    if (!addedCardTypes.has("amex") && lineText.includes("american") && lineText.includes("express")) {
      // Find the "Express" text item (the last part) to position the checkbox AFTER it
      const expressItem = items.find(i => i.text.toLowerCase().includes("express"));
      if (expressItem) {
        addedCardTypes.add("amex");
        // The checkbox □ is AFTER "American Express" - position at the end of the text
        fields.push({
          id: `checkbox-amex-${fields.length}`,
          label: "American Express",
          mappedProjectKey: "creditCardType",
          pageNumber: expressItem.label.pageNumber,
          x: Math.round(expressItem.label.x + expressItem.label.width + 3), // After the text
          y: Math.round(expressItem.label.y),
          width: 10,
          height: 10,
          confidence: 0.9,
          fieldType: "checkbox",
          checkboxValue: "amex",
        });
      }
    }
  }
  
  // Now check individual labels for the other card types
  for (const label of detectedLabels) {
    const rawText = label.text;
    const cleaned = rawText
      .replace(/[□☐☑✓✗]/g, "")
      .toLowerCase()
      .trim();
    
    // Skip "express" alone since we handle "American Express" above
    if (cleaned === "express") continue;
    
    for (const [pattern, cardType] of Object.entries(CREDIT_CARD_CHECKBOXES)) {
      // Skip amex (handled above) and if already added
      if (cardType === "amex") continue;
      if (addedCardTypes.has(cardType)) continue;
      
      const exactMatch = cleaned === pattern;
      const startsWithPattern = cleaned.startsWith(pattern);
      const containsPattern = cleaned.includes(pattern);
      const isShortEnough = cleaned.length < 40;
      
      if (exactMatch || startsWithPattern || (containsPattern && isShortEnough)) {
        addedCardTypes.add(cardType);
        
        // The checkbox □ is AFTER the card name (e.g., "VISA □")
        // Position at the END of the text label
        fields.push({
          id: `checkbox-${cardType}-${fields.length}`,
          label: label.text.trim(),
          mappedProjectKey: "creditCardType",
          pageNumber: label.pageNumber,
          x: Math.round(label.x + label.width + 3), // Position AFTER the text
          y: Math.round(label.y),
          width: 10,
          height: 10,
          confidence: 0.9,
          fieldType: "checkbox",
          checkboxValue: cardType,
        });
        break;
      }
    }
  }
  
  console.log("Detected card types:", Array.from(addedCardTypes));
  
  // Debug: log all detected text fields
  const textFields = fields.filter(f => f.fieldType === "text" || !f.fieldType);
  console.log("Text fields:", textFields.map(f => ({
    label: f.label,
    key: f.mappedProjectKey,
    x: f.x,
    y: f.y,
    width: f.width
  })));
  
  // Debug: log checkbox fields
  const checkboxFields = fields.filter(f => f.fieldType === "checkbox");
  console.log("Checkbox fields:", checkboxFields.map(f => ({
    label: f.label,
    value: f.checkboxValue,
    x: f.x,
    y: f.y
  })));
  
  // Sort fields top to bottom, then left to right
  fields.sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) < 10) return a.x - b.x;
    return yDiff;
  });
  
  return fields;
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
