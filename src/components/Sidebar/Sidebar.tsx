import { useState, useCallback } from "react";
import { ProjectList } from "../ProjectList/ProjectList";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  projects: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
}

export function Sidebar({ projects, selectedId, onSelect, onNewProject }: SidebarProps) {
  const [search, setSearch] = useState("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "downloading" | "upToDate" | "error">("idle");

  const filtered = search.trim()
    ? projects.filter((p) => p.label.toLowerCase().includes(search.toLowerCase()))
    : projects;

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus("checking");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateStatus("downloading");
        await update.downloadAndInstall();
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } else {
        setUpdateStatus("upToDate");
        setTimeout(() => setUpdateStatus("idle"), 3000);
      }
    } catch (err) {
      console.error("[Updater] Check failed:", err);
      setUpdateStatus("error");
      setTimeout(() => setUpdateStatus("idle"), 4000);
    }
  }, []);

  const updateLabel =
    updateStatus === "checking" ? "Checking…" :
    updateStatus === "downloading" ? "Downloading update…" :
    updateStatus === "upToDate" ? "Up to date" :
    updateStatus === "error" ? "Update check failed" :
    "Check for updates";

  return (
    <aside className={styles.sidebar}>
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ProjectList
        projects={filtered}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <div className={styles.footer}>
        <button type="button" className={styles.addBtn} onClick={onNewProject} title="New project">
          +
        </button>
        <button
          type="button"
          className={styles.updateBtn}
          onClick={checkForUpdates}
          disabled={updateStatus === "checking" || updateStatus === "downloading"}
        >
          {updateLabel}
        </button>
      </div>
    </aside>
  );
}
