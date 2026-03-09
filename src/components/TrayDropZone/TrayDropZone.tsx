import { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { emit } from "@tauri-apps/api/event";
import styles from "./TrayDropZone.module.css";

type DropStatus = "idle" | "processing" | "done" | "error";

interface JobSelection {
  projectId: string;
  projectLabel: string;
}

export function TrayDropZone() {
  const [job, setJob] = useState<JobSelection | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [status, setStatus] = useState<DropStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const unlisten = listen<JobSelection>("tray-job-selected", (event) => {
      setJob(event.payload);
      setStatus("idle");
      setStatusMessage("");
      resetIdleTimer();
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(async () => {
      const win = getCurrentWebviewWindow();
      await win.hide();
    }, 30000);
  }, []);

  const hideWindow = useCallback(async () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    const win = getCurrentWebviewWindow();
    await win.hide();
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
      resetIdleTimer();
    },
    [resetIdleTimer]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const processPdf = useCallback(
    async (file: File) => {
      if (!job) return;
      setStatus("processing");
      setStatusMessage(`Processing ${file.name}…`);

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        await emit("tray-pdf-dropped", {
          projectId: job.projectId,
          fileName: file.name,
          bytesBase64: uint8ArrayToBase64(bytes),
        });

        setStatus("done");
        setStatusMessage(`Added ${file.name}`);

        let granted = await isPermissionGranted();
        if (!granted) {
          const permission = await requestPermission();
          granted = permission === "granted";
        }
        if (granted) {
          sendNotification({
            title: "Wrapkit",
            body: `${file.name} added to ${job.projectLabel}`,
          });
        }

        setTimeout(() => {
          void hideWindow();
          setStatus("idle");
          setStatusMessage("");
        }, 2000);
      } catch (err) {
        setStatus("error");
        setStatusMessage(
          `Error: ${err instanceof Error ? err.message : "Unknown"}`
        );
        setTimeout(() => {
          setStatus("idle");
          setStatusMessage("");
        }, 4000);
      }
    },
    [job, hideWindow]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const files = [...e.dataTransfer.files].filter(
        (f) => f.type === "application/pdf"
      );

      if (files.length === 0) return;

      for (const file of files) {
        void processPdf(file);
      }
    },
    [processPdf]
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.jobName}>
          {job?.projectLabel ?? "Select a job…"}
        </span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={() => void hideWindow()}
          title="Close"
        >
          ×
        </button>
      </div>

      <div
        className={`${styles.dropArea} ${isDragOver ? styles.dragOver : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {status === "idle" && (
          <>
            <span className={styles.dropIcon}>+</span>
            <span className={styles.dropText}>
              Drop PDF here
            </span>
          </>
        )}
        {status === "processing" && (
          <>
            <div className={styles.spinner} />
            <span className={styles.statusText}>{statusMessage}</span>
          </>
        )}
        {status === "done" && (
          <>
            <span className={styles.successIcon}>✓</span>
            <span className={styles.statusText}>{statusMessage}</span>
          </>
        )}
        {status === "error" && (
          <span className={styles.statusText}>{statusMessage}</span>
        )}
      </div>
    </div>
  );
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
