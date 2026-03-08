import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GCP_SERVICE_ACCOUNT_JSON_B64 = Deno.env.get("GCP_SERVICE_ACCOUNT_JSON_B64");
const GCP_PROJECT_ID = Deno.env.get("GCP_PROJECT_ID");
const DOCAI_PROCESSOR_ID = Deno.env.get("DOCAI_PROCESSOR_ID");
const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");

function getServiceAccountJson(): string | null {
  if (GCP_SERVICE_ACCOUNT_JSON_B64) {
    try {
      return atob(GCP_SERVICE_ACCOUNT_JSON_B64);
    } catch {
      return null;
    }
  }
  return null;
}

const DOCAI_LOCATION = "us";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --------------- JWT / Google Auth helpers ---------------

function base64url(data: Uint8Array): string {
  let b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64url(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN .*-----/, "")
    .replace(/-----END .*-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function createSignedJwt(
  serviceAccount: { client_email: string; private_key: string },
  scope: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = textToBase64url(JSON.stringify(header));
  const encodedPayload = textToBase64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(serviceAccount.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

async function getAccessToken(
  serviceAccount: { client_email: string; private_key: string }
): Promise<string> {
  const jwt = await createSignedJwt(
    serviceAccount,
    "https://www.googleapis.com/auth/cloud-platform"
  );

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${errText}`);
  }

  const { access_token } = await resp.json();
  return access_token;
}

// --------------- Document AI ---------------

interface NormalizedVertex {
  x: number;
  y: number;
}

interface DocAIFormField {
  fieldName: {
    textAnchor?: { content?: string; textSegments?: { startIndex: string; endIndex: string }[] };
    layout?: { boundingPoly?: { normalizedVertices?: NormalizedVertex[] } };
  };
  fieldValue: {
    textAnchor?: { content?: string; textSegments?: { startIndex: string; endIndex: string }[] };
    layout?: { boundingPoly?: { normalizedVertices?: NormalizedVertex[] } };
    valueType?: string;
  };
}

interface ExtractedField {
  label: string;
  valueText: string;
  isCheckbox: boolean;
  isChecked: boolean;
  boundingBox: { x: number; y: number; width: number; height: number };
}

function getTextFromAnchor(
  anchor: { content?: string; textSegments?: { startIndex: string; endIndex: string }[] } | undefined,
  fullText: string
): string {
  if (anchor?.content) return anchor.content.trim();
  if (anchor?.textSegments) {
    return anchor.textSegments
      .map((seg) => fullText.slice(Number(seg.startIndex || 0), Number(seg.endIndex || 0)))
      .join("")
      .trim();
  }
  return "";
}

function verticesToBox(vertices: NormalizedVertex[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (!vertices || vertices.length < 2) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const xs = vertices.map((v) => v.x ?? 0);
  const ys = vertices.map((v) => v.y ?? 0);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
}

function extractFormFields(
  docAIResponse: Record<string, unknown>
): ExtractedField[] {
  const document = docAIResponse.document as Record<string, unknown> | undefined;
  if (!document) return [];

  const fullText = (document.text as string) || "";
  const pages = (document.pages as Record<string, unknown>[]) || [];
  if (pages.length === 0) return [];

  const page = pages[0];
  const formFields = (page.formFields as DocAIFormField[]) || [];
  const results: ExtractedField[] = [];

  for (const ff of formFields) {
    const label = getTextFromAnchor(ff.fieldName?.textAnchor, fullText);
    const valueText = getTextFromAnchor(ff.fieldValue?.textAnchor, fullText);
    const valueType = ff.fieldValue?.valueType || "";
    const isCheckbox =
      valueType === "filled_checkbox" || valueType === "unfilled_checkbox";
    const isChecked = valueType === "filled_checkbox";

    const vertices =
      ff.fieldValue?.layout?.boundingPoly?.normalizedVertices || [];
    const boundingBox = verticesToBox(vertices);

    if (label || isCheckbox) {
      results.push({ label, valueText, isCheckbox, isChecked, boundingBox });
    }
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
- "poNumber" — PO No., PO Number, Purchase Order #, Order #, Order No.
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

  const gcpServiceAccountRaw = getServiceAccountJson();
  if (!gcpServiceAccountRaw || !GCP_PROJECT_ID || !DOCAI_PROCESSOR_ID) {
    return new Response(
      JSON.stringify({
        error: "Missing GCP configuration (GCP_SERVICE_ACCOUNT_JSON_B64, GCP_PROJECT_ID, or DOCAI_PROCESSOR_ID)",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  if (!GOOGLE_AI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_AI_API_KEY not configured" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  try {
    const { image } = await req.json();

    if (!image) {
      return new Response(
        JSON.stringify({ error: "Missing required field: image" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // --- Stage 1: Document AI Form Parser ---
    console.log("[detect-fields-v3] Stage 1: Calling Document AI Form Parser...");

    const serviceAccount = JSON.parse(gcpServiceAccountRaw);
    const accessToken = await getAccessToken(serviceAccount);

    const docAIUrl = `https://${DOCAI_LOCATION}-documentai.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${DOCAI_LOCATION}/processors/${DOCAI_PROCESSOR_ID}:process`;

    const docAIResponse = await fetch(docAIUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        rawDocument: {
          content: image,
          mimeType: "image/png",
        },
      }),
    });

    if (!docAIResponse.ok) {
      const errText = await docAIResponse.text();
      console.error("Document AI error:", docAIResponse.status, errText);
      return new Response(
        JSON.stringify({
          error: `Document AI error: ${docAIResponse.status}`,
          detail: errText,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const docAIResult = await docAIResponse.json();
    const extractedFields = extractFormFields(docAIResult);
    console.log(
      `[detect-fields-v3] Document AI found ${extractedFields.length} form field(s)`
    );

    if (extractedFields.length === 0) {
      return new Response(
        JSON.stringify({ fields: [], pageDescription: "No form fields detected" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Stage 2: Gemini classification ---
    console.log("[detect-fields-v3] Stage 2: Classifying fields with Gemini...");

    const classifications = await classifyFieldsWithGemini(extractedFields);
    console.log(
      `[detect-fields-v3] Gemini classified ${classifications.length} field(s)`
    );

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
    console.error("detect-fields-v3 error:", err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
