import type { Project, Template } from "@/types";

export interface FilledField {
  fieldId: string;
  label: string;
  mappedProjectKey: keyof Project | "";
  value: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export function buildFilledFields(project: Project, template: Template): FilledField[] {
  return template.fields.map((f) => {
    const key = f.mappedProjectKey;
    const value =
      key && typeof project[key] === "string"
        ? (project[key] as string)
        : "";
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

