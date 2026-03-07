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
    billingZipCode: "",
    producer: "",
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
        <h2 className={styles.title}>New project</h2>
        <p className={styles.subtitle}>Create a new job to use with PDF templates.</p>
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
