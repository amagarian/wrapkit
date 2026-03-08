/**
 * Wrapkit type definitions.
 * Structured so PDF and cloud logic can be added later without changing these cores.
 */

/** Credit card type options */
export type CreditCardType = "visa" | "mastercard" | "discover" | "amex" | "";
export type TemplateMappedProjectKey = keyof Project | "__custom__" | "__prompt__" | "";
export type CanonicalFieldId =
  | "projectLabel"
  | "jobName"
  | "jobNumber"
  | "poNumber"
  | "authorizationDate"
  | "productionCompany"
  | "billingAddress"
  | "billingCity"
  | "billingState"
  | "billingZipCode"
  | "producer"
  | "email"
  | "phone"
  | "creditCardTypeVisa"
  | "creditCardTypeMastercard"
  | "creditCardTypeDiscover"
  | "creditCardTypeAmex"
  | "creditCardHolder"
  | "cardholderSignature"
  | "creditCardNumber"
  | "expDate"
  | "ccv";

export type TemplateFieldKind =
  | "text"
  | "multiline"
  | "date"
  | "signature"
  | "checkbox-group"
  | "boolean-checkbox";

export type TemplateFieldSource =
  | "text-inline"
  | "text-line"
  | "geometry-line"
  | "geometry-box"
  | "glyph-checkbox"
  | "acroform"
  | "manual";

export interface ConfidenceDetails {
  total: number;
  label?: number;
  geometry?: number;
  section?: number;
  source?: number;
  reason?: string;
}

/** Project/job as used across the app */
export interface Project {
  id: string;
  label: string;
  jobName: string;
  jobNumber: string;
  poNumber: string;
  authorizationDate: string;
  productionCompany: string;
  billingAddress: string;
  billingCity: string;
  billingState: string;
  billingZipCode: string;
  producer: string;
  email: string;
  phone: string;
  creditCardType: CreditCardType;
  creditCardHolder: string;
  cardholderSignature: string;
  creditCardNumber: string;
  expDate: string;
  ccv: string;
  createdAt: string;
  updatedAt: string;
}

/** A single field definition on a template (position + mapping) */
export interface TemplateField {
  id: string;
  label: string;
  /** Key in Project that supplies the value */
  mappedProjectKey: TemplateMappedProjectKey;
  canonicalFieldId?: CanonicalFieldId;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0–1, from auto-detection or manual */
  confidence: number;
  /** Field type: text input or checkbox */
  fieldType?: "text" | "checkbox";
  /** Richer field semantics used by the detector and writer. */
  fieldKind?: TemplateFieldKind;
  detectionSource?: TemplateFieldSource;
  sectionId?: string;
  groupId?: string;
  anchorText?: string;
  confidenceDetails?: ConfidenceDetails;
  /** For checkbox fields: which value triggers this checkbox to be checked */
  checkboxValue?: string;
  /** Literal value for manual one-off fields not bound to Project. */
  customValue?: string;
  /** Prompt label shown when this field is collected at fill time. */
  promptLabel?: string;
}

export type TemplateRegistrySource =
  | "local-draft"
  | "local-override"
  | "verified-cache"
  | "verified-cloud"
  | "community-submitted"
  | "seed";

export interface PageFingerprint {
  pageNumber: number;
  width: number;
  height: number;
  anchorTerms: string[];
  textDigest: string;
}

export interface TemplateFingerprint {
  version: number;
  pageCount: number;
  pageFingerprints: PageFingerprint[];
  anchorTerms: string[];
  checkboxTerms: string[];
  canonicalFieldIds: CanonicalFieldId[];
  fileNameHints: string[];
  fingerprintHash: string;
}

/** A saved template (local or verified) */
export interface Template {
  id: string;
  name: string;
  /** e.g. 'verified' | 'community' | 'local-draft' */
  status: TemplateStatus;
  version?: string;
  familyId?: string;
  remoteVersionId?: string;
  source?: TemplateRegistrySource;
  fingerprint?: TemplateFingerprint;
  fields: TemplateField[];
  /** For matching: page count, fingerprint hints, etc. */
  pageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type TemplateStatus = "local-draft" | "community-submitted" | "verified";

export interface TemplateFamily {
  id: string;
  slug: string;
  vendorName: string;
  formName: string;
  documentType: string;
  latestVerifiedVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateVersion {
  id: string;
  familyId: string;
  templateId: string;
  version: string;
  status: TemplateStatus;
  fingerprint: TemplateFingerprint;
  sourcePdfPath?: string;
  previewImagePath?: string;
  submittedAt?: string;
  verifiedAt?: string;
  notes?: string;
  template: Template;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateCacheEntry {
  cacheKey: string;
  familyId: string;
  versionId: string;
  source: Extract<TemplateRegistrySource, "verified-cache" | "verified-cloud" | "seed">;
  fingerprint: TemplateFingerprint;
  template: Template;
  cachedAt: string;
  expiresAt?: string;
}

export type TemplateSubmissionStatus =
  | "pending-upload"
  | "queued"
  | "submitted"
  | "approved"
  | "rejected";

export interface TemplateSubmission {
  id: string;
  templateId: string;
  templateName: string;
  status: TemplateSubmissionStatus;
  pdfFileName: string;
  fingerprint: TemplateFingerprint;
  template: Template;
  sourceProjectId?: string;
  sourcePdfPath?: string;
  submittedAt: string;
  notes?: string;
}

export type ProjectDocumentStatus = "pending" | "matched" | "filled";

export interface ProjectDocument {
  id: string;
  projectId: string;
  fileName: string;
  templateId?: string;
  matchResult?: PdfMatchResult;
  pdfBytes?: Uint8Array;
  status: ProjectDocumentStatus;
  createdAt: string;
  updatedAt: string;
}

/** Result of attempting to match an uploaded PDF to a template */
export type MatchResultKind = "verified" | "possible" | "none";

export interface TemplateMatch {
  templateId: string;
  familyId?: string;
  versionId?: string;
  templateName: string;
  status: TemplateStatus;
  confidence: number;
  version?: string;
  source?: TemplateRegistrySource;
}

/** UI state after PDF intake */
export interface PdfMatchResult {
  kind: MatchResultKind;
  /** When kind === 'verified', single match */
  verifiedMatch?: TemplateMatch;
  /** When kind === 'possible', ranked list */
  possibleMatches?: TemplateMatch[];
  /** When kind === 'none', we may still create a draft template with guessed fields */
  draftTemplateId?: string;
  /** Simulated filename for display */
  fileName?: string;
  lookupMessage?: string;
  matchSource?: TemplateRegistrySource | "detector";
  syncState?: "idle" | "matching" | "matched" | "error";
}
