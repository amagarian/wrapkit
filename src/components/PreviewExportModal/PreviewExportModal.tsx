import type { Project, Template } from "@/types";
import type { FilledField } from "@/utils/fill";
import styles from "./PreviewExportModal.module.css";

interface PreviewExportModalProps {
  template: Template;
  project: Project;
  filledFields: FilledField[];
  fileName?: string;
  onClose: () => void;
  onExport: () => void;
  exportLabel?: string;
}

export function PreviewExportModal({
  template,
  project,
  filledFields,
  fileName,
  onClose,
  onExport,
  exportLabel = "Export PDF",
}: PreviewExportModalProps) {
  const formatMappedKey = (key: FilledField["mappedProjectKey"]) =>
    key === "__custom__" ? "Custom value" : key === "__prompt__" ? "Prompt at fill time" : key || "—";

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="preview-modal-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <div>
            <h2 id="preview-modal-title" className={styles.title}>
              Preview before export
            </h2>
            <p className={styles.subtitle}>
              {fileName ?? "document.pdf"} · {template.name} · {project.label || project.jobName || "Untitled project"}
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.tableHeader}>
            <span>Field</span>
            <span>Mapped key</span>
            <span>Value</span>
          </div>
          <div className={styles.rows}>
            {filledFields.map((f) => (
              <div key={f.fieldId} className={styles.row}>
                <span className={styles.fieldLabel}>{f.label}</span>
                <span className={styles.mappedKey}>{formatMappedKey(f.mappedProjectKey)}</span>
                <span className={styles.value}>{f.value || "—"}</span>
              </div>
            ))}
          </div>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Close
          </button>
          <button type="button" className={styles.primaryBtn} onClick={onExport}>
            {exportLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

