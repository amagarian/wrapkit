import type { Template, TemplateCacheEntry, TemplateSubmission } from "@/types";

const TEMPLATE_CACHE_KEY = "wrapkit.template-cache.v1";
const TEMPLATE_SUBMISSIONS_KEY = "wrapkit.template-submissions.v1";
const LOCAL_TEMPLATES_KEY = "wrapkit.local-templates.v1";

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback;

  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (error) {
    console.warn(`Failed to read local cache key "${key}"`, error);
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  if (!canUseStorage()) return;

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn(`Failed to write local cache key "${key}"`, error);
  }
}

export function readTemplateCacheEntries(): TemplateCacheEntry[] {
  return readJson<TemplateCacheEntry[]>(TEMPLATE_CACHE_KEY, []);
}

export function writeTemplateCacheEntries(entries: TemplateCacheEntry[]): void {
  writeJson(TEMPLATE_CACHE_KEY, entries);
}

export function upsertTemplateCacheEntries(entries: TemplateCacheEntry[]): TemplateCacheEntry[] {
  const existing = readTemplateCacheEntries();
  const merged = new Map<string, TemplateCacheEntry>();

  [...existing, ...entries].forEach((entry) => {
    merged.set(entry.cacheKey, entry);
  });

  const nextEntries = [...merged.values()].sort((left, right) =>
    right.cachedAt.localeCompare(left.cachedAt)
  );
  writeTemplateCacheEntries(nextEntries);
  return nextEntries;
}

export function readTemplateSubmissions(): TemplateSubmission[] {
  return readJson<TemplateSubmission[]>(TEMPLATE_SUBMISSIONS_KEY, []);
}

export function writeTemplateSubmissions(submissions: TemplateSubmission[]): void {
  writeJson(TEMPLATE_SUBMISSIONS_KEY, submissions);
}

export function readLocalTemplates(): Template[] {
  return readJson<Template[]>(LOCAL_TEMPLATES_KEY, []);
}

export function writeLocalTemplates(templates: Template[]): void {
  writeJson(LOCAL_TEMPLATES_KEY, templates);
}

export function upsertLocalTemplate(template: Template): Template[] {
  const existing = readLocalTemplates().filter((entry) => entry.id !== template.id);
  const nextTemplates = [template, ...existing].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
  writeLocalTemplates(nextTemplates);
  return nextTemplates;
}

export function queueTemplateSubmission(submission: TemplateSubmission): TemplateSubmission[] {
  const existing = readTemplateSubmissions().filter((entry) => entry.id !== submission.id);
  const nextSubmissions = [submission, ...existing].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  writeTemplateSubmissions(nextSubmissions);
  return nextSubmissions;
}

export function updateTemplateSubmission(
  submissionId: string,
  updates: Partial<TemplateSubmission>
): TemplateSubmission[] {
  const nextSubmissions = readTemplateSubmissions().map((submission) =>
    submission.id === submissionId ? { ...submission, ...updates } : submission
  );
  writeTemplateSubmissions(nextSubmissions);
  return nextSubmissions;
}
