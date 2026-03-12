import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GOOGLE_AI_API_KEY = Deno.env.get("GOOGLE_AI_API_KEY");
const EMBED_MODEL = "gemini-embedding-2-preview";
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

interface EmbedRequest {
  mode: "document" | "text" | "field-labels";
  pdfBase64?: string;
  text?: string;
  labels?: string[];
  dimensions?: number;
}

async function embedText(
  text: string,
  taskType: string,
  dimensions: number
): Promise<number[]> {
  const res = await fetch(`${EMBED_URL}?key=${GOOGLE_AI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: dimensions,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini embed failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.embedding?.values ?? [];
}

async function embedDocument(
  pdfBase64: string,
  dimensions: number
): Promise<number[]> {
  const res = await fetch(`${EMBED_URL}?key=${GOOGLE_AI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: {
        parts: [{ inline_data: { mime_type: "application/pdf", data: pdfBase64 } }],
      },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: dimensions,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini doc embed failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.embedding?.values ?? [];
}

async function embedBatchTexts(
  texts: string[],
  taskType: string,
  dimensions: number
): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text, taskType, dimensions));
  }
  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (!GOOGLE_AI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_AI_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body: EmbedRequest = await req.json();
    const dimensions = body.dimensions ?? 768;

    if (body.mode === "document" && body.pdfBase64) {
      const embedding = await embedDocument(body.pdfBase64, dimensions);
      return new Response(
        JSON.stringify({ embedding, dimensions }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.mode === "text" && body.text) {
      const embedding = await embedText(body.text, "RETRIEVAL_DOCUMENT", dimensions);
      return new Response(
        JSON.stringify({ embedding, dimensions }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.mode === "field-labels" && body.labels) {
      const embeddings = await embedBatchTexts(
        body.labels,
        "SEMANTIC_SIMILARITY",
        dimensions
      );
      return new Response(
        JSON.stringify({ embeddings, dimensions }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid request: provide mode + data" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
