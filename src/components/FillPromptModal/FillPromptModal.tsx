import { useMemo, useState } from "react";
import type { Template } from "@/types";
import {
  getPromptFields,
  getTemplateFieldPromptLabel,
  type PromptFieldValues,
} from "@/utils/fill";
import styles from "./FillPromptModal.module.css";

interface FillPromptModalProps {
  template: Template;
  initialValues?: PromptFieldValues;
  mode: "preview" | "export";
  onClose: () => void;
  onSubmit: (values: PromptFieldValues) => void;
}

export function FillPromptModal({
  template,
  initialValues = {},
  mode,
  onClose,
  onSubmit,
}: FillPromptModalProps) {
  const promptFields = useMemo(() => getPromptFields(template), [template]);
  const [values, setValues] = useState<PromptFieldValues>(() =>
    Object.fromEntries(promptFields.map((field) => [field.id, initialValues[field.id] ?? ""]))
  );

  const actionLabel = mode === "preview" ? "Continue to preview" : "Fill PDF";

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="fill-prompt-title">
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.modal}>
        <header className={styles.header}>
          <div>
            <h2 id="fill-prompt-title" className={styles.title}>
              Fill required values
            </h2>
            <p className={styles.subtitle}>
              Enter the values that should be collected at fill time for `{template.name}`.
            </p>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className={styles.body}>
          {promptFields.map((field) => (
            <label key={field.id} className={styles.row}>
              <span className={styles.label}>{getTemplateFieldPromptLabel(field)}</span>
              <input
                type="text"
                className={styles.input}
                value={values[field.id] ?? ""}
                placeholder={field.label}
                onChange={(e) =>
                  setValues((prev) => ({
                    ...prev,
                    [field.id]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={styles.primaryBtn} onClick={() => onSubmit(values)}>
            {actionLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
