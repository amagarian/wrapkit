import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const AZURE_DOCAI_ENDPOINT = Deno.env.get("AZURE_DOCAI_ENDPOINT");
const AZURE_DOCAI_KEY = Deno.env.get("AZURE_DOCAI_KEY");
const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --------------- Azure Document Intelligence ---------------

interface AzureKeyValuePair {
  key: {
    content: string;
    boundingRegions?: { pageNumber: number; polygon: number[] }[];
  };
  value?: {
    content?: string;
    boundingRegions?: { pageNumber: number; polygon: number[] }[];
  };
  confidence: number;
}

interface AzureSelectionMark {
  state: "selected" | "unselected";
  polygon: number[];
  confidence: number;
  span?: { offset: number; length: number };
}

interface AzurePage {
  pageNumber: number;
  width: number;
  height: number;
  unit: string;
  selectionMarks?: AzureSelectionMark[];
}

interface ExtractedField {
  label: string;
  valueText: string;
  isCheckbox: boolean;
  isChecked: boolean;
  boundingBox: { x: number; y: number; width: number; height: number };
}

function polygonToBox(
  polygon: number[],
  pageWidth: number,
  pageHeight: number
): { x: number; y: number; width: number; height: number } {
  if (!polygon || polygon.length < 8) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < polygon.length; i += 2) {
    xs.push(polygon[i]);
    ys.push(polygon[i + 1]);
  }
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);

  // Normalize to 0-1 range using page dimensions (in inches)
  return {
    x: xMin / pageWidth,
    y: yMin / pageHeight,
    width: (xMax - xMin) / pageWidth,
    height: (yMax - yMin) / pageHeight,
  };
}

function extractFormFields(analyzeResult: Record<string, unknown>): ExtractedField[] {
  const pages = (analyzeResult.pages as AzurePage[]) || [];
  if (pages.length === 0) return [];

  const page = pages[0];
  const pageWidth = page.width;
  const pageHeight = page.height;
  const results: ExtractedField[] = [];

  // Extract key-value pairs (text fields)
  const kvPairs = (analyzeResult.keyValuePairs as AzureKeyValuePair[]) || [];
  for (const kv of kvPairs) {
    if (!kv.key?.content) continue;
    // Only process pairs on page 1
    const keyPage = kv.key.boundingRegions?.[0]?.pageNumber ?? 1;
    if (keyPage !== 1) continue;

    const label = kv.key.content.trim();
    const valueText = kv.value?.content?.trim() ?? "";

    // Use the VALUE bounding region for positioning (that's where we want to fill)
    // Fall back to the KEY bounding region if no value region
    const valuePoly = kv.value?.boundingRegions?.[0]?.polygon;
    const keyPoly = kv.key.boundingRegions?.[0]?.polygon;
    const poly = valuePoly ?? keyPoly;

    if (!poly) continue;

    const boundingBox = polygonToBox(poly, pageWidth, pageHeight);

    // Skip if the value area is tiny (likely a detection artifact)
    if (boundingBox.width < 0.01 && boundingBox.height < 0.005) continue;

    results.push({
      label,
      valueText,
      isCheckbox: false,
      isChecked: false,
      boundingBox,
    });
  }

  // Extract selection marks (checkboxes)
  const selectionMarks = page.selectionMarks ?? [];
  for (const mark of selectionMarks) {
    if (!mark.polygon || mark.polygon.length < 8) continue;

    const boundingBox = polygonToBox(mark.polygon, pageWidth, pageHeight);

    // Find nearby text to use as the checkbox label
    let nearbyLabel = mark.state === "selected" ? "Checked" : "Unchecked";

    // Look through key-value pairs to find any that reference this area
    for (const kv of kvPairs) {
      const keyPoly = kv.key.boundingRegions?.[0]?.polygon;
      if (!keyPoly) continue;
      const keyBox = polygonToBox(keyPoly, pageWidth, pageHeight);
      const yDist = Math.abs(keyBox.y - boundingBox.y);
      const xDist = boundingBox.x - (keyBox.x + keyBox.width);
      // Checkbox is typically to the left of or very near its label
      if (yDist < 0.03 && xDist > -0.05 && xDist < 0.15) {
        nearbyLabel = kv.key.content.trim();
        break;
      }
    }

    // Also check against page words for nearby labels
    const words = ((page as Record<string, unknown>).words as { content: string; polygon: number[] }[]) ?? [];
    if (nearbyLabel === "Checked" || nearbyLabel === "Unchecked") {
      let bestDist = Infinity;
      for (const word of words) {
        if (!word.polygon || word.polygon.length < 2) continue;
        const wordX = word.polygon[0] / pageWidth;
        const wordY = word.polygon[1] / pageHeight;
        const dist = Math.sqrt(
          Math.pow(wordX - (boundingBox.x + boundingBox.width), 2) +
          Math.pow(wordY - boundingBox.y, 2)
        );
        if (dist < bestDist && dist < 0.1 && wordX > boundingBox.x - 0.02) {
          bestDist = dist;
          nearbyLabel = word.content;
        }
      }
    }

    results.push({
      label: nearbyLabel,
      valueText: "",
      isCheckbox: true,
      isChecked: mark.state === "selected",
      boundingBox,
    });
  }

  return results;
}

