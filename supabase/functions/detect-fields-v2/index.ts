import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");

const SYSTEM_PROMPT = `You are a form field detection system for film & TV production PDF documents (credit card authorizations, purchase orders, start paperwork, petty cash envelopes, deal memos, etc.).

You receive an image of a PDF form page. Identify every FILLABLE FIELD and return a bounding box around each field's INPUT AREA — the blank line, underline, empty box, checkbox square, or signature line where a user would write or type. Do NOT draw boxes around label text — only around the fillable region.

## BOUNDING BOXES

For each field, return a "box_2d" array with [y_min, x_min, y_max, x_max] coordinates normalized to 0-1000 (where 0,0 is the top-left corner and 1000,1000 is the bottom-right corner of the image).

The bounding box must tightly surround the INPUT AREA (the blank/empty region to be filled), NOT the label text. For example, for a field labeled "Name: ____________", the box should surround only the underline area, not the word "Name:".

For checkboxes, the box should surround the checkbox square itself.

## CANONICAL FIELD IDs

Map each detected field to one of these IDs. If none match, use null.

TEXT:
- "jobName" — Job Name, Project Name, Show Name, Show/Project
- "jobNumber" — Job No., Job Number, Job #, PO/Job #
- "poNumber" — PO No., PO Number, Purchase Order #, Order #, Order No.
- "authorizationDate" — Date (near signature or footer area)
- "productionCompany" — Production Company, Company, Company Name, Company/Contact
- "billingAddress" — Billing Address, Mailing Address, Address
- "billingCity" — City
- "billingState" — State, St
- "billingZipCode" — Zip, Zip Code, Postal Code
- "producer" — Producer, Contact, Contact Name, Authorized By
- "email" — Email, Email Address, E-mail
- "phone" — Phone, Phone #, Phone Number, Telephone
- "creditCardHolder" — Cardholder Name, Name on Card, Name (when in credit card section)
- "cardholderSignature" — Signature (the blank signature LINE, not printed text)
- "creditCardNumber" — Credit Card Number, Card #, CC#, Card Number, Account #
- "expDate" — Exp Date, Expiration Date, Exp., MM/YY
- "ccv" — CVV, CVC, CID, Security Code, Verification Code

CHECKBOXES (credit card type — each is a separate field):
- "creditCardTypeVisa" — checkbox for Visa
- "creditCardTypeMastercard" — checkbox for MasterCard / MC
- "creditCardTypeDiscover" — checkbox for Discover
- "creditCardTypeAmex" — checkbox for AMEX / American Express

## CHECKBOXES — IMPORTANT

### Credit card type checkboxes
Most production forms have a row of credit card type options like:
  "☐ Visa  ☐ MasterCard  ☐ AmEx  ☐ Discover"
or just the brand names with small boxes/squares next to them. These are ALWAYS checkboxes. You MUST detect each card type as a separate checkbox field even if the boxes are small, faint, or just implied by the layout. The bounding box should surround the checkbox square (not the brand name text). For these, set groupId to "creditCardType" and checkboxValue to the brand ("visa", "mastercard", "discover", "amex").

### Other checkboxes
Production forms often have rows of option checkboxes like:
  "Please check one:  ☐ Rental & deposit  ☐ Deposit only  ☐ Rental only"
Each checkbox with its own label is a SEPARATE field entry. In the example above, you must return THREE separate checkbox fields. Do NOT combine them into a single field.

Other common checkboxes include "Keep this card on file for future orders", "Only use this card for charges associated with Order#", "Only use this card for charges associated with Job name", etc. You MUST detect ALL of these as individual checkbox fields.

For every non-credit-card checkbox:
- set fieldType to "checkbox"
- set fieldKind to "boolean-checkbox"
- set checkboxValue to null
- set groupId to null
- set canonicalFieldId to null

### Text fields next to checkboxes
Some checkboxes have an associated fill-in blank next to or on the same line. For example:
  "☐ Only use this card for charges associated with Order#: _________  Ship date: _________"
This line contains THREE separate fields:
  1. A checkbox for "Only use this card for charges associated with Order#"
  2. A text field labeled "Order#" (the blank after "Order#:")
  3. A text field labeled "Ship date" (the blank after "Ship date:")

IMPORTANT: These checkbox-associated fill-in text fields are contextual — they must have canonicalFieldId set to null, NOT to "jobName" or "poNumber".

## LABEL RULES

For every field, the "label" must be a short, human-readable name derived from the form's printed text:
- For canonical fields, use the standard label (e.g. "Credit Card Number", "Expiration Date").
- For non-canonical fields (canonicalFieldId is null), use the exact printed text label from the form. Do NOT use generic names like "Field 1".

## CRITICAL RULES

1. ONLY identify fillable areas. NEVER identify printed static text, headers, logos, footers, instructional paragraphs, or decorative elements.
2. NO DUPLICATES. Each physical fill area = exactly ONE field entry.
3. If separate labels like "City:", "State:", "Zip:" each have their own fill area, list each as a separate field.
4. List fields top-to-bottom in the order they appear on the form.
5. For "Company / Contact" style combined labels, map to the best canonical ID (usually "productionCompany").
6. Fields labeled just "Name" in a credit card section should map to "creditCardHolder".`;

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

Detect every fillable field on the form. For each field, return:
- A bounding box (box_2d) around the INPUT AREA (the blank/fill region, NOT the label text)
- The canonicalFieldId if it matches a known field, otherwise null
- A human-readable label
- The field type and kind

Return the fields as a JSON array. Each physical blank line, checkbox, or input area = exactly one entry. No duplicates.`;

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
          temperature: 0.3,
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
                      description: "Bounding box [y_min, x_min, y_max, x_max] normalized 0-1000",
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
