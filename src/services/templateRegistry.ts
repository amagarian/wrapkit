import type {
  PdfMatchResult,
  Template,
  TemplateCacheEntry,
  TemplateFingerprint,
  TemplateMatch,
  TemplateSubmission,
  TemplateVersion,
} from "@/types";
import { mockPossibleTemplates, mockVerifiedTemplate } from "@/data/mockTemplates";
import {
  readTemplateCacheEntries,
  readTemplateSubmissions,
  queueTemplateSubmission,
  updateTemplateSubmission,
  upsertTemplateCacheEntries,
} from "@/services/templateCache";
import { getSupabaseClient, isSupabaseConfigured } from "@/services/supabaseClient";
import {
  buildPdfFingerprint,
  buildTemplateFingerprintFromTemplate,
  scoreFingerprintMatch,
} from "@/utils/templateFingerprint";

const DEFAULT_CACHE_TTL_MS = Number(import.meta.env.VITE_TEMPLATE_CACHE_TTL_MS ?? 86_400_000);

export interface TemplateRegistrySnapshot {
  cacheEntries: TemplateCacheEntry[];
  pendingSubmissions: TemplateSubmission[];
  configured: boolean;
}

export interface TemplateRegistryMatchResult {
  fingerprint: TemplateFingerprint;
  templatesById: Record<string, Template>;
  cacheEntries: TemplateCacheEntry[];
  result: PdfMatchResult;
}

export interface SubmitTemplateInput {
  template: Template;
  pdfBytes?: Uint8Array | null;
  pdfFileName: string;
  sourceProjectId?: string;
}

export interface SubmitTemplateResult {
  submission: TemplateSubmission;
  queuedOffline: boolean;
}

export interface ReviewTemplateSubmissionInput {
  submissionId: string;
  template: Template;
  familyId: string;
  version: string;
  notes?: string;
}

interface RawTemplateVersionRow {
  id: string;
  family_id: string;
  template_id: string;
  version: string;
  status: Template["status"];
  source_pdf_path?: string | null;
  preview_image_path?: string | null;
  fingerprint: TemplateFingerprint;
  template_payload: Template;
  submitted_at?: string | null;
  verified_at?: string | null;
  created_at: string;
  updated_at: string;
}

function toCacheEntry(version: TemplateVersion, source: TemplateCacheEntry["source"]): TemplateCacheEntry {
  return {
    cacheKey: `${version.id}:${version.version}`,
    familyId: version.familyId,
    versionId: version.id,
    source,
    fingerprint: version.fingerprint,
    template: {
      ...version.template,
      status: version.status,
      version: version.version,
      familyId: version.familyId,
      remoteVersionId: version.id,
      source: source === "verified-cloud" ? "verified-cloud" : source,
      fingerprint: version.fingerprint,
    },
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
  };
}

