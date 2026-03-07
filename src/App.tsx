import { useState, useCallback, useEffect } from "react";
import type { Project, PdfMatchResult, Template, TemplateCacheEntry, TemplateField, ProjectDocument } from "@/types";
import { mockProjects } from "@/data/mockProjects";
import { mockDraftTemplate } from "@/data/mockTemplates";
import { AppShell } from "@/components/AppShell/AppShell";
import { ProjectWorkspace } from "@/components/ProjectWorkspace/ProjectWorkspace";
import { NewProjectView } from "@/components/NewProjectView/NewProjectView";
import { TemplateReviewModal } from "@/components/TemplateReviewModal/TemplateReviewModal";
import { PreviewExportModal } from "@/components/PreviewExportModal/PreviewExportModal";
import { FillPromptModal } from "@/components/FillPromptModal/FillPromptModal";
import { MatchStatusModal } from "@/components/MatchStatusModal/MatchStatusModal";
import { Toast, type ToastState } from "@/components/Toast/Toast";
import {
  getPromptFields,
  getTemplateFieldPromptLabel,
  type PromptFieldValues,
} from "@/utils/fill";
import { writeFilledPdfBytes } from "@/utils/pdfWriter";
import { exportPdfBytes } from "@/utils/exportPdf";
import { detectFieldsFromPdf, createTemplateFromDetectedFields } from "@/utils/fieldDetector";
import { scoreFingerprintMatch } from "@/utils/templateFingerprint";
import {
  hydrateTemplateRegistry,
  matchVerifiedTemplates,
  submitTemplateForVerification,
} from "@/services/templateRegistry";
import { readLocalTemplates, upsertLocalTemplate } from "@/services/templateCache";

type View = "workspace" | "new-project" | "edit-project";

function createEmptyProject(): Project {
  const now = new Date().toISOString();
  return {
    id: `proj-${Date.now()}`,
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
    createdAt: now,
    updatedAt: now,
  };
}

