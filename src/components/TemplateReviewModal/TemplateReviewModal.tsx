import { useState, useCallback } from "react";
import type { Template, TemplateField, Project } from "@/types";
import { PdfPageCanvas } from "@/components/PdfPageCanvas/PdfPageCanvas";
import { DraggableField } from "@/components/DraggableField/DraggableField";
import styles from "./TemplateReviewModal.module.css";

const PROJECT_KEY_LABELS: Record<string, string> = {
  label: "Project label",
  jobName: "Job name",
  jobNumber: "Job number",
  productionCompany: "Production company",
  billingAddress: "Billing address",
  producer: "Producer",
  email: "Email",
  phone: "Phone",
  creditCardType: "Credit card type",
  creditCardHolder: "Credit card holder",
  creditCardNumber: "Credit card number",
  expDate: "Exp date",
  ccv: "CCV",
};

interface TemplateReviewModalProps {
  template: Template;
  project?: Project | null;
  pdfBytes?: Uint8Array | null;
  onClose: () => void;
  onSave: (template: Template) => void;
  onFieldChange: (fieldId: string, updates: Partial<TemplateField>) => void;
  onDeleteField: (fieldId: string) => void;
  onAddField: () => void;
  onProjectChange?: (updates: Partial<Project>) => void;
}

export function TemplateReviewModal({
  template,
  project,
  pdfBytes,
  onClose,
  onSave,
  onFieldChange,
  onDeleteField,
  onAddField,
  onProjectChange,
}: TemplateReviewModalProps) {
  const [pageDims, setPageDims] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  const handleDimensions = useCallback((dims: { width: number; height: number; scale: number }) => {
    setPageDims(dims);
  }, []);

  const selectedField = template.fields.find((f) => f.id === selectedFieldId);

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
                    onChange={(updates) => onFieldChange(f.id, updates)}
                    projectValue={f.mappedProjectKey === "creditCardType" && project ? project.creditCardType : undefined}
                    onCheckboxClick={
                      f.fieldType === "checkbox" && f.mappedProjectKey === "creditCardType" && onProjectChange
                        ? (value) => onProjectChange({ creditCardType: value as Project["creditCardType"] })
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
                    onChange={(e) =>
                      onFieldChange(f.id, {
                        mappedProjectKey: (e.target.value || "") as keyof Project | "",
                      })
                    }
                  >
                    <option value="">— Not mapped —</option>
                    {(Object.keys(PROJECT_KEY_LABELS) as (keyof Project)[]).map((key) => (
                      <option key={key} value={key}>
                        {PROJECT_KEY_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  <div className={styles.fieldCoords}>
                    <span>x: {Math.round(f.x)}</span>
                    <span>y: {Math.round(f.y)}</span>
                    <span>w: {Math.round(f.width)}</span>
                    <span>h: {Math.round(f.height)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" className={styles.addFieldBtn} onClick={onAddField}>
              + Add field
            </button>

            {selectedField && (
              <div className={styles.selectedInfo}>
                <h4>Selected: {selectedField.label}</h4>
                <p className={styles.selectedHint}>
                  Drag to reposition. Use edge handles to resize width, corner handle to resize both.
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
            className={styles.saveBtn}
            onClick={() => onSave(template)}
          >
            Save template locally
          </button>
        </footer>
      </div>
    </div>
  );
}