function mapRemoteVersion(row: RawTemplateVersionRow): TemplateVersion {
  return {
    id: row.id,
    familyId: row.family_id,
    templateId: row.template_id,
    version: row.version,
    status: row.status,
    fingerprint: row.fingerprint,
    sourcePdfPath: row.source_pdf_path ?? undefined,
    previewImagePath: row.preview_image_path ?? undefined,
    submittedAt: row.submitted_at ?? undefined,
    verifiedAt: row.verified_at ?? undefined,
    template: {
      ...row.template_payload,
      status: row.status,
      version: row.version,
      familyId: row.family_id,
      remoteVersionId: row.id,
      source: "verified-cloud",
      fingerprint: row.fingerprint,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createSeedEntries(): TemplateCacheEntry[] {
  const now = new Date().toISOString();
  const seedTemplates = [mockVerifiedTemplate, ...mockPossibleTemplates];

  return seedTemplates.map((template, index) => {
    const familyId = template.familyId ?? `seed-family-${index + 1}`;
    const versionId = template.remoteVersionId ?? `seed-version-${index + 1}`;
    const fingerprint = template.fingerprint ?? buildTemplateFingerprintFromTemplate(template);

    return {
      cacheKey: `${versionId}:${template.version ?? "1.0"}`,
      familyId,
      versionId,
      source: "seed",
      fingerprint,
      template: {
        ...template,
        familyId,
        remoteVersionId: versionId,
        source: "seed",
        fingerprint,
      },
      cachedAt: now,
      expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
    };
  });
}

function mergeEntries(...groups: TemplateCacheEntry[][]): TemplateCacheEntry[] {
  const merged = new Map<string, TemplateCacheEntry>();
  groups.flat().forEach((entry) => {
    merged.set(entry.cacheKey, entry);
  });
  return [...merged.values()];
}

function buildTemplateMap(entries: TemplateCacheEntry[]): Record<string, Template> {
  return Object.fromEntries(entries.map((entry) => [entry.template.id, entry.template]));
}

function buildTemplateMatch(entry: TemplateCacheEntry, confidence: number): TemplateMatch {
  return {
    templateId: entry.template.id,
    familyId: entry.familyId,
    versionId: entry.versionId,
    templateName: entry.template.name,
    status: entry.template.status,
    confidence,
    version: entry.template.version,
    source: entry.template.source ?? entry.source,
  };
}

async function fetchRemoteVerifiedEntries(): Promise<TemplateCacheEntry[]> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.warn("[Wrapkit] Supabase client is null — cloud registry not available");
    return [];
  }

  console.log("[Wrapkit] Fetching verified templates from cloud...");
  const { data, error } = await supabase
    .from("template_versions")
    .select(
      "id,family_id,template_id,version,status,source_pdf_path,fingerprint,template_payload,submitted_at,verified_at,created_at,updated_at"
    )
    .in("status", ["verified", "community-submitted"]);

  if (error) {
    console.warn("[Wrapkit] Failed to fetch verified templates from Supabase", error);
    return [];
  }

  const entries = (data as RawTemplateVersionRow[]).map((row) => toCacheEntry(mapRemoteVersion(row), "verified-cloud"));
  console.log(`[Wrapkit] Fetched ${entries.length} verified templates from cloud`);
  return entries;
}

export async function hydrateTemplateRegistry(): Promise<TemplateRegistrySnapshot> {
  const localEntries = readTemplateCacheEntries();
  const seedEntries = createSeedEntries();
  const remoteEntries = await fetchRemoteVerifiedEntries();
  const cacheEntries = mergeEntries(seedEntries, localEntries, remoteEntries);
  upsertTemplateCacheEntries(cacheEntries);

  return {
    cacheEntries,
    pendingSubmissions: readTemplateSubmissions(),
    configured: isSupabaseConfigured(),
  };
}

function rankTemplateCandidates(
  fingerprint: TemplateFingerprint,
  entries: TemplateCacheEntry[],
  fileName?: string
): Array<{ entry: TemplateCacheEntry; confidence: number }> {
  const fileNameTokens = new Set((fingerprint.fileNameHints ?? []).concat((fileName ?? "").toLowerCase()));

  const scored = entries.map((entry) => {
    const { total, detail } = scoreFingerprintMatch(fingerprint, entry.fingerprint);
    const nameBonus = entry.template.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .some((token) => fileNameTokens.has(token))
      ? 0.06
      : 0;

    const confidence = Math.min(1, total + nameBonus);
    console.log(
      `[Wrapkit] Match candidate "${entry.template.name}" (${entry.source}): ` +
      `confidence=${confidence.toFixed(3)} [page=${detail.page.toFixed(2)} anchors=${detail.anchors.toFixed(2)} ` +
      `fileName=${detail.fileName.toFixed(2)} checkbox=${detail.checkbox.toFixed(2)} nameBonus=${nameBonus}]`
    );
    return { entry, confidence };
  });

  return scored
    .filter(({ confidence }) => confidence >= 0.90)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 3);
}

