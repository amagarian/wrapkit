import { useState, useCallback, useEffect } from "react";
import type { Template, TemplateField, Project, TemplateMappedProjectKey } from "@/types";
import { PdfPageCanvas } from "@/components/PdfPageCanvas/PdfPageCanvas";
import { DraggableField } from "@/components/DraggableField/DraggableField";
import { getTemplateFieldValue } from "@/utils/fill";
import styles from "./TemplateReviewModal.module.css";

const PROJECT_KEY_LABELS: Record<string, string> = {
  label: "Project label",
  jobName: "Job name",
  jobNumber: "Job number",
  poNumber: "PO number",
  authorizationDate: "Authorization date",
  productionCompany: "Production company",
  billingAddress: "Billing address",
  billingZipCode: "Billing zip code",
  producer: "Producer",
  email: "Email",
  phone: "Phone",
  creditCardType: "Credit card type",
  keepCardOnFile: "Keep card on file",
  creditCardHolder: "Credit card holder",
  cardholderSignature: "Cardholder signature",
  creditCardNumber: "Credit card number",
  expDate: "Exp date",
  ccv: "CCV",
};

const CHECKBOX_VALUE_LABELS: Record<string, string> = {
  yes: "Yes / checked",
  visa: "VISA",
  mastercard: "MasterCard",
  discover: "Discover",
  amex: "AMEX",
};

function isCheckboxField(field: TemplateField): boolean {
  return (
    field.fieldType === "checkbox" ||
    field.fieldKind === "checkbox-group" ||
    field.fieldKind === "boolean-checkbox"
  );
}

function formatDetectionSource(source: TemplateField["detectionSource"]): string {
  switch (source) {
    case "text-inline":
      return "inline text";
    case "text-line":
      return "text line";
    case "geometry-line":
      return "geometry line";
    case "geometry-box":
      return "geometry box";
    case "glyph-checkbox":
      return "checkbox glyph";
    case "acroform":
      return "acroform";
    case "manual":
      return "manual";
    default:
      return "detected";
  }
}

interface TemplateReviewModalProps {
  template: Template;
  project?: Project | null;
  pdfBytes?: Uint8Array | null;
  onClose: () => void;
  onSave: (template: Template) => void;
  onSubmitForVerification: (template: Template) => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  onBeginFieldEdit: () => void;
  onFieldChange: (fieldId: string, updates: Partial<TemplateField>) => void;
  onDeleteField: (fieldId: string) => void;
  onAddField: () => void;
  onAddCheckbox: () => void;
  onProjectChange?: (updates: Partial<Project>) => void;
}

