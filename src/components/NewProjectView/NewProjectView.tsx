import type { Project } from "@/types";
import { ProjectDetailForm } from "../ProjectDetailForm/ProjectDetailForm";
import styles from "./NewProjectView.module.css";

interface NewProjectViewProps {
  initialProject: Partial<Project>;
  onChange: (updates: Partial<Project>) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function NewProjectView({
  initialProject,
  onChange,
  onSave,
  onCancel,
}: NewProjectViewProps) {
  const project = {
    id: "",
    label: "",
    jobName: "",
    jobNumber: "",
    poNumber: "",
    authorizationDate: "",
    productionCompany: "",
    billingAddress: "",
    billingCity: "",
    billingState: "",
    billingZipCode: "",
    email: "",
    phone: "",
    creditCardType: "",
    keepCardOnFile: "",
    creditCardHolder: "",
    cardholderSignature: "",
    creditCardNumber: "",
    expDate: "",
    ccv: "",
    createdAt: "",
    updatedAt: "",
    ...initialProject,
  } as Project;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h2 className={styles.title}>JOB INFO</h2>
        <button type="button" className={styles.closeBtn} onClick={onCancel} aria-label="Close" title="Cancel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <ProjectDetailForm project={project} onChange={onChange} />
      <div className={styles.actions}>
        <button type="button" className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={styles.saveBtn} onClick={onSave}>
          Create project
        </button>
      </div>
    </div>
  );
}