// --------------- Gemini classification ---------------

const CLASSIFICATION_PROMPT = `You are a field classifier for film & TV production forms (credit card authorizations, purchase orders, start paperwork, petty cash envelopes, deal memos, etc.).

You receive a list of form field labels extracted from a document. For each label, classify it into the best matching canonical field ID from the list below. If no canonical ID matches, return null.

Also determine the fieldType ("text" or "checkbox") and fieldKind.

## CANONICAL FIELD IDs

TEXT:
- "jobName" — Job Name, Project Name, Show Name, Show/Project
- "jobNumber" — Job No., Job Number, Job #, PO/Job #
- "poNumber" — PO No., PO Number, Purchase Order #, Order #, Order No., Invoice Number
- "authorizationDate" — Date (near signature or footer area, not Exp Date)
- "productionCompany" — Production Company, Company, Company Name, Company/Contact, Account/Company Name
- "billingAddress" — Billing Address, Mailing Address, Address
- "billingCity" — City
- "billingState" — State, St
- "billingZipCode" — Zip, Zip Code, Postal Code
- "producer" — Producer, Contact, Contact Name, Authorized By
- "email" — Email, Email Address, E-mail
- "phone" — Phone, Phone #, Phone Number, Telephone
- "creditCardHolder" — Cardholder Name, Name on Card, Name (when in credit card section)
- "cardholderSignature" — Signature (a blank signature area, not printed text)
- "creditCardNumber" — Credit Card Number, Card #, CC#, Card Number, Account #
- "expDate" — Exp Date, Expiration Date, Exp., MM/YY
- "ccv" — CVV, CVC, CID, Security Code, Verification Code

CHECKBOXES (credit card type):
- "creditCardTypeVisa" — Visa checkbox
- "creditCardTypeMastercard" — MasterCard / MC checkbox
- "creditCardTypeDiscover" — Discover checkbox
- "creditCardTypeAmex" — AMEX / American Express checkbox

## FIELD KINDS
- "text" — standard single-line text input
- "multiline" — multi-line text area
- "date" — date field
- "signature" — signature line/area
- "checkbox-group" — checkbox that belongs to a group (like credit card type)
- "boolean-checkbox" — standalone yes/no checkbox

## RULES
- "Invoice Number" → "poNumber"
- "Customer Name" or "Name" in a credit card section → "creditCardHolder"
- "Account/Company Name" or "Company" → "productionCompany"
- "Print Name" near a signature → "creditCardHolder"
- "Date" near a signature → "authorizationDate"
- "Exp Date" or "Expiration" → "expDate" (NOT "authorizationDate")
- "CVV#" or "CVV" → "ccv"
- For credit card type checkboxes (Visa, MC, Amex, Discover), set groupId="creditCardType" and checkboxValue to the brand name
- Standalone checkboxes like "Keep on file" → canonicalFieldId: null, fieldKind: "boolean-checkbox"
- Fields you can't classify → canonicalFieldId: null`;

interface ClassifiedField {
  index: number;
  canonicalFieldId: string | null;
  fieldType: "text" | "checkbox";
  fieldKind: string;
  label: string;
  checkboxValue?: string | null;
  groupId?: string | null;
}

async function classifyFieldsWithGemini(
  fields: ExtractedField[]
): Promise<ClassifiedField[]> {
  if (!GOOGLE_AI_API_KEY) {
    throw new Error("GOOGLE_AI_API_KEY not configured");
  }

  const fieldList = fields
    .map((f, i) => {
      const type = f.isCheckbox
        ? `[checkbox, ${f.isChecked ? "checked" : "unchecked"}]`
        : "[text]";
      return `  ${i}. "${f.label}" ${type}`;
    })
    .join("\n");

  const userPrompt = `Classify each of these form fields detected on a production document:\n\n${fieldList}\n\nReturn a JSON array with one entry per field, in the same order. Each entry must have: index, canonicalFieldId (string or null), fieldType, fieldKind, label (cleaned-up human-readable label), checkboxValue (for credit card type checkboxes), groupId (for grouped checkboxes).`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_API_KEY}`;

  const resp = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CLASSIFICATION_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              index: { type: "INTEGER" },
              canonicalFieldId: { type: "STRING", nullable: true },
              fieldType: { type: "STRING", enum: ["text", "checkbox"] },
              fieldKind: {
                type: "STRING",
                enum: [
                  "text",
                  "multiline",
                  "date",
                  "signature",
                  "checkbox-group",
                  "boolean-checkbox",
                ],
              },
              label: { type: "STRING" },
              checkboxValue: { type: "STRING", nullable: true },
              groupId: { type: "STRING", nullable: true },
            },
            required: [
              "index",
              "canonicalFieldId",
              "fieldType",
              "fieldKind",
              "label",
            ],
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini classification error (${resp.status}): ${errText}`);
  }

  const result = await resp.json();
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini classification response");

  return JSON.parse(text);
}

