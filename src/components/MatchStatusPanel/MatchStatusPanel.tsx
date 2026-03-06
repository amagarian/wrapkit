import type { PdfMatchResult } from "@/types";
import styles from "./MatchStatusPanel.module.css";

interface MatchStatusPanelProps {
  result: PdfMatchResult;
  onOpenTemplateReview: (templateId: string) => void;
  onFillNow: (templateId: string) => void;
  onPreviewBeforeExport: (templateId: string) => void;
  onChoosePossibleMatch: (templateId: string) => void;
  onCreateNewTemplate: () => void;
  onClearMatch: () => void;
  onEditTemplate: (templateId: string) => void;
}

export function MatchStatusPanel({
  result,
  onOpenTemplateReview,
  onFillNow,
  onPreviewBeforeExport,
  onChoosePossibleMatch,
  onCreateNewTemplate,
  onClearMatch,
  onEditTemplate,
}: MatchStatusPanelProps) {
  const { kind, verifiedMatch, possibleMatches, draftTemplateId, fileName } = result;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.fileName}>{fileName ?? "document.pdf"}</span>
        <button type="button" className={styles.clearBtn} onClick={onClearMatch}>
          Clear
        </button>
      </div>

      {kind === "verified" && verifiedMatch && (
        <div className={styles.card} data-state="verified">
          <div className={styles.badge}>Verified template</div>
          <h3 className={styles.title}>{verifiedMatch.templateName}</h3>
          <p className={styles.meta}>
            v{verifiedMatch.version ?? "1.0"} · {Math.round(verifiedMatch.confidence * 100)}% match
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => onFillNow(verifiedMatch.templateId)}
            >
              Fill now
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => onPreviewBeforeExport(verifiedMatch.templateId)}
            >
              Preview before export
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => onEditTemplate(verifiedMatch.templateId)}
            >
              Edit template
            </button>
          </div>
        </div>
      )}

      {kind === "possible" && possibleMatches && possibleMatches.length > 0 && (
        <div className={styles.card} data-state="possible">
          <div className={styles.badge}>Possible matches</div>
          <p className={styles.hint}>Choose a template or create a new one.</p>
          <ul className={styles.matchList}>
            {possibleMatches.map((m) => (
              <li key={m.templateId} className={styles.matchItem}>
                <span className={styles.matchName}>{m.templateName}</span>
                <span className={styles.matchConfidence}>
                  {Math.round(m.confidence * 100)}%
                </span>
                <button
                  type="button"
                  className={styles.chooseBtn}
                  onClick={() => onChoosePossibleMatch(m.templateId)}
                >
                  Use this
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={onCreateNewTemplate}
          >
            Create new template
          </button>
        </div>
      )}

      {kind === "none" && (
        <div className={styles.card} data-state="none">
          <div className={styles.badge}>No verified template</div>
          <p className={styles.hint}>
            A draft template with guessed fields was created. Open the editor to refine and save.
          </p>
          {draftTemplateId && (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => onOpenTemplateReview(draftTemplateId)}
            >
              Open template review
            </button>
          )}
        </div>
      )}
    </div>
  );
}
