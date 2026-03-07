import type { ProjectDocument } from "@/types";
import styles from "./DocumentList.module.css";

interface DocumentListProps {
  documents: ProjectDocument[];
  onOpen: (doc: ProjectDocument) => void;
  onFill: (doc: ProjectDocument) => void;
  onPreview: (doc: ProjectDocument) => void;
  onRemove: (docId: string) => void;
}

const STATUS_LABELS: Record<ProjectDocument["status"], string> = {
  pending: "Processing",
  matched: "Ready",
  filled: "Filled",
};

export function DocumentList({ documents, onOpen, onFill, onPreview, onRemove }: DocumentListProps) {
  if (documents.length === 0) return null;

  return (
    <div className={styles.list}>
      <h3 className={styles.heading}>DOCUMENTS</h3>
      {documents.map((doc) => (
        <div key={doc.id} className={styles.row}>
          <button type="button" className={styles.name} onClick={() => onOpen(doc)}>
            {doc.fileName}
          </button>
          <span className={`${styles.badge} ${styles[doc.status]}`}>
            {STATUS_LABELS[doc.status]}
          </span>
          {(doc.status === "matched" || doc.status === "filled") && doc.templateId && (
            <>
              <button
                type="button"
                className={styles.previewBtn}
                onClick={() => onPreview(doc)}
                title="Preview filled PDF"
              >
                Preview
              </button>
              <button
                type="button"
                className={styles.fillBtn}
                onClick={() => onFill(doc)}
                title={doc.status === "filled" ? "Re-export filled PDF" : "Fill and save PDF"}
              >
                {doc.status === "filled" ? "Re-export" : "Fill"}
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.removeBtn}
            onClick={() => onRemove(doc.id)}
            title="Remove document"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
