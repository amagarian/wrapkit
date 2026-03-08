import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const SYSTEM_PROMPT = `You are a form field identification system for film & TV production PDF documents (credit card authorizations, purchase orders, start paperwork, petty cash envelopes, deal memos, etc.).

You receive an image of a PDF form page. Identify every FILLABLE FIELD — blank lines, underlines, empty boxes, checkboxes, and signature lines where a user would write or type information.

You do NOT provide coordinates. You identify fields and provide the EXACT printed label text next to each fill area so the client can locate it in the PDF.

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
or just the brand names with small boxes/squares next to them. These are ALWAYS checkboxes. You MUST detect each card type as a separate checkbox field even if the boxes are small, faint, or just implied by the layout. For nearbyText, use the exact brand name as printed (e.g. "Visa", "AmEx", "Mastercard"). For these, set groupId to "creditCardType" and checkboxValue to the brand ("visa", "mastercard", "discover", "amex").

### Other checkboxes
Production forms often have rows of option checkboxes like:
  "Please check one:  ☐ Rental & deposit  ☐ Deposit only  ☐ Rental only"
Each checkbox with its own label is a SEPARATE field entry. In the example above, you must return THREE separate checkbox fields: one for "Rental & deposit", one for "Deposit only", one for "Rental only". Do NOT combine them into a single field.

Other common checkboxes include "Keep this card on file for future orders", "Only use this card for charges associated with Order#", "Only use this card for charges associated with Job name", etc. You MUST detect ALL of these as individual checkbox fields.

For every non-credit-card checkbox:
- set fieldType to "checkbox"
- set fieldKind to "boolean-checkbox"
- set checkboxValue to null
- set groupId to null
- set canonicalFieldId to null
- set nearbyText to the EXACT label text printed next to that specific checkbox

### Text fields next to checkboxes
Some checkboxes have an associated fill-in blank next to or on the same line. For example:
  "☐ Only use this card for charges associated with Order#: _________  Ship date: _________"
This line contains THREE separate fields:
  1. A checkbox for "Only use this card for charges associated with Order#"
  2. A text field labeled "Order#" (the blank after "Order#:")
  3. A text field labeled "Ship date" (the blank after "Ship date:")

Similarly: "☐ Only use this card for charges associated with Job name: _________"
This has TWO fields: a checkbox and a text field labeled "Job name".

You MUST detect each fill-in blank as its own text field with the correct label from the form (e.g. "Ship date", "Order#", "Job name"). Use nearbyText matching the exact printed label.

## LABEL RULES

For every field, the "label" must be a short, human-readable name derived from the form's printed text:
- For canonical fields, use the standard label (e.g. "Credit Card Number", "Expiration Date").
- For non-canonical fields (canonicalFieldId is null), use the exact printed text label from the form as the label. For example: "Ship date", "Order#", "Job name". Do NOT use generic names like "Field 1" or "Text field".

## CRITICAL RULES

1. ONLY identify fillable areas (blank lines, underlines, empty boxes, checkboxes, signature lines). NEVER identify:
   - Printed static text, headers, logos, page titles
   - Company contact info, addresses, phone/fax numbers in footers or headers
   - Instructional paragraphs (e.g. "Please complete and return...")
   - Decorative elements, borders, or background boxes
2. **nearbyText must be the EXACT printed label** on the form next to the fill area, character-for-character as printed. Do NOT paraphrase.
3. **NO DUPLICATES.** Each physical fill area = exactly ONE field entry.
4. If separate labels like "City:", "State:", "Zip:" each have their own fill area, list each as a separate field.
5. If there are genuinely two different signature lines or two date fields in different sections, list each.
6. For credit card type checkbox fields: set fieldType to "checkbox", fieldKind to "checkbox-group", checkboxValue to the brand, groupId to "creditCardType".
7. For other checkbox fields: set fieldType to "checkbox", fieldKind to "boolean-checkbox", checkboxValue to null, groupId to null.
8. List fields top-to-bottom in the order they appear on the form.
9. For "Company / Contact" style combined labels, map to the best canonical ID (usually "productionCompany").
10. Fields labeled just "Name" in a credit card section should map to "creditCardHolder".

Return ONLY valid JSON:
{
  "fields": [
    {
      "canonicalFieldId": "creditCardNumber",
      "label": "Credit Card Number",
      "nearbyText": "Credit Card #:",
      "fieldType": "text",
      "fieldKind": "text",
      "checkboxValue": null,
      "groupId": null
    }
  ],
  "pageDescription": "Brief description of form type"
}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!OPENAI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
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

Identify every fillable field on the form. For each field, provide its canonicalFieldId (if it matches a known field), a human-readable label, and the EXACT nearby printed text that labels this field. List them in order from top to bottom.

Remember: each physical blank line/checkbox = exactly one entry. No duplicates.`;

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        max_tokens: 2048,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: userPrompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/png;base64,${image}`,
                  detail: "high",
                },
              },
            ],
          },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      const errText = await openaiResponse.text();
      console.error("OpenAI API error:", openaiResponse.status, errText);
      return new Response(
        JSON.stringify({ error: `OpenAI API error: ${openaiResponse.status}`, detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const completion = await openaiResponse.json();
    const content = completion.choices?.[0]?.message?.content;

    if (!content) {
      return new Response(
        JSON.stringify({ error: "Empty response from OpenAI" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parsed = JSON.parse(content);

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("detect-fields error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
