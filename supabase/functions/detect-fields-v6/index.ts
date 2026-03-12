import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");

const SYSTEM_PROMPT = `You are a precise form field identification and geometry matching system for film & TV production PDF documents (credit card authorizations, purchase orders, start paperwork, petty cash envelopes, deal memos, etc.).

You receive:
1. An image of a PDF form page with NUMBERED MARKERS drawn on detected fill-area geometry. Red markers are for text/signature fields. Blue markers are for checkboxes. Each marker is a circle with a white number, positioned ABOVE its geometry element.
2. A structured list of those geometry elements with their IDs, types, positions, and nearby printed label text.

Your job: For each fillable field on the form, identify which numbered marker represents its FILL AREA — the blank space where a user would write, type, or check.

## HOW TO MATCH MARKERS TO FIELDS

The geometry list includes "near text" hints for each marker. Use these hints plus the visual image to identify what field each marker belongs to.

CRITICAL MATCHING RULES:
- The marker is on the FILL AREA (blank line, box, widget), NOT on the printed label.
- On production forms, labels are often printed BELOW the fill area (e.g., "CREDIT CARD NUMBER" appears below the blank line where the number is written). Match the marker on the blank line ABOVE the label.
- For fields where the label is to the LEFT, the marker is on the blank/underline to the RIGHT of the label.
- The "near text" hint tells you what printed text is closest to the geometry. Use this to determine which field the marker belongs to.
- Look at the VISUAL POSITION of each marker in the image. The marker number is printed inside the circle.
- If two markers appear to be on overlapping or adjacent geometry at the same location, only match the one that best represents the actual fill area.

## CANONICAL FIELD IDs

Map each field to one of these IDs when possible. Use null if none match.

TEXT:
- "jobName" — Job Name, Project Name, Show Name
- "jobNumber" — Job No., Job Number, Job #, PO/Job #
- "poNumber" — PO No., PO Number, Purchase Order #, Order #, Invoice Number, Invoice No.
- "authorizationDate" — Date (near signature or footer area, NOT Exp Date)
- "productionCompany" — Production Company, Company Name, Name of Company, Account/Company Name
- "billingAddress" — Billing Address, Mailing Address, Address, Company Address
- "billingCity" — City
- "billingState" — State, St
- "billingZipCode" — Zip, Zip Code, Postal Code
- "producer" — Producer, Contact, Authorized By
- "email" — Email, Email Address
- "phone" — Phone, Phone Number, Phone #
- "creditCardHolder" — Cardholder Name, Name on Card, Name as it Appears on Card, Customer Name, Print Cardholders Name
- "cardholderSignature" — Signature line (the blank area for signing, not the word "SIGNATURE"), Authorized Cardholders Signature
- "creditCardNumber" — Credit Card Number, Card #, CC#, Account #, Credit Card #
- "expDate" — Exp Date, Expiration Date, MM/YY (NOT the authorization date)
- "ccv" — CVV, CVC, CID, CVV#, Security Code, Verification Code

CHECKBOXES (credit card type):
- "creditCardTypeVisa" — Visa checkbox
- "creditCardTypeMastercard" — MasterCard / MC checkbox
- "creditCardTypeDiscover" — Discover checkbox
- "creditCardTypeAmex" — AMEX / American Express checkbox

## FIELD KINDS
- "text" — single-line text input
- "multiline" — multi-line text area
- "date" — date field
- "signature" — signature line
- "checkbox-group" — grouped checkbox (like credit card type)
- "boolean-checkbox" — standalone yes/no checkbox

## FORM SECTIONS

Many forms have TWO address sections:
1. A company/contact section (top) — company name, company address, city/state/zip, phone
2. A billing/cardholder section (lower) — cardholder name, billing address, city/state/zip, phone

Match markers from BOTH sections. The second city/state/zip set should also use billingCity/billingState/billingZipCode.

## IMPORTANT RULES

1. Each marker number can be used AT MOST ONCE.
2. Skip markers on decorative lines, borders, or non-fillable elements.
3. For credit card type checkboxes: set groupId="creditCardType", checkboxValue to the lowercase brand name ("visa", "mastercard", "amex", "discover"), fieldKind="checkbox-group".
4. For other checkboxes (Keep on file, Yes/No, etc.): set fieldKind="boolean-checkbox", groupId=null, checkboxValue=null.
5. Non-credit-card checkboxes and fields without a canonical ID: set canonicalFieldId to null.
6. If two different sections have similar fields (e.g. two phone lines, two date fields), list both with different marker numbers.
7. Order fields top-to-bottom as they appear on the form.
8. Match ALL fillable fields — do not skip any. Include text fields, checkboxes, signature lines, date fields.
9. The label for each field should be derived from the nearby printed text on the form, not invented.
10. OPTIONAL FIELDS: If a field is inside a section marked "if applicable", "optional", or conditional, set "optional" to true. Otherwise false.`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!GOOGLE_AI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_AI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { image, geometryList } = await req.json();

    if (!image) {
      return new Response(
        JSON.stringify({ error: "Missing required field: image" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geometryText = geometryList
      ? `\n\nDETECTED GEOMETRY ELEMENTS (each has a numbered marker visible in the image):\n${geometryList}`
      : "";

    const userPrompt = `Analyze this production form image carefully. Numbered markers have been drawn on detected geometry elements:
- RED markers (circles with white numbers) = text fill areas, underlines, signature lines
- BLUE markers (circles with white numbers) = checkboxes

Each marker has a number that corresponds to the geometry list below. The "near text" hints tell you what printed label is closest to each geometry element.

TASK: For each fillable field on the form, find the marker that is on its fill area and return it. Match EVERY fillable field — text fields, checkboxes, signature lines, date fields. Do not skip any.

REMEMBER: On this type of form, labels are typically printed BELOW or to the LEFT of the fill area. The marker is on the FILL AREA, not on the label text.${geometryText}`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_AI_API_KEY}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: userPrompt },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: image,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              fields: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    markerNumber: {
                      type: "INTEGER",
                      description: "The numbered marker on the fill area",
                    },
                    canonicalFieldId: {
                      type: "STRING",
                      nullable: true,
                      description: "Canonical field ID or null",
                    },
                    label: {
                      type: "STRING",
                      description: "Human-readable field label from nearby text",
                    },
                    fieldType: {
                      type: "STRING",
                      enum: ["text", "checkbox"],
                    },
                    fieldKind: {
                      type: "STRING",
                      enum: ["text", "multiline", "date", "signature", "checkbox-group", "boolean-checkbox"],
                    },
                    checkboxValue: {
                      type: "STRING",
                      nullable: true,
                    },
                    groupId: {
                      type: "STRING",
                      nullable: true,
                    },
                    optional: {
                      type: "BOOLEAN",
                    },
                  },
                  required: ["markerNumber", "label", "fieldType", "fieldKind"],
                },
              },
              pageDescription: {
                type: "STRING",
                description: "Brief description of form type",
              },
            },
            required: ["fields"],
          },
        },
      }),
    });

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error("Gemini API error:", geminiResponse.status, errText);
      return new Response(
        JSON.stringify({ error: `Gemini API error: ${geminiResponse.status}`, detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiResult = await geminiResponse.json();
    const textContent = geminiResult.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!textContent) {
      console.error("Empty Gemini response:", JSON.stringify(geminiResult));
      return new Response(
        JSON.stringify({ error: "Empty response from Gemini" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = JSON.parse(textContent);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("detect-fields-v6 error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
