import type { ProjectDocument } from "@/types";
import styles from "./DocumentList.module.css";

interface DocumentListProps {
  documents: ProjectDocument[];
  onOpen: (doc: ProjectDocument) => void;
  onDownload: (doc: ProjectDocument) => void;
  onEditTemplate: (doc: ProjectDocument) => void;
  onPreview: (doc: ProjectDocument) => void;
  onRemove: (docId: string) => void;
}

export function DocumentList({ documents, onOpen, onDownload, onEditTemplate, onPreview, onRemove }: DocumentListProps) {
  if (documents.length === 0) return null;

  return (
    <div className={styles.list}>
      <h3 className={styles.heading}>DOCUMENTS</h3>
      {documents.map((doc) => {
        const hasTemplate = Boolean(doc.templateId);
        const isFilled = doc.status === "filled";

        return (
          <div key={doc.id} className={styles.row}>
            <button type="button" className={styles.name} onClick={() => onOpen(doc)}>
              {doc.fileName}
            </button>

            {doc.status === "pending" && (
              <span className={`${styles.badge} ${styles.pending}`}>Processing</span>
            )}

            {hasTemplate && (
              <span className={`${styles.badge} ${doc.matchResult?.kind === "verified" ? styles.verified : styles.unverified}`}>
                {doc.matchResult?.kind === "verified" ? "Verified" : "Unverified"}
              </span>
            )}

            {hasTemplate && (
              <>
                <button
                  type="button"
                  className={styles.editTemplateBtn}
                  onClick={() => onEditTemplate(doc)}
                  title="Edit template fields"
                >
                  Edit Template
                </button>
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
                  className={styles.downloadBtn}
                  onClick={() => onDownload(doc)}
                  title="Download filled PDF"
                >
                  Download
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
        );
      })}
    </div>
  );
}
