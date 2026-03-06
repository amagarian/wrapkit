import type { Template, TemplateField } from "@/types";

const baseFields: TemplateField[] = [
  {
    id: "f1",
    label: "Production Company",
    mappedProjectKey: "productionCompany",
    pageNumber: 1,
    x: 120,
    y: 180,
    width: 280,
    height: 22,
    confidence: 0.95,
    fieldType: "text",
  },
  {
    id: "f2",
    label: "Job Name",
    mappedProjectKey: "jobName",
    pageNumber: 1,
    x: 120,
    y: 220,
    width: 280,
    height: 22,
    confidence: 0.9,
    fieldType: "text",
  },
  {
    id: "f3",
    label: "Billing Address",
    mappedProjectKey: "billingAddress",
    pageNumber: 1,
    x: 120,
    y: 260,
    width: 320,
    height: 22,
    confidence: 0.88,
    fieldType: "text",
  },
  {
    id: "f4",
    label: "Producer",
    mappedProjectKey: "producer",
    pageNumber: 1,
    x: 120,
    y: 300,
    width: 200,
    height: 22,
    confidence: 0.92,
    fieldType: "text",
  },
  {
    id: "f5",
    label: "Email",
    mappedProjectKey: "email",
    pageNumber: 1,
    x: 120,
    y: 340,
    width: 240,
    height: 22,
    confidence: 0.9,
    fieldType: "text",
  },
  {
    id: "f6",
    label: "Phone",
    mappedProjectKey: "phone",
    pageNumber: 1,
    x: 120,
    y: 380,
    width: 160,
    height: 22,
    confidence: 0.85,
    fieldType: "text",
  },
];

/** Verified template (would be used for auto-fill) */
export const mockVerifiedTemplate: Template = {
  id: "tpl-verified-1",
  name: "Vendor Agreement — Standard (2024)",
  status: "verified",
  version: "1.2",
  fields: baseFields.map((f) => ({ ...f, id: `v-${f.id}` })),
  pageCount: 2,
  createdAt: "2024-06-01T00:00:00Z",
  updatedAt: "2024-11-15T00:00:00Z",
};

/** Possible matches for "possible match" state */
export const mockPossibleTemplates: Template[] = [
  {
    ...mockVerifiedTemplate,
    id: "tpl-possible-1",
    name: "Vendor Agreement — Standard (2024)",
    status: "verified",
    version: "1.2",
  },
  {
    id: "tpl-possible-2",
    name: "Vendor Agreement — Legacy",
    status: "community-submitted",
    version: "1.0",
    fields: baseFields.slice(0, 4).map((f, i) => ({ ...f, id: `p2-${i}`, confidence: 0.72 })),
    pageCount: 2,
    createdAt: "2023-01-01T00:00:00Z",
    updatedAt: "2023-06-01T00:00:00Z",
  },
];

/** Draft template with guessed fields (for no-match path) */
export const mockDraftTemplate: Template = {
  id: "tpl-draft-1",
  name: "Unknown form — draft",
  status: "local-draft",
  fields: baseFields.map((f, i) => ({
    ...f,
    id: `draft-${i + 1}`,
    confidence: 0.5 + Math.random() * 0.4,
  })),
  pageCount: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
