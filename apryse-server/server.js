import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { PDFNet } = require("@pdftron/pdfnet-node");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8080;
const APRYSE_KEY = process.env.APRYSE_KEY || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",");

let pdfnetInitialized = false;

async function ensureInit() {
  if (pdfnetInitialized) return;
  await PDFNet.initialize(APRYSE_KEY);

  const modulePath = process.env.APRYSE_MODULE_PATH;
  if (modulePath) {
    // Add the base path and all subdirectories where module binaries may live
    const searchPaths = [
      modulePath,
      path.join(modulePath, "Lib"),
      path.join(modulePath, "Lib", "Linux"),
    ];
    for (const sp of searchPaths) {
      if (fs.existsSync(sp)) {
        await PDFNet.addResourceSearchPath(sp);
        console.log(`[Apryse] Added resource search path: ${sp}`);
        // List contents for debugging
        try {
          const entries = fs.readdirSync(sp);
          console.log(`[Apryse]   Contents: ${entries.join(", ")}`);
        } catch {}
      }
    }
  }

  pdfnetInitialized = true;
  console.log("[Apryse] PDFNet initialized");

  const formAvail = await PDFNet.DataExtractionModule.isModuleAvailable(
    PDFNet.DataExtractionModule.DataExtractionEngine.e_Form
  );
  const kvAvail = await PDFNet.DataExtractionModule.isModuleAvailable(
    PDFNet.DataExtractionModule.DataExtractionEngine.e_FormKeyValue
  );
  console.log(`[Apryse] Data Extraction Module — Form: ${formAvail}, FormKeyValue: ${kvAvail}`);
}

function cors(req, res, next) {
  const origin = req.headers.origin || "*";
  const allowed = ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
}
app.use(cors);