export function TemplateReviewModal({
  template,
  project,
  pdfBytes,
  onClose,
  onSave,
  onSubmitForVerification,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  onBeginFieldEdit,
  onFieldChange,
  onDeleteField,
  onAddField,
  onAddCheckbox,
  onProjectChange,
}: TemplateReviewModalProps) {
  const [pageDims, setPageDims] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const handleDimensions = useCallback((dims: { width: number; height: number; scale: number }) => {
    setPageDims(dims);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isEditable =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        Boolean(target?.isContentEditable);
      if (isEditable) {
        return;
      }
      if (event.shiftKey) {
        if (!canRedo) {
          return;
        }
        event.preventDefault();
        onRedo();
        return;
      }
      if (!canUndo) {
        return;
      }
      event.preventDefault();
      onUndo();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canRedo, canUndo, onRedo, onUndo]);

  const selectedField = template.fields.find((f) => f.id === selectedFieldId);
  const saveLabel = template.status === "verified" ? "Save local override" : "Save template locally";

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="template-modal-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <h2 id="template-modal-title" className={styles.title}>
            Template review — {template.name}
          </h2>
          <span className={styles.hint}>Click a field to select, drag to move, use handles to resize</span>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.previewArea} onClick={() => setSelectedFieldId(null)}>
            {pdfBytes ? (
              <div className={styles.pdfContainer}>
                <PdfPageCanvas
                  pdfBytes={pdfBytes}
                  pageNumber={1}
                  maxWidth={580}
                  maxHeight={720}
                  onDimensions={handleDimensions}
                />
                {pageDims && template.fields.filter((f) => f.pageNumber === 1).map((f) => (
                  <DraggableField
                    key={f.id}
                    field={f}
                    scale={pageDims.scale}
                    selected={f.id === selectedFieldId}
                    onSelect={() => setSelectedFieldId(f.id)}
                    onChangeStart={onBeginFieldEdit}
                    onChange={(updates) => onFieldChange(f.id, updates)}
                    projectValue={project ? getTemplateFieldValue(project, f) : undefined}
                    onCheckboxClick={
                      f.fieldType === "checkbox" && onProjectChange
                        ? (value) => {
                            if (f.mappedProjectKey === "creditCardType") {
                              onProjectChange({ creditCardType: value as Project["creditCardType"] });
                            } else if (f.mappedProjectKey === "keepCardOnFile") {
                              onProjectChange({ keepCardOnFile: value as Project["keepCardOnFile"] });
                            }
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <div className={styles.pdfPlaceholder}>
                No PDF loaded. Drop a PDF first to see preview.
              </div>
            )}
          </div>

          <aside className={styles.sidebar}>
            <h3 className={styles.sidebarTitle}>Fields ({template.fields.length})</h3>
            <ul className={styles.fieldList}>
              {template.fields.map((f) => (
                <li
                  key={f.id}
                  className={`${styles.fieldItem} ${f.id === selectedFieldId ? styles.fieldItemSelected : ""}`}
                  onClick={() => setSelectedFieldId(f.id)}
                >
                  <div className={styles.fieldItemRow}>
                    <span className={styles.fieldItemLabel}>{f.label}</span>
                    <button
                      type="button"
                      className={styles.deleteBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBeginFieldEdit();
                        onDeleteField(f.id);
                      }}
                      title="Delete field"
                    >
                      ×
                    </button>
                  </div>
                  <select
                    className={styles.select}
                    value={f.mappedProjectKey || ""}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      onBeginFieldEdit();
                      onFieldChange(f.id, {
                        mappedProjectKey: (e.target.value || "") as TemplateMappedProjectKey,
                        ...(isCheckboxField(f)
                          ? {
                              fieldKind:
                                e.target.value === "creditCardType"
                                  ? ("checkbox-group" as const)
                                  : ("boolean-checkbox" as const),
                              checkboxValue:
                                e.target.value === "creditCardType"
                                  ? f.checkboxValue && f.checkboxValue !== "yes"
                                    ? f.checkboxValue
                                    : "visa"
                                  : "yes",
                            }
                          : {}),
                      });
                    }}
                  >
                    <option value="">— Not mapped —</option>
                    {(Object.keys(PROJECT_KEY_LABELS) as (keyof Project)[]).map((key) => (
                      <option key={key} value={key}>
                        {PROJECT_KEY_LABELS[key]}
                      </option>
                    ))}
                    {!isCheckboxField(f) && <option value="__custom__">Custom value</option>}
                    {!isCheckboxField(f) && <option value="__prompt__">Prompt at fill time</option>}
                  </select>
                  {!isCheckboxField(f) && f.mappedProjectKey === "__custom__" && (
                    <input
                      type="text"
                      className={styles.input}
                      value={f.customValue ?? ""}
                      placeholder="Enter custom field value"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, { customValue: e.target.value });
                      }}
                    />
                  )}
                  {!isCheckboxField(f) && f.mappedProjectKey === "__prompt__" && (
                    <input
                      type="text"
                      className={styles.input}
                      value={f.promptLabel ?? ""}
                      placeholder="Prompt label, e.g. Charge authorization amount"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, { promptLabel: e.target.value });
                      }}
                    />
                  )}
                  {isCheckboxField(f) && (
                    <select
                      className={styles.select}
                      value={f.checkboxValue || "yes"}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        onBeginFieldEdit();
                        onFieldChange(f.id, {
                          checkboxValue: e.target.value,
                          fieldKind:
                            e.target.value === "visa" ||
                            e.target.value === "mastercard" ||
                            e.target.value === "discover" ||
                            e.target.value === "amex"
                              ? "checkbox-group"
                              : "boolean-checkbox",
                        });
                      }}
                    >
                      {Object.entries(CHECKBOX_VALUE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          Check when value is {label}
                        </option>
                      ))}
                    </select>
                  )}
                  <div className={styles.fieldCoords}>
                    <span>x: {Math.round(f.x)}</span>
                    <span>y: {Math.round(f.y)}</span>
                    <span>w: {Math.round(f.width)}</span>
                    <span>h: {Math.round(f.height)}</span>
                  </div>
                  <div className={styles.fieldMeta}>
                    <span>{f.fieldKind ?? f.fieldType ?? "text"}</span>
                    <span>{formatDetectionSource(f.detectionSource)}</span>
                    <span>{Math.round((f.confidence ?? 0) * 100)}%</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className={styles.addActions}>
              <button type="button" className={styles.addFieldBtn} onClick={onAddField}>
                + Add field
              </button>
              <button type="button" className={styles.addFieldBtn} onClick={onAddCheckbox}>
                + Add checkbox
              </button>
            </div>

            {selectedField && (
              <div className={styles.selectedInfo}>
                <h4>Selected: {selectedField.label}</h4>
                <p className={styles.selectedHint}>
                  Drag to reposition. Use edge handles to resize width, corner handle to resize both. Use Cmd/Ctrl+Z to undo and Shift+Cmd/Ctrl+Z to redo.
                </p>
              </div>
            )}
          </aside>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={() => onSubmitForVerification(template)}
          >
            Submit for verification
          </button>
          <button
            type="button"
            className={styles.saveBtn}
            onClick={() => onSave(template)}
          >
            {saveLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
