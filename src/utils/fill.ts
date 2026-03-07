import type { Project, Template, TemplateField, TemplateMappedProjectKey } from "@/types";

export type PromptFieldValues = Record<string, string>;

export interface FilledField {
  fieldId: string;
  label: string;
  mappedProjectKey: TemplateMappedProjectKey;
  value: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export function getTemplateFieldPromptLabel(field: TemplateField): string {
  return field.promptLabel?.trim() || field.label || "Prompt value";
}

export function getPromptFields(template: Template): TemplateField[] {
  return template.fields.filter((field) => field.mappedProjectKey === "__prompt__");
}

export function getTemplateFieldValue(
  project: Project,
  field: TemplateField,
  promptValues: PromptFieldValues = {}
): string {
  const key = field.mappedProjectKey;
  if (key === "__custom__") {
    return field.customValue?.trim() ?? "";
  }
  if (key === "__prompt__") {
    return promptValues[field.id]?.trim() ?? "";
  }
  if (!key) {
    return "";
  }
  const value = project[key];
  return typeof value === "string" ? value : "";
}

export function buildFilledFields(
  project: Project,
  template: Template,
  promptValues: PromptFieldValues = {}
): FilledField[] {
  return template.fields.map((f) => {
    const value = getTemplateFieldValue(project, f, promptValues);
    return {
      fieldId: f.id,
      label: f.label,
      mappedProjectKey: f.mappedProjectKey,
      value,
      pageNumber: f.pageNumber,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      confidence: f.confidence,
    };
  });
}

