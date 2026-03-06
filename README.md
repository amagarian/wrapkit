# Wrapkit

Desktop app for film and production: auto-fill production PDFs using project-level source data, with a shared template workflow.

## Tech stack

- **Tauri 2** — desktop shell
- **React 18** + **TypeScript** — UI
- **Vite** — build and dev server
- **CSS Modules** — styling (grayscale, minimal)

## Getting started

```bash
cd wrapkit
npm install
npm run tauri dev
```

For a web-only preview (no Tauri):

```bash
npm run dev
```

Then open http://localhost:5173.

## Project structure

```
wrapkit/
├── src/
│   ├── types/           # Project, Template, TemplateField, PdfMatchResult, etc.
│   ├── data/            # mockProjects, mockTemplates (seeded data)
│   ├── components/
│   │   ├── AppShell/
│   │   ├── Sidebar/
│   │   ├── ProjectList/
│   │   ├── ProjectWorkspace/
│   │   ├── ProjectDetailForm/
│   │   ├── NewProjectView/
│   │   ├── PdfDropzone/
│   │   ├── MatchStatusPanel/
│   │   └── TemplateReviewModal/
│   ├── App.tsx          # View state, handlers, composition
│   ├── main.tsx
│   └── index.css
├── src-tauri/           # Rust backend (Tauri 2)
├── index.html
├── package.json
└── vite.config.ts
```

## MVP behavior

- **Sidebar**: List of projects; select one to see details in the workspace.
- **Project workspace**: Edit project fields; drag/drop a PDF into the intake area.
- **PDF intake**: Simulated match — one of three states (verified / possible / none). Use **Clear** to try again with another “drop.”
- **Verified match**: “Fill now” and “Preview before export” (no-op for now).
- **Possible matches**: List of templates + “Use this” / “Create new template.”
- **No match**: “Open template review” opens the template editor modal.
- **Template review modal**: Placeholder PDF area with field overlays; sidebar to map fields to project keys, nudge position, delete, or add fields; “Save template locally.”
- **New project**: “New project” in the sidebar opens the creation form; “Create project” adds it to the list and selects it.

All data is in-memory (no backend, no persistence). Structure is in place to add real PDF handling and cloud templates later.

## Next steps (Phase 2+)

- Real PDF upload and parsing
- Local template persistence (e.g. Tauri fs or store)
- Fill verified templates and export PDF
- Cloud submission, verification, versioning