// ──────────────────────────────────────────────────────────────
// POST /extract-fields
// Body: { pdfBase64: string, page?: number }
// Returns: { method, fields[], acroFormFields[], formFields[], kvFields[], pageWidth, pageHeight }
// ──────────────────────────────────────────────────────────────
app.post("/extract-fields", async (req, res) => {
  const start = Date.now();
  const { pdfBase64, page = 1 } = req.body;
  if (!pdfBase64) {
    return res.status(400).json({ error: "Missing pdfBase64" });
  }

  let tmpFile;
  try {
    await ensureInit();

    const buf = Buffer.from(pdfBase64, "base64");
    tmpFile = path.join(os.tmpdir(), `apryse_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmpFile, buf);

    const acroFormFields = await extractAcroFormFields(tmpFile, page);
    const { formFields, kvFields, pageWidth, pageHeight } = await extractWithDataModule(tmpFile, page);

    const elapsed = Date.now() - start;
    console.log(
      `[Apryse] Extracted ${acroFormFields.length} AcroForm, ` +
      `${formFields.length} detected, ${kvFields.length} KV fields in ${elapsed}ms`
    );

    res.json({
      method: acroFormFields.length > 0 ? "acroform+dataextraction" : "dataextraction",
      acroFormFields,
      formFields,
      kvFields,
      pageWidth,
      pageHeight,
      elapsedMs: elapsed,
    });
  } catch (err) {
    console.error("[Apryse] Extraction error:", err);
    res.status(500).json({ error: err.message || "Extraction failed" });
  } finally {
    if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// ──────────────────────────────────────────────────────────────
// AcroForm: extract interactive (embedded) form fields
// These are actual PDF form widgets — 100% accurate positions
// ──────────────────────────────────────────────────────────────
async function extractAcroFormFields(filePath, targetPage) {
  const fields = [];

  await PDFNet.runWithCleanup(async () => {
    const doc = await PDFNet.PDFDoc.createFromFilePath(filePath);
    await doc.initSecurityHandler();

    const pageCount = await doc.getPageCount();
    if (targetPage > pageCount) return;

    const pdfPage = await doc.getPage(targetPage);
    const pageRect = await pdfPage.getCropBox();
    const pageWidth = pageRect.x2 - pageRect.x1;
    const pageHeight = pageRect.y2 - pageRect.y1;

    const itr = await doc.getFieldIteratorBegin();
    while (await itr.hasNext()) {
      const field = await itr.current();
      const fieldPage = await getFieldPage(field, doc);

      if (fieldPage === targetPage) {
        const name = await field.getName();
        const type = await field.getType();
        const value = await field.getValueAsString();
        const rect = await field.getUpdateRect();

        const left = rect.x1;
        const bottom = rect.y1;
        const right = rect.x2;
        const top = rect.y2;

        // PDF coords are bottom-up; convert to top-down
        fields.push({
          name,
          type: fieldTypeToString(type),
          value,
          rect: {
            x: left,
            y: pageHeight - top,
            width: right - left,
            height: top - bottom,
          },
          pdfRect: [left, bottom, right, top],
        });
      }

      await itr.next();
    }
  });

  return fields;
}

async function getFieldPage(field, doc) {
  try {
    const widget = await field.getSDFObj();
    if (!widget) return 1;
    const pageObj = await widget.findObj("P");
    if (!pageObj) return 1;

    const pageCount = await doc.getPageCount();
    for (let i = 1; i <= pageCount; i++) {
      const pg = await doc.getPage(i);
      const pgObj = await pg.getSDFObj();
      if (pgObj && (await pgObj.isEqual(pageObj))) return i;
    }
  } catch {}
  return 1;
}

function fieldTypeToString(type) {
  const PDFField = PDFNet.Field;
  switch (type) {
    case PDFField.Type.e_button: return "button";
    case PDFField.Type.e_check: return "checkbox";
    case PDFField.Type.e_radio: return "radio";
    case PDFField.Type.e_text: return "text";
    case PDFField.Type.e_choice: return "choice";
    case PDFField.Type.e_signature: return "signature";
    default: return "unknown";
  }
}

// ──────────────────────────────────────────────────────────────
// Data Extraction Module: AI-based form field detection
// Runs both e_Form (geometry) and e_FormKeyValue (label mapping)
// ──────────────────────────────────────────────────────────────
async function extractWithDataModule(filePath, targetPage) {
  let formFields = [];
  let kvFields = [];
  let pageWidth = 612;
  let pageHeight = 792;

  await PDFNet.runWithCleanup(async () => {
    // Get page dimensions
    const doc = await PDFNet.PDFDoc.createFromFilePath(filePath);
    await doc.initSecurityHandler();
    const pdfPage = await doc.getPage(targetPage);
    if (pdfPage) {
      const cropBox = await pdfPage.getCropBox();
      pageWidth = cropBox.x2 - cropBox.x1;
      pageHeight = cropBox.y2 - cropBox.y1;
    }

    // Form field detection (geometry-based)
    const formAvail = await PDFNet.DataExtractionModule.isModuleAvailable(
      PDFNet.DataExtractionModule.DataExtractionEngine.e_Form
    );
    if (formAvail) {
      try {
        const options = new PDFNet.DataExtractionModule.DataExtractionOptions();
        options.setPages(`${targetPage}`);

        const json = await PDFNet.DataExtractionModule.extractDataAsString(
          filePath,
          PDFNet.DataExtractionModule.DataExtractionEngine.e_Form,
          options
        );
        const parsed = JSON.parse(json);

        if (parsed.pages && parsed.pages.length > 0) {
          const pageData = parsed.pages[0];
          for (const el of pageData.formElements || []) {
            const [left, top, right, bottom] = el.rect;
            formFields.push({
              type: el.type,
              confidence: el.confidence,
              rect: {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
              },
              rawRect: el.rect,
            });
          }
        }
      } catch (err) {
        console.warn("[Apryse] Form extraction error (non-critical):", err.message);
      }
    }

    // Key-Value extraction (label-mapped)
    const kvAvail = await PDFNet.DataExtractionModule.isModuleAvailable(
      PDFNet.DataExtractionModule.DataExtractionEngine.e_FormKeyValue
    );
    if (kvAvail) {
      try {
        const options = new PDFNet.DataExtractionModule.DataExtractionOptions();
        options.setPages(`${targetPage}`);

        const json = await PDFNet.DataExtractionModule.extractDataAsString(
          filePath,
          PDFNet.DataExtractionModule.DataExtractionEngine.e_FormKeyValue,
          options
        );
        const parsed = JSON.parse(json);

        if (parsed.pages && parsed.pages.length > 0) {
          const pageData = parsed.pages[0];
          for (const kv of pageData.keyValueElements || pageData.kvElements || []) {
            const [left, top, right, bottom] = kv.rect;
            const keyWords = kv.key?.words || [];
            const valueWords = kv.words || [];

            kvFields.push({
              label: keyWords.map((w) => w.text || w).join(" "),
              value: valueWords.map((w) => w.text || w).join(" "),
              confidence: kv.confidence,
              rect: {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
              },
              keyRect: kv.key?.rect ? (() => {
                const [kl, kt, kr, kb] = kv.key.rect;
                return { x: kl, y: kt, width: kr - kl, height: kb - kt };
              })() : null,
              rawRect: kv.rect,
            });
          }
        }
      } catch (err) {
        console.warn("[Apryse] FormKeyValue extraction error (non-critical):", err.message);
      }
    }
  });

  return { formFields, kvFields, pageWidth, pageHeight };
}

// Health check
app.get("/health", async (req, res) => {
  try {
    await ensureInit();
    const formAvail = await PDFNet.DataExtractionModule.isModuleAvailable(
      PDFNet.DataExtractionModule.DataExtractionEngine.e_Form
    );
    res.json({
      status: "ok",
      dataExtractionAvailable: formAvail,
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Apryse Server] Listening on port ${PORT}`);
  ensureInit().catch((err) => console.error("[Apryse] Init failed:", err.message));
});
