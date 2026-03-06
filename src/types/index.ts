/**
 * Wrapkit type definitions.
 * Structured so PDF and cloud logic can be added later without changing these cores.
 */

/** Credit card type options */
export type CreditCardType = "visa" | "mastercard" | "discover" | "amex" | "";

/** Project/job as used across the app */
export interface Project {
  id: string;
  label: string;
  jobName: string;
  jobNumber: string;
  poNumber: string;
  productionCompany: string;
  billingAddress: string;
  producer: string;
  email: string;
  phone: string;
  creditCardType: CreditCardType;
  creditCardHolder: string;
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
  mappedProjectKey: keyof Project | "";
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0–1, from auto-detection or manual */
  confidence: number;
  /** Field type: text input or checkbox */
  fieldType?: "text" | "checkbox";
  /** For checkbox fields: which value triggers this checkbox to be checked */
  checkboxValue?: string;
}

/** A saved template (local or verified) */
export interface Template {
  id: string;
  name: string;
  /** e.g. 'verified' | 'community' | 'local-draft' */
  status: TemplateStatus;
  version?: string;
  fields: TemplateField[];
  /** For matching: page count, fingerprint hints, etc. */
  pageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export type TemplateStatus = "local-draft" | "community-submitted" | "verified";

/** Result of attempting to match an uploaded PDF to a template */
export type MatchResultKind = "verified" | "possible" | "none";

export interface TemplateMatch {
  templateId: string;
  templateName: string;
  status: TemplateStatus;
  confidence: number;
  version?: string;
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
}