export async function matchVerifiedTemplates(
  pdfBytes: Uint8Array,
  fileName?: string
): Promise<TemplateRegistryMatchResult> {
  const snapshot = await hydrateTemplateRegistry();
  const fingerprint = await buildPdfFingerprint(pdfBytes, fileName);
  const ranked = rankTemplateCandidates(fingerprint, snapshot.cacheEntries, fileName);
  const templatesById = buildTemplateMap(snapshot.cacheEntries);

  if (ranked[0] && ranked[0].confidence >= 0.90) {
    return {
      fingerprint,
      templatesById,
      cacheEntries: snapshot.cacheEntries,
      result: {
        kind: "verified",
        verifiedMatch: buildTemplateMatch(ranked[0].entry, ranked[0].confidence),
        fileName,
        lookupMessage:
          ranked[0].entry.source === "verified-cloud"
            ? "Matched against the verified cloud registry."
            : "Matched against the local verified template cache.",
        matchSource: ranked[0].entry.template.source ?? ranked[0].entry.source,
        syncState: "matched",
      },
    };
  }

  const possibleMatches = ranked
    .filter(({ confidence }) => confidence >= 0.90)
    .map(({ entry, confidence }) => buildTemplateMatch(entry, confidence));

  if (possibleMatches.length > 0) {
    return {
      fingerprint,
      templatesById,
      cacheEntries: snapshot.cacheEntries,
      result: {
        kind: "possible",
        possibleMatches,
        fileName,
        lookupMessage: "We found likely verified templates. Pick one or continue with a draft.",
        matchSource: possibleMatches[0]?.source,
        syncState: "matched",
      },
    };
  }

  return {
    fingerprint,
    templatesById,
    cacheEntries: snapshot.cacheEntries,
    result: {
      kind: "none",
      fileName,
      lookupMessage: snapshot.configured
        ? "No verified cloud template matched. A draft template will be generated."
        : "Verified cloud registry is not configured yet. A local draft template will be generated.",
      matchSource: "detector",
      syncState: snapshot.configured ? "matched" : "idle",
    },
  };
}

async function uploadSubmission(submission: TemplateSubmission, pdfBytes?: Uint8Array | null): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return false;
  }

  let sourcePdfPath = submission.sourcePdfPath;
  if (pdfBytes?.length) {
    const bucketPath = `template-submissions/${submission.id}/${submission.pdfFileName}`;
    const { error: uploadError } = await supabase.storage
      .from("template-assets")
      .upload(bucketPath, pdfBytes, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (uploadError) {
      console.warn("Failed to upload template submission PDF", uploadError);
      return false;
    }
    sourcePdfPath = bucketPath;
  }

  const { error } = await supabase.from("template_submissions").insert({
    id: submission.id,
    template_id: submission.templateId,
    template_name: submission.templateName,
    source_project_id: submission.sourceProjectId,
    pdf_file_name: submission.pdfFileName,
    source_pdf_path: sourcePdfPath,
    status: "submitted",
    fingerprint: submission.fingerprint,
    template_payload: submission.template,
    notes: submission.notes,
    submitted_at: submission.submittedAt,
  });

  if (error) {
    console.warn("Failed to create template submission", error);
    return false;
  }

  return true;
}

async function getOrCreateAutoFamily(): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const SLUG = "community-auto";
  const { data: existing } = await supabase
    .from("template_families")
    .select("id")
    .eq("slug", SLUG)
    .single();

  if (existing?.id) return existing.id as string;

  const { data: created, error } = await supabase
    .from("template_families")
    .insert({
      slug: SLUG,
      vendor_name: "Community",
      form_name: "Auto-verified",
      document_type: "generic",
    })
    .select("id")
    .single();

  if (error || !created?.id) {
    console.warn("Failed to create default template family", error);
    return null;
  }
  return created.id as string;
}

