import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Project, Template, TemplateField } from "@/types";

function getValue(project: Project, field: TemplateField): string {
  const key = field.mappedProjectKey;
  if (!key) return "";
  const v = project[key];
  return typeof v === "string" ? v : "";
}

function fitTextToWidth(text: string, width: number, font: any, fontSize: number): string {
  if (!text) return "";
  const maxWidth = Math.max(0, width - 6); // padding
  if (maxWidth <= 0) return text;
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;

  const ellipsis = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) lo = mid + 1;
    else hi = mid;
  }
  const cut = Math.max(0, lo - 1);
  return text.slice(0, cut) + ellipsis;
}

export interface WritePdfOptions {
  /** Default font size used when field height is unknown/too small. */
  defaultFontSize?: number;
}

/**
 * Writes project values onto an existing (possibly flat) PDF using positioned template fields.
 * Coordinates are interpreted as top-left origin values (UI-style), then converted to PDF-space.
 */
export async function writeFilledPdfBytes(
  sourcePdfBytes: Uint8Array,
  template: Template,
  project: Project,
  options: WritePdfOptions = {}
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(sourcePdfBytes);
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const defaultFontSize = options.defaultFontSize ?? 10;

  for (const field of template.fields) {
    const pageIndex = Math.max(0, Math.min(pages.length - 1, field.pageNumber - 1));
    const page = pages[pageIndex];

    const pageHeight = page.getHeight();
    const rawValue = getValue(project, field);
    if (!rawValue) continue;

    // Interpret template coords as top-left origin (like the editor overlay).
    const x = field.x;
    const yPdfBottom = pageHeight - (field.y + field.height);

    if (field.fieldType === "checkbox") {
      // For checkboxes, check if the project value matches this checkbox's value
      if (field.checkboxValue && rawValue === field.checkboxValue) {
        // Draw a checkmark or X
        const checkSize = Math.min(field.width, field.height) * 0.8;
        const centerX = x + field.width / 2;
        const centerY = yPdfBottom + field.height / 2;
        
        // Draw an X mark
        page.drawText("✓", {
          x: centerX - checkSize / 3,
          y: centerY - checkSize / 3,
          size: checkSize,
          font,
          color: rgb(0.1, 0.1, 0.1),
        });
      }
    } else {
      // Text field
      let fontSize = defaultFontSize;
      if (field.height > 0) {
        fontSize = Math.max(7, Math.min(12, Math.floor(field.height * 0.75)));
      }

      const value = fitTextToWidth(rawValue, field.width, font, fontSize);

      page.drawText(value, {
        x: x + 3,
        y: yPdfBottom + Math.max(2, (field.height - fontSize) / 2),
        size: fontSize,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}