// --------------- Main handler ---------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!AZURE_DOCAI_ENDPOINT || !AZURE_DOCAI_KEY) {
    return new Response(
      JSON.stringify({ error: "Missing Azure configuration (AZURE_DOCAI_ENDPOINT or AZURE_DOCAI_KEY)" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!GOOGLE_AI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_AI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { image } = await req.json();

    if (!image) {
      return new Response(
        JSON.stringify({ error: "Missing required field: image" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Stage 1: Azure Document Intelligence (async API) ---
    console.log("[detect-fields-v4] Stage 1: Starting Azure Document Intelligence analysis...");

    const endpoint = AZURE_DOCAI_ENDPOINT.replace(/\/$/, "");
    const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-document:analyze?api-version=2024-11-30`;

    const startResp = await fetch(analyzeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": AZURE_DOCAI_KEY,
      },
      body: JSON.stringify({ base64Source: image }),
    });

    if (!startResp.ok) {
      const errText = await startResp.text();
      console.error("Azure start error:", startResp.status, errText);
      return new Response(
        JSON.stringify({ error: `Azure error: ${startResp.status}`, detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const operationUrl = startResp.headers.get("Operation-Location");
    if (!operationUrl) {
      return new Response(
        JSON.stringify({ error: "Azure did not return an Operation-Location header" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[detect-fields-v4] Polling for Azure results...");

    // Poll for completion (Azure async pattern)
    let analyzeResult: Record<string, unknown> | null = null;
    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const pollResp = await fetch(operationUrl, {
        headers: { "Ocp-Apim-Subscription-Key": AZURE_DOCAI_KEY },
      });

      if (!pollResp.ok) {
        const errText = await pollResp.text();
        throw new Error(`Azure poll error (${pollResp.status}): ${errText}`);
      }

      const pollResult = await pollResp.json();
      const status = pollResult.status as string;

      if (status === "succeeded") {
        analyzeResult = pollResult.analyzeResult as Record<string, unknown>;
        console.log(`[detect-fields-v4] Azure analysis succeeded after ${attempt + 1} poll(s)`);
        break;
      }

      if (status === "failed") {
        const errorDetail = JSON.stringify(pollResult.error ?? {});
        throw new Error(`Azure analysis failed: ${errorDetail}`);
      }

      // status is "running" or "notStarted" — keep polling
    }

    if (!analyzeResult) {
      throw new Error("Azure analysis timed out after 30 seconds");
    }

    const extractedFields = extractFormFields(analyzeResult);
    console.log(`[detect-fields-v4] Azure found ${extractedFields.length} form field(s)`);

    if (extractedFields.length === 0) {
      return new Response(
        JSON.stringify({ fields: [], pageDescription: "No form fields detected" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Stage 2: Gemini classification ---
    console.log("[detect-fields-v4] Stage 2: Classifying fields with Gemini...");

    const classifications = await classifyFieldsWithGemini(extractedFields);
    console.log(`[detect-fields-v4] Gemini classified ${classifications.length} field(s)`);

    // --- Merge results ---
    const mergedFields = extractedFields.map((ef, i) => {
      const classification = classifications.find((c) => c.index === i) ?? {
        index: i,
        canonicalFieldId: null,
        fieldType: ef.isCheckbox ? ("checkbox" as const) : ("text" as const),
        fieldKind: ef.isCheckbox ? "boolean-checkbox" : "text",
        label: ef.label,
        checkboxValue: null,
        groupId: null,
      };

      return {
        label: classification.label || ef.label,
        canonicalFieldId: classification.canonicalFieldId,
        fieldType: classification.fieldType,
        fieldKind: classification.fieldKind,
        checkboxValue: classification.checkboxValue ?? null,
        groupId: classification.groupId ?? null,
        boundingBox: ef.boundingBox,
        isCheckbox: ef.isCheckbox,
        isChecked: ef.isChecked,
      };
    });

    return new Response(
      JSON.stringify({ fields: mergedFields }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("detect-fields-v4 error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
