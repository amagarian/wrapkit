import type { PdfMatchResult } from "@/types";
import styles from "./MatchStatusModal.module.css";

interface MatchStatusModalProps {
  result: PdfMatchResult;
  onClose: () => void;
  onOpenTemplateReview: (templateId: string) => void;
  onFillNow: (templateId: string) => void;
  onPreviewBeforeExport: (templateId: string) => void;
  onChoosePossibleMatch: (templateId: string) => void;
  onCreateNewTemplate: () => void;
  onEditTemplate: (templateId: string) => void;
}

export function MatchStatusModal({
  result,
  onClose,
  onOpenTemplateReview,
  onFillNow,
  onPreviewBeforeExport,
  onChoosePossibleMatch,
  onCreateNewTemplate,
  onEditTemplate,
}: MatchStatusModalProps) {
  const { kind, verifiedMatch, possibleMatches, draftTemplateId, fileName, lookupMessage, matchSource, syncState } = result;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <span className={styles.fileName}>{fileName ?? "document.pdf"}</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </header>

        {lookupMessage && (
          <p className={styles.statusNote}>
            {lookupMessage}
            {matchSource ? ` Source: ${matchSource}.` : ""}
            {syncState === "matching" ? " Matching..." : ""}
          </p>
        )}

        <div className={styles.body}>
          {kind === "verified" && verifiedMatch && (
            <div className={styles.card}>
              <span className={`${styles.badge} ${styles.verified}`}>Verified template</span>
              <h3 className={styles.title}>{verifiedMatch.templateName}</h3>
              <p className={styles.meta}>
                v{verifiedMatch.version ?? "1.0"} · {Math.round(verifiedMatch.confidence * 100)}% match
              </p>
              <div className={styles.actions}>
                <button type="button" className={styles.primaryBtn} onClick={() => onFillNow(verifiedMatch.templateId)}>
                  Fill now
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => onPreviewBeforeExport(verifiedMatch.templateId)}>
                  Preview
                </button>
                <button type="button" className={styles.secondaryBtn} onClick={() => onEditTemplate(verifiedMatch.templateId)}>
                  Edit
                </button>
              </div>
            </div>
          )}

          {kind === "possible" && possibleMatches && possibleMatches.length > 0 && (
            <div className={styles.card}>
              <span className={`${styles.badge} ${styles.possible}`}>Possible matches</span>
              <p className={styles.hint}>Choose a template or create a new one.</p>
              <ul className={styles.matchList}>
                {possibleMatches.map((m) => (
                  <li key={m.templateId} className={styles.matchItem}>
                    <span className={styles.matchName}>{m.templateName}</span>
                    <span className={styles.matchConfidence}>{Math.round(m.confidence * 100)}%</span>
                    <button type="button" className={styles.chooseBtn} onClick={() => onChoosePossibleMatch(m.templateId)}>
                      Use this
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className={styles.secondaryBtn} onClick={onCreateNewTemplate}>
                Create new template
              </button>
            </div>
          )}

          {kind === "none" && (
            <div className={styles.card}>
              <span className={`${styles.badge} ${styles.none}`}>No verified template</span>
              <p className={styles.hint}>
                A draft template with guessed fields was created. Open the editor to refine and save.
              </p>
              {draftTemplateId && (
                <button type="button" className={styles.primaryBtn} onClick={() => onOpenTemplateReview(draftTemplateId)}>
                  Open template editor
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
