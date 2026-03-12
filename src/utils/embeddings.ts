import { CANONICAL_FIELD_DEFINITIONS } from "@/utils/fieldCatalog";
import type { CanonicalFieldId } from "@/types";

const EMBED_DIMENSIONS = 768;

function getEmbedUrl(): string {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
  if (!supabaseUrl) throw new Error("VITE_SUPABASE_URL not configured");
  return `${supabaseUrl}/functions/v1/embed`;
}

function getAnonKey(): string {
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  if (!key) throw new Error("VITE_SUPABASE_ANON_KEY not configured");
  return key;
}

async function callEmbedFunction(body: Record<string, unknown>): Promise<Response> {
  const anonKey = getAnonKey();
  return fetch(getEmbedUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ ...body, dimensions: EMBED_DIMENSIONS }),
  });
}

export async function embedDocument(pdfBase64: string): Promise<number[]> {
  const res = await callEmbedFunction({ mode: "document", pdfBase64 });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embed document failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.embedding;
}

export async function embedText(text: string): Promise<number[]> {
  const res = await callEmbedFunction({ mode: "text", text });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embed text failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.embedding;
}

export async function embedFieldLabels(labels: string[]): Promise<number[][]> {
  const res = await callEmbedFunction({ mode: "field-labels", labels });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embed field labels failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  return data.embeddings;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

let cachedCanonicalEmbeddings: Map<CanonicalFieldId, number[]> | null = null;
let canonicalEmbedPromise: Promise<Map<CanonicalFieldId, number[]>> | null = null;

function buildCanonicalDescriptions(): { ids: CanonicalFieldId[]; descriptions: string[] } {
  const ids: CanonicalFieldId[] = [];
  const descriptions: string[] = [];
  for (const def of CANONICAL_FIELD_DEFINITIONS) {
    ids.push(def.id);
    const aliasStr = def.aliases.join(", ");
    const sectionStr = def.sectionHints.join(", ");
    descriptions.push(
      `${def.label} (aliases: ${aliasStr}; section: ${sectionStr}; type: ${def.fieldKind})`
    );
  }
  return { ids, descriptions };
}

export async function getCanonicalFieldEmbeddings(): Promise<Map<CanonicalFieldId, number[]>> {
  if (cachedCanonicalEmbeddings) return cachedCanonicalEmbeddings;

  if (!canonicalEmbedPromise) {
    canonicalEmbedPromise = (async () => {
      const { ids, descriptions } = buildCanonicalDescriptions();
      console.log(`[Wrapkit Embed] Computing embeddings for ${ids.length} canonical fields...`);
      const embeddings = await embedFieldLabels(descriptions);
      const map = new Map<CanonicalFieldId, number[]>();
      for (let i = 0; i < ids.length; i++) {
        map.set(ids[i], embeddings[i]);
      }
      cachedCanonicalEmbeddings = map;
      console.log("[Wrapkit Embed] Canonical field embeddings cached.");
      return map;
    })();
  }

  return canonicalEmbedPromise;
}

export function findBestCanonicalMatch(
  labelEmbedding: number[],
  canonicalEmbeddings: Map<CanonicalFieldId, number[]>,
  threshold = 0.65
): { id: CanonicalFieldId; similarity: number } | null {
  let bestId: CanonicalFieldId | null = null;
  let bestSim = -1;
  for (const [id, emb] of canonicalEmbeddings) {
    const sim = cosineSimilarity(labelEmbedding, emb);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = id;
    }
  }
  if (bestId && bestSim >= threshold) {
    return { id: bestId, similarity: bestSim };
  }
  return null;
}

const FORM_TYPE_DESCRIPTIONS = [
  { type: "credit_card_authorization", description: "Credit card authorization form for charging a credit or debit card, with fields for cardholder name, card number, expiration date, signature, and billing address" },
  { type: "purchase_order", description: "Purchase order or vendor payment form with line items, quantities, costs, vendor information, and approval signatures" },
  { type: "deal_memo", description: "Deal memo, crew deal, or employment agreement for film/TV production with rate, position, start date, and terms" },
  { type: "petty_cash", description: "Petty cash envelope, expense report, or reimbursement form with itemized expenses, amounts, receipts, and approval" },
  { type: "start_paperwork", description: "Employee start paperwork, onboarding documents, I-9, W-4, or tax withholding forms" },
  { type: "invoice", description: "Invoice, bill, or statement for goods and services rendered with line items and total due" },
  { type: "unknown", description: "General business form, miscellaneous document, or unrecognized form type" },
];

let cachedFormTypeEmbeddings: Map<string, number[]> | null = null;
let formTypePromise: Promise<Map<string, number[]>> | null = null;

export async function classifyFormType(
  docEmbedding: number[]
): Promise<{ type: string; confidence: number }> {
  if (!cachedFormTypeEmbeddings) {
    if (!formTypePromise) {
      formTypePromise = (async () => {
        const descriptions = FORM_TYPE_DESCRIPTIONS.map((ft) => ft.description);
        const embeddings = await embedFieldLabels(descriptions);
        const map = new Map<string, number[]>();
        for (let i = 0; i < FORM_TYPE_DESCRIPTIONS.length; i++) {
          map.set(FORM_TYPE_DESCRIPTIONS[i].type, embeddings[i]);
        }
        cachedFormTypeEmbeddings = map;
        return map;
      })();
    }
    cachedFormTypeEmbeddings = await formTypePromise;
  }

  let bestType = "unknown";
  let bestSim = -1;
  for (const [type, emb] of cachedFormTypeEmbeddings) {
    const sim = cosineSimilarity(docEmbedding, emb);
    if (sim > bestSim) {
      bestSim = sim;
      bestType = type;
    }
  }
  return { type: bestType, confidence: bestSim };
}
