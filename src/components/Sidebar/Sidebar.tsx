import { ProjectList } from "../ProjectList/ProjectList";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  projects: { id: string; label: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewProject: () => void;
}

export function Sidebar({ projects, selectedId, onSelect, onNewProject }: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <h1 className={styles.logo}>Wrapkit</h1>
        <button type="button" className={styles.newBtn} onClick={onNewProject}>
          New project
        </button>
      </div>
      <ProjectList
        projects={projects}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    </aside>
  );
}
