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
  "amex": "amex",
};

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
  "po number": "jobNumber",
  "po #": "jobNumber",
  "po no": "jobNumber",
  
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
  // Short text that matches our known labels
  if (trimmed.length < 35 && findBestMatch(trimmed)) return true;
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
  
  
  for (const label of detectedLabels) {
    // Skip if not a form label
    if (!isLikelyFormLabel(label.text)) continue;
    
    const projectKey = findBestMatch(label.text);
    if (!projectKey || usedKeys.has(projectKey)) continue;
    
    usedKeys.add(projectKey);
    
    // Extract the actual label text and find where underscores start
    const { label: cleanLabel, underlineStart } = extractLabelOnly(label.text);
    
    let fieldX: number;
    let fieldWidth: number;
    
    if (underlineStart > 0) {
      // We know where the underline starts in the text
      // Estimate X position based on character ratio
      const charRatio = underlineStart / label.text.length;
      fieldX = label.x + (label.width * charRatio);
      // Width extends to where the text/underline ends
      fieldWidth = label.width * (1 - charRatio);
    } else {
      // No underscores detected, position after the label
      fieldX = label.x + label.width + 5;
      const rightEdge = pageWidth - 30;
      fieldWidth = Math.max(100, rightEdge - fieldX);
    }
    
    // Field Y: align with the label baseline
    const fieldY = label.y;
    
    // Height: match the label height
    const fieldHeight = Math.max(12, label.height);
    
    fields.push({
      id: `detected-${fieldId++}`,
      label: cleanLabel || label.text.slice(0, 20),
      mappedProjectKey: projectKey,
      pageNumber: label.pageNumber,
      x: Math.round(fieldX),
      y: Math.round(fieldY),
      width: Math.round(fieldWidth),
      height: Math.round(fieldHeight),
      confidence: 0.75 + Math.random() * 0.2,
      fieldType: "text",
    });
  }
  
  // Detect credit card type checkboxes
  // Look for VISA, MasterCard, Discover, American Express text
  for (const label of detectedLabels) {
    const normalized = label.text.toLowerCase().trim();
    
    for (const [pattern, cardType] of Object.entries(CREDIT_CARD_CHECKBOXES)) {
      if (normalized === pattern || normalized.startsWith(pattern + " ")) {
        // Found a credit card type label - create a checkbox field
        // Position the checkbox slightly to the left of the text (where the □ would be)
        fields.push({
          id: `checkbox-${cardType}-${fields.length}`,
          label: label.text.trim(),
          mappedProjectKey: "creditCardType",
          pageNumber: label.pageNumber,
          x: Math.round(label.x - 15), // Checkbox is typically left of the label
          y: Math.round(label.y),
          width: 12,
          height: 12,
          confidence: 0.9,
          fieldType: "checkbox",
          checkboxValue: cardType,
        });
        break;
      }
    }
  }
  
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
