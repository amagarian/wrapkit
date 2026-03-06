import type { Project, PdfMatchResult } from "@/types";
import { ProjectDetailForm } from "../ProjectDetailForm/ProjectDetailForm";
import { PdfDropzone } from "../PdfDropzone/PdfDropzone";
import { MatchStatusPanel } from "../MatchStatusPanel/MatchStatusPanel";
import styles from "./ProjectWorkspace.module.css";

interface ProjectWorkspaceProps {
  project: Project | null;
  matchResult: PdfMatchResult | null;
  onPdfDrop: (file: File | null) => void;
  onUpdateProject: (updates: Partial<Project>) => void;
  onOpenTemplateReview: (draftTemplateId: string) => void;
  onFillNow: (templateId: string) => void;
  onPreviewBeforeExport: (templateId: string) => void;
  onChoosePossibleMatch: (templateId: string) => void;
  onCreateNewTemplate: () => void;
  onClearMatch: () => void;
  onEditTemplate: (templateId: string) => void;
}

export function ProjectWorkspace({
  project,
  matchResult,
  onPdfDrop,
  onUpdateProject,
  onOpenTemplateReview,
  onFillNow,
  onPreviewBeforeExport,
  onChoosePossibleMatch,
  onCreateNewTemplate,
  onClearMatch,
  onEditTemplate,
}: ProjectWorkspaceProps) {
  return (
    <div className={styles.workspace}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Project details</h2>
        {project ? (
          <ProjectDetailForm
            project={project}
            onChange={onUpdateProject}
          />
        ) : (
          <p className={styles.placeholder}>Select a project from the sidebar.</p>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>PDF intake</h2>
        {matchResult ? (
          <MatchStatusPanel
            result={matchResult}
            onOpenTemplateReview={onOpenTemplateReview}
            onFillNow={onFillNow}
            onPreviewBeforeExport={onPreviewBeforeExport}
            onChoosePossibleMatch={onChoosePossibleMatch}
            onCreateNewTemplate={onCreateNewTemplate}
            onClearMatch={onClearMatch}
            onEditTemplate={onEditTemplate}
          />
        ) : (
          <PdfDropzone onDrop={onPdfDrop} />
        )}
      </section>
    </div>
  );
}
