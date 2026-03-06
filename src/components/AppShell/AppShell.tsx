import { ReactNode } from "react";
import { Sidebar } from "../Sidebar/Sidebar";
import styles from "./AppShell.module.css";

interface AppShellProps {
  children: ReactNode;
  projects: { id: string; label: string }[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
}

export function AppShell({
  children,
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
}: AppShellProps) {
  return (
    <div className={styles.shell}>
      <Sidebar
        projects={projects}
        selectedId={selectedProjectId}
        onSelect={onSelectProject}
        onNewProject={onNewProject}
      />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
