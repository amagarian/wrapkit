import { useState, useCallback } from "react";
import type { Project, PdfMatchResult, Template, TemplateField } from "@/types";
import { mockProjects } from "@/data/mockProjects";
import {
  mockVerifiedTemplate,
  mockPossibleTemplates,
  mockDraftTemplate,
} from "@/data/mockTemplates";
import { AppShell } from "@/components/AppShell/AppShell";
import { ProjectWorkspace } from "@/components/ProjectWorkspace/ProjectWorkspace";
import { NewProjectView } from "@/components/NewProjectView/NewProjectView";
import { TemplateReviewModal } from "@/components/TemplateReviewModal/TemplateReviewModal";
import { PreviewExportModal } from "@/components/PreviewExportModal/PreviewExportModal";
import { Toast, type ToastState } from "@/components/Toast/Toast";
import { buildFilledFields, type FilledField } from "@/utils/fill";
import { writeFilledPdfBytes } from "@/utils/pdfWriter";
import { exportPdfBytes } from "@/utils/exportPdf";
import { detectFieldsFromPdf, createTemplateFromDetectedFields } from "@/utils/fieldDetector";

type View = "workspace" | "new-project";

function createEmptyProject(): Project {
  const now = new Date().toISOString();
  return {
    id: `proj-${Date.now()}`,
    label: "",
    jobName: "",
    jobNumber: "",
    productionCompany: "",
    billingAddress: "",
    producer: "",
    email: "",
    phone: "",
    creditCardType: "",
    creditCardHolder: "",
    creditCardNumber: "",
    expDate: "",
    ccv: "",
    createdAt: now,
    updatedAt: now,
  };
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>(mockProjects);
  const [view, setView] = useState<View>("workspace");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    mockProjects[0]?.id ?? null
  );
  const [matchResult, setMatchResult] = useState<PdfMatchResult | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [templateModal, setTemplateModal] = useState<{
    template: Template;
  } | null>(null);
  const [draftTemplate, setDraftTemplate] = useState<Template | null>(null);
  const [editedTemplates, setEditedTemplates] = useState<Record<string, Template>>({});
  const [previewModal, setPreviewModal] = useState<{
    template: Template;
    filledFields: FilledField[];
    fileName?: string;
  } | null>(null);
  const [pdfSource, setPdfSource] = useState<{
    fileName: string;
    bytes: Uint8Array;
  } | null>(null);
  const [newProjectDraft, setNewProjectDraft] = useState<Partial<Project>>({});

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  const updateProject = useCallback((id: string, updates: Partial<Project>) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
  }, []);

  const handlePdfDrop = useCallback((file: File | null) => {
    if (!file) return;
    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setPdfSource({ fileName: file.name, bytes });

      // Detect fields from the PDF using text extraction
      let detectedFields: Template["fields"] = [];
      try {
        detectedFields = await detectFieldsFromPdf(bytes, 1);
      } catch (err) {
        console.warn("Field detection failed:", err);
      }

      // If we detected fields, create a draft template with real positions
      if (detectedFields.length > 0) {
        const draft = createTemplateFromDetectedFields(detectedFields, file.name);
        setDraftTemplate(draft as Template);
        setMatchResult({
          kind: "none",
          draftTemplateId: draft.id,
          fileName: file.name,
        });
        setToast({
          message: `Detected ${detectedFields.length} potential field(s) on this PDF`,
          type: "info",
        });
      } else {
        // Fallback to empty draft if no fields detected
        const draft: Template = {
          id: `tpl-draft-${Date.now()}`,
          name: `${file.name.replace(/\.pdf$/i, "")} — draft`,
          status: "local-draft",
          fields: [],
          pageCount: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setDraftTemplate(draft);
        setMatchResult({
          kind: "none",
          draftTemplateId: draft.id,
          fileName: file.name,
        });
        setToast({
          message: "No recognizable labels found. You can add fields manually.",
          type: "info",
        });
      }
    })();
  }, []);

  const handleOpenTemplateReview = useCallback((draftTemplateId: string) => {
    const template = draftTemplate ?? {
      ...mockDraftTemplate,
      id: draftTemplateId,
    } as Template;
    setDraftTemplate(template);
    setTemplateModal({ template });
  }, [draftTemplate]);

  const handleTemplateFieldChange = useCallback(
    (fieldId: string, updates: Partial<TemplateField>) => {
      if (!templateModal) return;
      setTemplateModal({
        template: {
          ...templateModal.template,
          fields: templateModal.template.fields.map((f) =>
            f.id === fieldId ? { ...f, ...updates } : f
          ),
        },
      });
      setDraftTemplate((prev) =>
        prev
          ? {
              ...prev,
              fields: prev.fields.map((f) =>
                f.id === fieldId ? { ...f, ...updates } : f
              ),
            }
          : null
      );
    },
    [templateModal]
  );

  const handleDeleteField = useCallback(
    (fieldId: string) => {
      if (!templateModal) return;
      const nextFields = templateModal.template.fields.filter((f) => f.id !== fieldId);
      const next = { ...templateModal.template, fields: nextFields };
      setTemplateModal({ template: next });
      setDraftTemplate((prev) =>
        prev ? { ...prev, fields: prev.fields.filter((f) => f.id !== fieldId) } : null
      );
    },
    [templateModal]
  );

  const handleAddField = useCallback(() => {
    if (!templateModal) return;
    const newField: TemplateField = {
      id: `new-${Date.now()}`,
      label: "New field",
      mappedProjectKey: "",
      pageNumber: 1,
      x: 100,
      y: 100,
      width: 150,
      height: 22,
      confidence: 0.5,
      fieldType: "text",
    };
    const next = {
      ...templateModal.template,
      fields: [...templateModal.template.fields, newField],
    };
    setTemplateModal({ template: next });
    setDraftTemplate((prev) =>
      prev ? { ...prev, fields: [...prev.fields, newField] } : null
    );
  }, [templateModal]);

  const handleSaveTemplate = useCallback((template: Template) => {
    setEditedTemplates((prev) => ({ ...prev, [template.id]: template }));
    setDraftTemplate(template);
    setTemplateModal(null);
  }, []);

  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "success") => {
    setToast({ message, type });
  }, []);

  const getTemplateById = useCallback(
    (templateId: string): Template | null => {
      if (editedTemplates[templateId]) return editedTemplates[templateId];
      if (draftTemplate?.id === templateId) return draftTemplate;
      if (mockVerifiedTemplate.id === templateId) return mockVerifiedTemplate;
      const possible = mockPossibleTemplates.find((t) => t.id === templateId);
      if (possible) return possible;
      return null;
    },
    [draftTemplate, editedTemplates]
  );

  const exportFilledPdf = useCallback(
    async (template: Template, project: Project) => {
      if (!pdfSource?.bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const filledBytes = await writeFilledPdfBytes(pdfSource.bytes, template, project, {
        defaultFontSize: 10,
      });
      const suggested = `wrapkit-${project.jobNumber || project.id}.pdf`;
      const res = await exportPdfBytes(filledBytes, suggested);
      if (res.canceled) return;
      showToast(res.method === "tauri" ? "Saved filled PDF." : "Downloaded filled PDF.");
    },
    [pdfSource?.bytes, showToast]
  );

  const handlePreviewBeforeExport = useCallback(
    (templateId: string) => {
      if (!selectedProject) {
        showToast("Select a project first.");
        return;
      }
      if (!pdfSource?.bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const template = getTemplateById(templateId);
      if (!template) {
        showToast("Template not found.");
        return;
      }
      const filledFields = buildFilledFields(selectedProject, template);
      setPreviewModal({ template, filledFields, fileName: matchResult?.fileName });
    },
    [getTemplateById, matchResult?.fileName, pdfSource?.bytes, selectedProject, showToast]
  );

  const handleFillNow = useCallback(
    (templateId: string) => {
      if (!selectedProject) {
        showToast("Select a project first.");
        return;
      }
      if (!pdfSource?.bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const template = getTemplateById(templateId);
      if (!template) {
        showToast("Template not found.");
        return;
      }
      void exportFilledPdf(template, selectedProject);
    },
    [exportFilledPdf, getTemplateById, pdfSource?.bytes, selectedProject, showToast]
  );

  const handleNewProject = useCallback(() => {
    setNewProjectDraft({});
    setView("new-project");
  }, []);

  const handleSaveNewProject = useCallback(() => {
    const project = { ...createEmptyProject(), ...newProjectDraft };
    if (project.label || project.jobName) {
      setProjects((prev) => [...prev, project]);
      setSelectedProjectId(project.id);
    }
    setNewProjectDraft({});
    setView("workspace");
  }, [newProjectDraft]);

  const handleCancelNewProject = useCallback(() => {
    setView("workspace");
    setNewProjectDraft({});
  }, []);

  const displayTemplate = templateModal?.template ?? draftTemplate;

  return (
    <>
      <AppShell
        projects={projects.map((p) => ({ id: p.id, label: p.label || p.jobName || "Untitled" }))}
        selectedProjectId={view === "workspace" ? selectedProjectId : null}
        onSelectProject={setSelectedProjectId}
        onNewProject={handleNewProject}
      >
        {view === "new-project" ? (
          <NewProjectView
            initialProject={newProjectDraft}
            onChange={(updates) =>
              setNewProjectDraft((prev) => ({
                ...prev,
                ...updates,
              }))
            }
            onSave={handleSaveNewProject}
            onCancel={handleCancelNewProject}
          />
        ) : (
          <ProjectWorkspace
            project={selectedProject}
            matchResult={matchResult}
            onPdfDrop={handlePdfDrop}
            onUpdateProject={(updates) =>
              selectedProjectId && updateProject(selectedProjectId, updates)
            }
            onOpenTemplateReview={handleOpenTemplateReview}
            onFillNow={handleFillNow}
            onPreviewBeforeExport={handlePreviewBeforeExport}
            onChoosePossibleMatch={() => setMatchResult(null)}
            onCreateNewTemplate={() => {
              const draft = { ...mockDraftTemplate, id: `tpl-draft-${Date.now()}` } as Template;
              setDraftTemplate(draft);
              setTemplateModal({ template: draft });
              setMatchResult(null);
            }}
            onClearMatch={() => {
              setMatchResult(null);
              setPdfSource(null);
            }}
            onEditTemplate={(templateId) => {
              const template = getTemplateById(templateId);
              if (template) {
                setTemplateModal({ template });
              }
            }}
          />
        )}
      </AppShell>

      {displayTemplate && templateModal && (
        <TemplateReviewModal
          template={templateModal.template}
          project={selectedProject}
          pdfBytes={pdfSource?.bytes ?? null}
          onClose={() => setTemplateModal(null)}
          onSave={handleSaveTemplate}
          onFieldChange={handleTemplateFieldChange}
          onDeleteField={handleDeleteField}
          onAddField={handleAddField}
          onProjectChange={selectedProjectId ? (updates) => updateProject(selectedProjectId, updates) : undefined}
        />
      )}

      {previewModal && (
        <PreviewExportModal
          template={previewModal.template}
          project={selectedProject!}
          filledFields={previewModal.filledFields}
          fileName={previewModal.fileName}
          onClose={() => setPreviewModal(null)}
          onExport={() => {
            void exportFilledPdf(previewModal.template, selectedProject!);
          }}
          exportLabel="Export filled PDF"
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