function createEmptyDraftTemplate(fileName: string): Template {
  const now = new Date().toISOString();
  return {
    id: `tpl-draft-${Date.now()}`,
    name: `${fileName.replace(/\.pdf$/i, "")} — draft`,
    status: "local-draft",
    source: "local-draft",
    fields: [],
    pageCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function templatesFromCacheEntries(entries: TemplateCacheEntry[]): Record<string, Template> {
  return Object.fromEntries(entries.map((entry) => [entry.template.id, entry.template]));
}

function templatesToMap(templates: Template[]): Record<string, Template> {
  return Object.fromEntries(templates.map((template) => [template.id, template]));
}

function findMatchingLocalTemplate(
  templates: Template[],
  fingerprint: NonNullable<Template["fingerprint"]>
): Template | null {
  const ranked = templates
    .filter((template): template is Template & { fingerprint: NonNullable<Template["fingerprint"]> } =>
      Boolean(template.fingerprint)
    )
    .map((template) => ({
      template,
      confidence: scoreFingerprintMatch(fingerprint, template.fingerprint).total,
    }))
    .sort((left, right) => right.confidence - left.confidence);

  if (ranked[0] && ranked[0].confidence >= 0.92) {
    return ranked[0].template;
  }

  return null;
}

function cloneTemplate(template: Template): Template {
  return JSON.parse(JSON.stringify(template)) as Template;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>(mockProjects);
  const [view, setView] = useState<View>("workspace");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    mockProjects[0]?.id ?? null
  );
  const [toast, setToast] = useState<ToastState | null>(null);
  const [templateModal, setTemplateModal] = useState<{
    template: Template;
  } | null>(null);
  const [templateUndoStack, setTemplateUndoStack] = useState<Template[]>([]);
  const [templateRedoStack, setTemplateRedoStack] = useState<Template[]>([]);
  const [draftTemplate, setDraftTemplate] = useState<Template | null>(null);
  const [editedTemplates, setEditedTemplates] = useState<Record<string, Template>>({});
  const [previewModal, setPreviewModal] = useState<{
    template: Template;
    fileName?: string;
    promptValues: PromptFieldValues;
    sourceBytes: Uint8Array;
  } | null>(null);
  const [fillPromptModal, setFillPromptModal] = useState<{
    template: Template;
    mode: "preview" | "export";
    sourceBytes: Uint8Array;
    fileName: string;
  } | null>(null);
  const [pdfSource, setPdfSource] = useState<{
    fileName: string;
    bytes: Uint8Array;
  } | null>(null);
  const [newProjectDraft, setNewProjectDraft] = useState<Partial<Project>>({});
  const [registryTemplates, setRegistryTemplates] = useState<Record<string, Template>>({});
  const [promptValuesByTemplate, setPromptValuesByTemplate] = useState<
    Record<string, PromptFieldValues>
  >({});
  const [projectDocuments, setProjectDocuments] = useState<Record<string, ProjectDocument[]>>({});
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [matchModal, setMatchModal] = useState<PdfMatchResult | null>(null);

  const selectedProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? null
    : null;

  const currentDocuments = selectedProjectId
    ? projectDocuments[selectedProjectId] ?? []
    : [];

  useEffect(() => {
    void (async () => {
      try {
        const snapshot = await hydrateTemplateRegistry();
        setRegistryTemplates(templatesFromCacheEntries(snapshot.cacheEntries));
      } catch (error) {
        console.warn("Failed to hydrate template registry", error);
      }
    })();
  }, []);

  useEffect(() => {
    const localTemplates = readLocalTemplates();
    if (localTemplates.length > 0) {
      setEditedTemplates(templatesToMap(localTemplates));
    }
  }, []);

  const updateProject = useCallback((id: string, updates: Partial<Project>) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
  }, []);

  const deleteProject = useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setProjectDocuments((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedProjectId === id) {
      setSelectedProjectId(null);
      setView("workspace");
    }
  }, [selectedProjectId]);

  const addDocumentToProject = useCallback((projectId: string, doc: ProjectDocument) => {
    setProjectDocuments((prev) => ({
      ...prev,
      [projectId]: [...(prev[projectId] ?? []), doc],
    }));
  }, []);

  const updateDocumentInProject = useCallback((projectId: string, docId: string, updates: Partial<ProjectDocument>) => {
    setProjectDocuments((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).map((d) =>
        d.id === docId ? { ...d, ...updates, updatedAt: new Date().toISOString() } : d
      ),
    }));
  }, []);

  const removeDocumentFromProject = useCallback((projectId: string, docId: string) => {
    setProjectDocuments((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).filter((d) => d.id !== docId),
    }));
  }, []);

  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "success") => {
    setToast({ message, type });
  }, []);

  const handlePdfDrop = useCallback((file: File | null) => {
    if (!file || !selectedProjectId) return;
    const docId = `doc-${Date.now()}`;
    const now = new Date().toISOString();

    const newDoc: ProjectDocument = {
      id: docId,
      projectId: selectedProjectId,
      fileName: file.name,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    addDocumentToProject(selectedProjectId, newDoc);
    setActiveDocumentId(docId);

    void (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setPdfSource({ fileName: file.name, bytes });

      updateDocumentInProject(selectedProjectId, docId, { pdfBytes: bytes });

      const initialResult: PdfMatchResult = {
        kind: "none",
        fileName: file.name,
        lookupMessage: "Matching against the verified template registry...",
        syncState: "matching",
      };
      setMatchModal(initialResult);

      const registryMatch = await matchVerifiedTemplates(bytes, file.name);
      setRegistryTemplates((prev) => ({
        ...prev,
        ...registryMatch.templatesById,
      }));

      if (registryMatch.result.kind === "verified" || registryMatch.result.kind === "possible") {
        setDraftTemplate(null);
        const result = registryMatch.result;
        setMatchModal(result);
        updateDocumentInProject(selectedProjectId, docId, {
          status: "matched",
          matchResult: result,
          templateId: result.verifiedMatch?.templateId,
        });
        showToast(
          result.kind === "verified"
            ? "Found a verified template match."
            : "Found likely verified templates.",
          "success"
        );
        return;
      }

      const savedLocalTemplate = findMatchingLocalTemplate(
        Object.values(templatesToMap(readLocalTemplates())),
        registryMatch.fingerprint
      );
      if (savedLocalTemplate) {
        setEditedTemplates((prev) => ({
          ...prev,
          [savedLocalTemplate.id]: savedLocalTemplate,
        }));
        setDraftTemplate(savedLocalTemplate);
        const result: PdfMatchResult = {
          ...registryMatch.result,
          draftTemplateId: savedLocalTemplate.id,
          lookupMessage: "Loaded your saved local template for this PDF.",
          matchSource: savedLocalTemplate.source ?? "local-draft",
          syncState: "matched",
        };
        setMatchModal(result);
        updateDocumentInProject(selectedProjectId, docId, {
          status: "matched",
          matchResult: result,
          templateId: savedLocalTemplate.id,
        });
        showToast("Loaded your saved local template edits.", "success");
        return;
      }

      let detectedFields: Template["fields"] = [];
      try {
        detectedFields = await detectFieldsFromPdf(bytes, 1);
      } catch (err) {
        console.warn("Field detection failed:", err);
      }

      if (detectedFields.length > 0) {
        const draft = {
          ...createTemplateFromDetectedFields(detectedFields, file.name),
          source: "local-draft",
          fingerprint: registryMatch.fingerprint,
        } as Template;
        setDraftTemplate(draft);
        const result: PdfMatchResult = {
          ...registryMatch.result,
          draftTemplateId: draft.id,
          syncState: "matched",
        };
        setMatchModal(result);
        updateDocumentInProject(selectedProjectId, docId, {
          status: "matched",
          matchResult: result,
          templateId: draft.id,
        });
        showToast(`Detected ${detectedFields.length} potential field(s) on this PDF`, "info");
      } else {
        const draft: Template = {
          ...createEmptyDraftTemplate(file.name),
          fingerprint: registryMatch.fingerprint,
        };
        setDraftTemplate(draft);
        const result: PdfMatchResult = {
          ...registryMatch.result,
          draftTemplateId: draft.id,
          syncState: "matched",
        };
        setMatchModal(result);
        updateDocumentInProject(selectedProjectId, docId, {
          status: "matched",
          matchResult: result,
          templateId: draft.id,
        });
        showToast("No recognizable labels found. You can add fields manually.", "info");
      }
    })();
  }, [addDocumentToProject, selectedProjectId, showToast, updateDocumentInProject]);

  const getTemplateById = useCallback(
    (templateId: string): Template | null => {
      if (editedTemplates[templateId]) return editedTemplates[templateId];
      if (draftTemplate?.id === templateId) return draftTemplate;
      if (registryTemplates[templateId]) return registryTemplates[templateId];
      return null;
    },
    [draftTemplate, editedTemplates, registryTemplates]
  );

  const handleOpenTemplateReview = useCallback((templateId: string) => {
    const template =
      getTemplateById(templateId) ??
      ({
        ...mockDraftTemplate,
        id: templateId,
        source: "local-draft",
      } as Template);
    if (template.status !== "verified") {
      setDraftTemplate(template);
    }
    setTemplateUndoStack([]);
    setTemplateRedoStack([]);
    setTemplateModal({ template });
  }, [getTemplateById]);

  const recordTemplateUndoSnapshot = useCallback(() => {
    setTemplateUndoStack((prev) => {
      if (!templateModal) {
        return prev;
      }
      const snapshot = cloneTemplate(templateModal.template);
      const lastSnapshot = prev[prev.length - 1];
      if (lastSnapshot && JSON.stringify(lastSnapshot) === JSON.stringify(snapshot)) {
        return prev;
      }
      return [...prev.slice(-49), snapshot];
    });
    setTemplateRedoStack([]);
  }, [templateModal]);

  const handleUndoTemplateEdit = useCallback(() => {
    setTemplateUndoStack((prev) => {
      const snapshot = prev[prev.length - 1];
      if (!snapshot) {
        return prev;
      }
      setTemplateRedoStack((redoPrev) => {
        if (!templateModal) {
          return redoPrev;
        }
        return [...redoPrev.slice(-49), cloneTemplate(templateModal.template)];
      });
      setTemplateModal({ template: cloneTemplate(snapshot) });
      setDraftTemplate((current) => {
        if (!current || current.id !== snapshot.id) {
          return current;
        }
        return cloneTemplate(snapshot);
      });
      return prev.slice(0, -1);
    });
  }, [templateModal]);

  const handleRedoTemplateEdit = useCallback(() => {
    setTemplateRedoStack((prev) => {
      const snapshot = prev[prev.length - 1];
      if (!snapshot) {
        return prev;
      }
      setTemplateUndoStack((undoPrev) => {
        if (!templateModal) {
          return undoPrev;
        }
        return [...undoPrev.slice(-49), cloneTemplate(templateModal.template)];
      });
      setTemplateModal({ template: cloneTemplate(snapshot) });
      setDraftTemplate((current) => {
        if (!current || current.id !== snapshot.id) {
          return current;
        }
        return cloneTemplate(snapshot);
      });
      return prev.slice(0, -1);
    });
  }, [templateModal]);

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
    recordTemplateUndoSnapshot();
    const referenceFields = templateModal.template.fields.filter(
      (field) => field.fieldType !== "checkbox" && field.height > 0
    );
    const heightSamples = (referenceFields.length > 0 ? referenceFields : templateModal.template.fields)
      .map((field) => Math.round(field.height))
      .filter((height) => height > 0)
      .sort((left, right) => left - right);
    const inferredHeight =
      heightSamples.length > 0
        ? heightSamples[Math.floor(heightSamples.length / 2)]
        : 22;
    const newField: TemplateField = {
      id: `new-${Date.now()}`,
      label: "New field",
      mappedProjectKey: "",
      pageNumber: 1,
      x: 100,
      y: 100,
      width: 150,
      height: inferredHeight,
      confidence: 0.5,
      fieldType: "text",
      fieldKind: "text",
      detectionSource: "manual",
    };
    const next = {
      ...templateModal.template,
      fields: [...templateModal.template.fields, newField],
    };
    setTemplateModal({ template: next });
    setDraftTemplate((prev) =>
      prev ? { ...prev, fields: [...prev.fields, newField] } : null
    );
  }, [recordTemplateUndoSnapshot, templateModal]);

  const handleAddCheckbox = useCallback(() => {
    if (!templateModal) return;
    recordTemplateUndoSnapshot();
    const checkboxSamples = templateModal.template.fields
      .filter((field) => field.fieldType === "checkbox")
      .flatMap((field) => [Math.round(field.width), Math.round(field.height)])
      .filter((size) => size > 0)
      .sort((left, right) => left - right);
    const inferredCheckboxSize =
      checkboxSamples.length > 0
        ? checkboxSamples[Math.floor(checkboxSamples.length / 2)]
        : 16;

    const newField: TemplateField = {
      id: `checkbox-${Date.now()}`,
      label: "New checkbox",
      mappedProjectKey: "",
      pageNumber: 1,
      x: 100,
      y: 100,
      width: inferredCheckboxSize,
      height: inferredCheckboxSize,
      confidence: 0.5,
      fieldType: "checkbox",
      fieldKind: "boolean-checkbox",
      detectionSource: "manual",
      checkboxValue: "yes",
    };
    const next = {
      ...templateModal.template,
      fields: [...templateModal.template.fields, newField],
    };
    setTemplateModal({ template: next });
    setDraftTemplate((prev) =>
      prev ? { ...prev, fields: [...prev.fields, newField] } : null
    );
  }, [recordTemplateUndoSnapshot, templateModal]);

  const handleSaveTemplate = useCallback((template: Template) => {
    const now = new Date().toISOString();
    const savedTemplate: Template =
      template.status === "verified"
        ? {
            ...template,
            status: "local-draft",
            source: "local-override",
            name: `${template.name} — local override`,
            updatedAt: now,
          }
        : {
            ...template,
            source: template.source ?? "local-draft",
            updatedAt: now,
          };
    upsertLocalTemplate(savedTemplate);
    setEditedTemplates((prev) => ({ ...prev, [template.id]: savedTemplate }));
    setDraftTemplate(savedTemplate);
    setTemplateUndoStack([]);
    setTemplateRedoStack([]);
    setTemplateModal(null);
    showToast("Saved template locally.", "success");
  }, [showToast]);

  const handleSubmitTemplate = useCallback(async (template: Template) => {
    const submissionBase =
      template.status === "verified"
        ? {
            ...template,
            status: "local-draft" as const,
            source: "local-override" as const,
          }
        : template;

    const result = await submitTemplateForVerification({
      template: submissionBase,
      pdfBytes: pdfSource?.bytes,
      pdfFileName: pdfSource?.fileName ?? `${submissionBase.name}.pdf`,
      sourceProjectId: selectedProject?.id,
    });

    const submittedTemplate: Template = {
      ...submissionBase,
      status: "community-submitted",
      source: "community-submitted",
      fingerprint: result.submission.fingerprint,
      updatedAt: result.submission.submittedAt,
    };
    setEditedTemplates((prev) => ({ ...prev, [template.id]: submittedTemplate }));
    setDraftTemplate(submittedTemplate);
    setTemplateUndoStack([]);
    setTemplateRedoStack([]);
    setTemplateModal(null);
    showToast(
      result.queuedOffline
        ? "Template submission queued locally until the cloud registry is configured."
        : "Template submitted for verification.",
      "success"
    );
  }, [pdfSource?.bytes, pdfSource?.fileName, selectedProject?.id, showToast]);

  const exportFilledPdf = useCallback(
    async (template: Template, project: Project, sourceBytes: Uint8Array, sourceFileName: string, promptValues: PromptFieldValues = {}) => {
      try {
        const filledBytes = await writeFilledPdfBytes(sourceBytes, template, project, {
          defaultFontSize: 10,
          promptValues,
        });
        const baseName = sourceFileName.replace(/\.pdf$/i, "");
        const suggested = `${baseName} - FILLED.pdf`;
        const res = await exportPdfBytes(filledBytes, suggested);
        if (res.canceled) return;

        if (activeDocumentId && selectedProjectId) {
          updateDocumentInProject(selectedProjectId, activeDocumentId, {
            status: "filled",
            updatedAt: new Date().toISOString(),
          });
        }

        showToast(res.method === "tauri" ? "Saved filled PDF." : "Downloaded filled PDF.", "success");
      } catch (err) {
        console.error("Fill/export failed:", err);
        showToast(`Export failed: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      }
    },
    [showToast, activeDocumentId, selectedProjectId, updateDocumentInProject]
  );

  const runFillAction = useCallback(
    (
      template: Template,
      mode: "preview" | "export",
      project: Project,
      sourceBytes: Uint8Array,
      fileName: string,
      promptValues: PromptFieldValues = {}
    ) => {
      if (mode === "preview") {
        setPreviewModal({
          template,
          fileName,
          promptValues,
          sourceBytes,
        });
        return;
      }
      void exportFilledPdf(template, project, sourceBytes, fileName, promptValues);
    },
    [exportFilledPdf]
  );

  const beginFillAction = useCallback(
    (template: Template, mode: "preview" | "export", project: Project, sourceBytes: Uint8Array, fileName: string) => {
      const promptFields = getPromptFields(template);
      if (promptFields.length === 0) {
        runFillAction(template, mode, project, sourceBytes, fileName);
        return;
      }
      setFillPromptModal({ template, mode, sourceBytes, fileName });
    },
    [runFillAction]
  );

  const handlePreviewBeforeExport = useCallback(
    (templateId: string, overrideBytes?: Uint8Array, overrideFileName?: string) => {
      if (!selectedProject) {
        showToast("Select a project first.");
        return;
      }
      const bytes = overrideBytes ?? pdfSource?.bytes;
      const fileName = overrideFileName ?? pdfSource?.fileName ?? "document.pdf";
      if (!bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const template = getTemplateById(templateId);
      if (!template) {
        showToast("Template not found.");
        return;
      }
      beginFillAction(template, "preview", selectedProject, bytes, fileName);
    },
    [beginFillAction, getTemplateById, pdfSource, selectedProject, showToast]
  );

  const handleFillNow = useCallback(
    (templateId: string, overrideBytes?: Uint8Array, overrideFileName?: string) => {
      if (!selectedProject) {
        showToast("Select a project first.");
        return;
      }
      const bytes = overrideBytes ?? pdfSource?.bytes;
      const fileName = overrideFileName ?? pdfSource?.fileName ?? "document.pdf";
      if (!bytes) {
        showToast("Drop a PDF first.");
        return;
      }
      const template = getTemplateById(templateId);
      if (!template) {
        showToast("Template not found.");
        return;
      }
      beginFillAction(template, "export", selectedProject, bytes, fileName);
    },
    [beginFillAction, getTemplateById, pdfSource?.bytes, selectedProject, showToast]
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

  const handleEditProject = useCallback(() => {
    setView("edit-project");
  }, []);

  const handleSelectProject = useCallback((id: string) => {
    setSelectedProjectId(id);
    setView("workspace");
  }, []);

  const displayTemplate = templateModal?.template ?? draftTemplate;

  return (
    <>
      <AppShell
        projects={projects.map((p) => ({ id: p.id, label: p.label || p.jobName || "Untitled" }))}
        selectedProjectId={view === "workspace" ? selectedProjectId : null}
        onSelectProject={handleSelectProject}
        onNewProject={handleNewProject}
      >
        {view === "new-project" || view === "edit-project" ? (
          <NewProjectView
            initialProject={view === "edit-project" && selectedProject ? selectedProject : newProjectDraft}
            onChange={(updates) => {
              if (view === "edit-project" && selectedProjectId) {
                updateProject(selectedProjectId, updates);
              } else {
                setNewProjectDraft((prev) => ({ ...prev, ...updates }));
              }
            }}
            onSave={view === "edit-project" ? () => setView("workspace") : handleSaveNewProject}
            onCancel={view === "edit-project" ? () => setView("workspace") : handleCancelNewProject}
          />
        ) : (
          <ProjectWorkspace
            project={selectedProject}
            documents={currentDocuments}
            onPdfDrop={handlePdfDrop}
            onEditProject={handleEditProject}
            onDeleteProject={() => {
              if (selectedProjectId) deleteProject(selectedProjectId);
            }}
            onOpenDocument={(doc) => {
              setActiveDocumentId(doc.id);
              if (doc.pdfBytes) {
                setPdfSource({ fileName: doc.fileName, bytes: doc.pdfBytes });
              }
              if (doc.templateId) {
                const tpl = getTemplateById(doc.templateId);
                if (tpl) setDraftTemplate(tpl);
              }
              if (doc.matchResult) {
                setMatchModal(doc.matchResult);
              }
            }}
            onFillDocument={(doc) => {
              if (!doc.templateId) {
                showToast("No template assigned to this document.", "error");
                return;
              }
              const bytes = doc.pdfBytes ?? pdfSource?.bytes;
              if (!bytes) {
                showToast("PDF data not available. Try clicking the document name first, then Fill.", "error");
                return;
              }
              setActiveDocumentId(doc.id);
              setPdfSource({ fileName: doc.fileName, bytes });
              handleFillNow(doc.templateId, bytes, doc.fileName);
            }}
            onPreviewDocument={(doc) => {
              if (!doc.templateId) {
                showToast("No template assigned to this document.", "error");
                return;
              }
              const bytes = doc.pdfBytes ?? pdfSource?.bytes;
              if (!bytes) {
                showToast("PDF data not available. Try clicking the document name first, then Preview.", "error");
                return;
              }
              setActiveDocumentId(doc.id);
              setPdfSource({ fileName: doc.fileName, bytes });
              handlePreviewBeforeExport(doc.templateId, bytes, doc.fileName);
            }}
            onRemoveDocument={(docId) => {
              if (selectedProjectId) {
                removeDocumentFromProject(selectedProjectId, docId);
              }
            }}
          />
        )}
      </AppShell>

      {matchModal && (
        <MatchStatusModal
          result={matchModal}
          onClose={() => setMatchModal(null)}
          onOpenTemplateReview={(templateId) => {
            setMatchModal(null);
            handleOpenTemplateReview(templateId);
          }}
          onFillNow={(templateId) => {
            setMatchModal(null);
            handleFillNow(templateId);
          }}
          onPreviewBeforeExport={(templateId) => {
            setMatchModal(null);
            handlePreviewBeforeExport(templateId);
          }}
          onChoosePossibleMatch={(templateId) => {
            const chosen = matchModal?.possibleMatches?.find((match) => match.templateId === templateId);
            if (!chosen) return;
            setMatchModal({
              kind: "verified",
              verifiedMatch: chosen,
              fileName: matchModal?.fileName,
              lookupMessage: "Using the selected verified template candidate.",
              matchSource: chosen.source,
              syncState: "matched",
            });
          }}
          onCreateNewTemplate={() => {
            const draft = {
              ...createEmptyDraftTemplate(pdfSource?.fileName ?? "Untitled.pdf"),
              ...mockDraftTemplate,
              id: `tpl-draft-${Date.now()}`,
              source: "local-draft",
            } as Template;
            setDraftTemplate(draft);
            setTemplateUndoStack([]);
            setTemplateRedoStack([]);
            setMatchModal(null);
            setTemplateModal({ template: draft });
          }}
          onEditTemplate={(templateId) => {
            const template = getTemplateById(templateId);
            if (template) {
              setTemplateUndoStack([]);
              setTemplateRedoStack([]);
              setMatchModal(null);
              setTemplateModal({ template });
            }
          }}
        />
      )}

      {displayTemplate && templateModal && (
        <TemplateReviewModal
          template={templateModal.template}
          project={selectedProject}
          pdfBytes={pdfSource?.bytes ?? null}
          onClose={() => {
            setTemplateUndoStack([]);
            setTemplateRedoStack([]);
            setTemplateModal(null);
          }}
          onSave={handleSaveTemplate}
          onConfirm={(template) => {
            handleSaveTemplate(template);
            if (selectedProject && pdfSource?.bytes && template.id) {
              handleFillNow(template.id);
            }
          }}
          onSubmitForVerification={handleSubmitTemplate}
          onUndo={handleUndoTemplateEdit}
          canUndo={templateUndoStack.length > 0}
          onRedo={handleRedoTemplateEdit}
          canRedo={templateRedoStack.length > 0}
          onBeginFieldEdit={recordTemplateUndoSnapshot}
          onFieldChange={handleTemplateFieldChange}
          onDeleteField={handleDeleteField}
          onAddField={handleAddField}
          onAddCheckbox={handleAddCheckbox}
          onProjectChange={selectedProjectId ? (updates) => updateProject(selectedProjectId, updates) : undefined}
        />
      )}

      {previewModal && selectedProject && (
        <PreviewExportModal
          template={previewModal.template}
          project={selectedProject}
          sourceBytes={previewModal.sourceBytes}
          promptValues={previewModal.promptValues}
          fileName={previewModal.fileName}
          onClose={() => setPreviewModal(null)}
          onExport={() => {
            void exportFilledPdf(previewModal.template, selectedProject, previewModal.sourceBytes, previewModal.fileName ?? "document.pdf", previewModal.promptValues);
          }}
          exportLabel="Export filled PDF"
        />
      )}

      {fillPromptModal && selectedProject && (
        <FillPromptModal
          template={fillPromptModal.template}
          mode={fillPromptModal.mode}
          initialValues={promptValuesByTemplate[fillPromptModal.template.id] ?? {}}
          onClose={() => setFillPromptModal(null)}
          onSubmit={(values) => {
            const promptFields = getPromptFields(fillPromptModal.template);
            const firstMissing = promptFields.find((field) => !(values[field.id] ?? "").trim());
            if (firstMissing) {
              showToast(`Enter a value for ${getTemplateFieldPromptLabel(firstMissing)}.`, "error");
              return;
            }
            setPromptValuesByTemplate((prev) => ({
              ...prev,
              [fillPromptModal.template.id]: values,
            }));
            setFillPromptModal(null);
            runFillAction(fillPromptModal.template, fillPromptModal.mode, selectedProject, fillPromptModal.sourceBytes, fillPromptModal.fileName, values);
          }}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