export async function submitTemplateForVerification({
  template,
  pdfBytes,
  pdfFileName,
  sourceProjectId,
}: SubmitTemplateInput): Promise<SubmitTemplateResult> {
  const fingerprint =
    template.fingerprint ??
    (pdfBytes ? await buildPdfFingerprint(pdfBytes, pdfFileName) : buildTemplateFingerprintFromTemplate(template, pdfFileName));
  const now = new Date().toISOString();
  const submission: TemplateSubmission = {
    id: `submission-${Date.now()}`,
    templateId: template.id,
    templateName: template.name,
    status: "queued",
    pdfFileName,
    fingerprint,
    template: {
      ...template,
      status: "community-submitted",
      source: "community-submitted",
      fingerprint,
    },
    sourceProjectId,
    submittedAt: now,
  };

  const uploaded = await uploadSubmission(submission, pdfBytes);

  if (uploaded) {
    const familyId = await getOrCreateAutoFamily();
    if (familyId) {
      const supabase = getSupabaseClient();
      if (supabase) {
        // Check for an existing version with the same fingerprint hash to overwrite
        let remoteVersionId = template.remoteVersionId;
        if (!remoteVersionId && fingerprint.fingerprintHash) {
          const { data: existing } = await supabase
            .from("template_versions")
            .select("id")
            .eq("fingerprint->>fingerprintHash", fingerprint.fingerprintHash)
            .limit(1);
          if (existing && existing.length > 0) {
            remoteVersionId = existing[0].id;
          }
        }
        remoteVersionId = remoteVersionId ?? `verified-${submission.id}`;
        const version = template.version ?? "1.0";

        const { error: versionError } = await supabase.from("template_versions").upsert({
          id: remoteVersionId,
          family_id: familyId,
          template_id: template.id,
          version,
          status: "verified",
          fingerprint,
          template_payload: {
            ...template,
            status: "verified",
            familyId,
            remoteVersionId,
            source: "verified-cloud",
            fingerprint,
          },
          source_pdf_path: submission.sourcePdfPath,
          verified_at: now,
          submitted_at: now,
        });

        if (!versionError) {
          await supabase.from("template_submissions").update({
            status: "approved",
          }).eq("id", submission.id);

          updateTemplateSubmission(submission.id, { status: "approved" });

          upsertTemplateCacheEntries([{
            cacheKey: `${remoteVersionId}:${version}`,
            familyId,
            versionId: remoteVersionId,
            source: "verified-cloud",
            fingerprint,
            template: {
              ...template,
              status: "verified",
              familyId,
              remoteVersionId,
              version,
              source: "verified-cloud",
              fingerprint,
              updatedAt: now,
            },
            cachedAt: now,
            expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
          }]);
        } else {
          console.warn("Auto-verify: failed to upsert template_versions", versionError);
        }
      }
    }
  }

  const finalSubmission: TemplateSubmission = {
    ...submission,
    status: uploaded ? "submitted" : "queued",
  };
  queueTemplateSubmission(finalSubmission);

  return {
    submission: finalSubmission,
    queuedOffline: !uploaded,
  };
}

export async function approveTemplateSubmission({
  submissionId,
  template,
  familyId,
  version,
  notes,
}: ReviewTemplateSubmissionInput): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    updateTemplateSubmission(submissionId, {
      status: "approved",
      notes,
    });
    return false;
  }

  const fingerprint = template.fingerprint ?? buildTemplateFingerprintFromTemplate(template, template.name);
  const now = new Date().toISOString();

  // Check for an existing version with the same fingerprint hash to overwrite
  let remoteVersionId = template.remoteVersionId;
  if (!remoteVersionId && fingerprint.fingerprintHash) {
    const { data: existing } = await supabase
      .from("template_versions")
      .select("id")
      .eq("fingerprint->>fingerprintHash", fingerprint.fingerprintHash)
      .limit(1);
    if (existing && existing.length > 0) {
      remoteVersionId = existing[0].id;
    }
  }
  remoteVersionId = remoteVersionId ?? `approved-${submissionId}`;

  const { error: versionError } = await supabase.from("template_versions").upsert({
    id: remoteVersionId,
    family_id: familyId,
    template_id: template.id,
    version,
    status: "verified",
    fingerprint,
    template_payload: {
      ...template,
      status: "verified",
      familyId,
      remoteVersionId,
      source: "verified-cloud",
      fingerprint,
    },
    notes,
    verified_at: now,
    submitted_at: now,
  });

  if (versionError) {
    console.warn("Failed to approve template submission", versionError);
    return false;
  }

  await supabase.from("template_submissions").update({
    status: "approved",
    notes,
  }).eq("id", submissionId);

  updateTemplateSubmission(submissionId, {
    status: "approved",
    notes,
  });

  upsertTemplateCacheEntries([
    {
      cacheKey: `${remoteVersionId}:${version}`,
      familyId,
      versionId: remoteVersionId,
      source: "verified-cloud",
      fingerprint,
      template: {
        ...template,
        status: "verified",
        familyId,
        remoteVersionId,
        version,
        source: "verified-cloud",
        fingerprint,
        updatedAt: now,
      },
      cachedAt: now,
      expiresAt: new Date(Date.now() + DEFAULT_CACHE_TTL_MS).toISOString(),
    },
  ]);

  return true;
}

export async function rejectTemplateSubmission(submissionId: string, notes?: string): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    updateTemplateSubmission(submissionId, {
      status: "rejected",
      notes,
    });
    return false;
  }

  const { error } = await supabase.from("template_submissions").update({
    status: "rejected",
    notes,
  }).eq("id", submissionId);

  if (error) {
    console.warn("Failed to reject template submission", error);
    return false;
  }

  updateTemplateSubmission(submissionId, {
    status: "rejected",
    notes,
  });

  return true;
}
