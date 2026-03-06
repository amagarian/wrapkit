import type { Project, CreditCardType } from "@/types";
import styles from "./ProjectDetailForm.module.css";

interface ProjectDetailFormProps {
  project: Project;
  onChange: (updates: Partial<Project>) => void;
}

const TEXT_FIELDS: { key: keyof Project; label: string }[] = [
  { key: "label", label: "Project label" },
  { key: "jobName", label: "Job name" },
  { key: "jobNumber", label: "Job number" },
  { key: "productionCompany", label: "Production company" },
  { key: "billingAddress", label: "Billing address" },
  { key: "producer", label: "Producer" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "creditCardHolder", label: "Credit card holder" },
  { key: "creditCardNumber", label: "Credit card number" },
  { key: "expDate", label: "Exp date" },
  { key: "ccv", label: "CCV" },
];

const CARD_TYPE_OPTIONS: { value: CreditCardType; label: string }[] = [
  { value: "", label: "— Select —" },
  { value: "visa", label: "Visa" },
  { value: "mastercard", label: "MasterCard" },
  { value: "discover", label: "Discover" },
  { value: "amex", label: "American Express" },
];

export function ProjectDetailForm({ project, onChange }: ProjectDetailFormProps) {
  return (
    <div className={styles.form}>
      {TEXT_FIELDS.map(({ key, label }) => {
        // Insert credit card type selector before creditCardHolder
        if (key === "creditCardHolder") {
          return (
            <div key="creditCardType-and-holder">
              <div className={styles.row}>
                <label className={styles.label} htmlFor="creditCardType">
                  Credit card type
                </label>
                <select
                  id="creditCardType"
                  className={styles.input}
                  value={project.creditCardType || ""}
                  onChange={(e) => onChange({ creditCardType: e.target.value as CreditCardType })}
                >
                  {CARD_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.row}>
                <label className={styles.label} htmlFor={key}>
                  {label}
                </label>
                <input
                  id={key}
                  type="text"
                  className={styles.input}
                  value={project[key] as string}
                  onChange={(e) => onChange({ [key]: e.target.value })}
                />
              </div>
            </div>
          );
        }
        
        return (
          <div key={key} className={styles.row}>
            <label className={styles.label} htmlFor={key}>
              {label}
            </label>
            <input
              id={key}
              type="text"
              className={styles.input}
              value={project[key] as string}
              onChange={(e) => onChange({ [key]: e.target.value })}
            />
          </div>
        );
      })}
    </div>
  );
}
