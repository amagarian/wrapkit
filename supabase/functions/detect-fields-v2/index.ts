import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");

const SYSTEM_PROMPT = `You are a precise form field detection system for film & TV production PDF documents (credit card authorizations, purchase orders, start paperwork, petty cash envelopes, deal memos, etc.).

You receive a high-resolution image of a PDF form page. Identify every FILLABLE FIELD and return a tight bounding box around each field's INPUT AREA.

## BOUNDING BOX RULES — CRITICAL FOR ACCURACY

Return a "box_2d" array: [y_min, x_min, y_max, x_max] normalized to 0–1000 (top-left = 0,0; bottom-right = 1000,1000).

### What to box:
- The BLANK INPUT AREA only — the underline, empty box, or signature line where a user writes.
- For "Label: ____________" fields, the box starts RIGHT AFTER the colon/label text and extends to the END of the underline. The label text itself is OUTSIDE the box.
- For fields like "City_________ State_______ Zip_______" on one line, return THREE separate tight boxes, each starting right after its label and ending where the underline ends.

### What NOT to box:
- NEVER include label text inside the bounding box.
- NEVER extend the box leftward to cover the label.
- NEVER make the box wider than the actual fill area.

### Precision tips:
- x_min should be at the LEFT EDGE of where the blank/underline starts (right after the label text ends).
- x_max should be at the RIGHT EDGE of where the blank/underline ends.
- y_min should be at the TOP of the text baseline area.
- y_max should be at the BOTTOM of the underline/input box.
- For underline-style fields, the vertical height is typically small (15–30 in normalized units). Do NOT make boxes excessively tall.

## CANONICAL FIELD IDs

Map each detected field to one of these IDs. If none match, use null.

TEXT:
- "jobName" — Job Name, Project Name, Show Name, Show/Project
- "jobNumber" — Job No., Job Number, Job #, PO/Job #
- "poNumber" — PO No., PO Number, Purchase Order #, Order #, Order No.
- "authorizationDate" — Date (near signature or footer area)
- "productionCompany" — Production Company, Company, Company Name, Company/Contact, Name of Company
- "billingAddress" — Billing Address, Mailing Address, Address, Company Address
- "billingCity" — City
- "billingState" — State, St
- "billingZipCode" — Zip, Zip Code, Postal Code
- "producer" — Producer, Contact, Contact Name, Authorized By
- "email" — Email, Email Address, E-mail
- "phone" — Phone, Phone #, Phone Number, Telephone
- "creditCardHolder" — Cardholder Name, Name on Card, Name as it Appears on Card, Name (when in credit card section)
- "cardholderSignature" — Signature (the blank signature LINE, not printed text), Authorized Cardholders Signature
- "creditCardNumber" — Credit Card Number, Card #, CC#, Card Number, Account #, Credit Card #
- "expDate" — Exp Date, Expiration Date, Exp., MM/YY
- "ccv" — CVV, CVC, CID, Security Code, Verification Code

CHECKBOXES (credit card type — each is a separate field):
- "creditCardTypeVisa" — checkbox for Visa
- "creditCardTypeMastercard" — checkbox for MasterCard / MC
- "creditCardTypeDiscover" — checkbox for Discover
- "creditCardTypeAmex" — checkbox for AMEX / American Express

## FORM SECTIONS

Many credit card authorization forms have TWO address sections:
1. A company/contact section at the top with company name, company address, city/state/zip, phone
2. A billing/cardholder section lower down with cardholder name, billing address, city/state/zip

You MUST detect fields from BOTH sections. Do not skip the second set of city/state/zip fields.
Similarly, if the form has multiple phone fields, detect all of them.

## CHECKBOXES — IMPORTANT

### Credit card type checkboxes
Most production forms have a row of credit card type options like:
  "Check One: ( ) Visa / MC  ( ) Amex  ( ) Discover"
or "☐ Visa  ☐ MasterCard  ☐ AmEx  ☐ Discover"
These are ALWAYS checkboxes. Detect each card type as a separate checkbox field. The bounding box should surround the checkbox square/parentheses only (not the brand name text). Set groupId to "creditCardType" and checkboxValue to the brand ("visa", "mastercard", "discover", "amex").

Note: "Visa / MC" means two separate checkboxes — one for Visa and one for MasterCard. They may share a single parenthesis/checkbox but should still be two separate entries.

### Other checkboxes
Each checkbox with its own label is a SEPARATE field entry.

For every non-credit-card checkbox:
- set fieldType to "checkbox"
- set fieldKind to "boolean-checkbox"
- set checkboxValue to null
- set groupId to null
- set canonicalFieldId to null

## SIGNATURE AND PRINT NAME FIELDS

Forms often have a signature section with:
- "Authorized Cardholders Signature: ____________" → cardholderSignature
- "Print Cardholders Name: ____________" → creditCardHolder (this is a text field for the printed name)
- "Date: ____________" → authorizationDate

The signature line is typically longer and positioned differently from regular text fields. Detect it as fieldKind "signature".
The "Print Name" line next to it is a regular text field mapping to creditCardHolder.

## LABEL RULES

For every field, the "label" must be a short, human-readable name derived from the form's printed text:
- For canonical fields, use the standard label (e.g. "Credit Card Number", "Expiration Date").
- For non-canonical fields (canonicalFieldId is null), use the exact printed text label from the form.

## CRITICAL RULES

1. ONLY identify fillable areas. NEVER identify printed static text, headers, logos, footers, or decorative elements.
2. NO DUPLICATES. Each physical fill area = exactly ONE field entry.
3. If separate labels like "City:", "State:", "Zip:" each have their own fill area, list each as a separate field.
4. List fields top-to-bottom, left-to-right in the order they appear on the form.
5. For "Company / Contact" style combined labels, map to the best canonical ID (usually "productionCompany").
6. Fields labeled just "Name" in a credit card section should map to "creditCardHolder".
7. Detect ALL fillable fields on the page — do not skip any blank lines, even if they seem redundant.`;

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
    const { image, fileName } = await req.json();

    if (!image) {
      return new Response(
        JSON.stringify({ error: "Missing required field: image" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userPrompt = `Analyze this production form image${fileName ? ` (file: "${fileName}")` : ""}.

Detect EVERY fillable field on the form — every blank line, underline, checkbox, and signature area. For each field, return:
- A precise bounding box (box_2d) around ONLY the blank/fill region (not the label text). The box must start right where the blank area begins and end where it ends.
- The canonicalFieldId if it matches a known field, otherwise null
- A human-readable label
- The field type and kind

Be thorough: check both upper and lower sections of the form. Many forms have two address sections — detect fields from both. Return the fields as a JSON array ordered top-to-bottom, left-to-right.`;

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
                    box_2d: {
                      type: "ARRAY",
                      items: { type: "INTEGER" },
                      description: "Bounding box [y_min, x_min, y_max, x_max] normalized 0-1000. Must tightly surround ONLY the fill area, not label text.",
                    },
                    canonicalFieldId: {
                      type: "STRING",
                      nullable: true,
                      description: "Canonical field ID or null",
                    },
                    label: {
                      type: "STRING",
                      description: "Human-readable field label",
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
                  },
                  required: ["box_2d", "label", "fieldType", "fieldKind"],
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
    console.error("detect-fields-v2 error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
