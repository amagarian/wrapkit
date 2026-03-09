import { TrayIcon } from "@tauri-apps/api/tray";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";
import { Image } from "@tauri-apps/api/image";

let trayInstance: TrayIcon | null = null;

async function loadTrayIcon(): Promise<Image> {
  const response = await fetch("/icons/tray-icon.png");
  const buffer = await response.arrayBuffer();
  return Image.fromBytes(new Uint8Array(buffer));
}

async function showDropZone(projectId: string, projectLabel: string) {
  await emit("tray-job-selected", { projectId, projectLabel });

  const existing = await WebviewWindow.getByLabel("dropzone");
  if (existing) {
    await existing.show();
    await existing.setFocus();
  }
}

export async function initTray(
  projects: { id: string; label: string }[]
): Promise<void> {
  if (trayInstance) return;

  const icon = await loadTrayIcon();
  const menu = await buildJobMenu(projects);

  trayInstance = await TrayIcon.new({
    id: "wrapkit-tray",
    icon,
    iconAsTemplate: true,
    tooltip: "Wrapkit — Drop PDFs",
    menu,
    menuOnLeftClick: true,
  });
}

async function buildJobMenu(
  projects: { id: string; label: string }[]
): Promise<Menu> {
  const items: (MenuItem | PredefinedMenuItem)[] = [];

  for (const project of projects) {
    const item = await MenuItem.new({
      id: `tray-job-${project.id}`,
      text: project.label || "Untitled",
      action: () => {
        void showDropZone(project.id, project.label || "Untitled");
      },
    });
    items.push(item);
  }

  if (projects.length === 0) {
    items.push(
      await MenuItem.new({
        id: "tray-no-jobs",
        text: "No jobs yet",
        enabled: false,
      })
    );
  }

  items.push(await PredefinedMenuItem.new({ item: "Separator" }));

  items.push(
    await MenuItem.new({
      id: "tray-quit",
      text: "Quit Wrapkit",
      action: async () => {
        const { exit } = await import("@tauri-apps/plugin-process");
        await exit(0);
      },
    })
  );

  return Menu.new({ items });
}

export async function updateTrayMenu(
  projects: { id: string; label: string }[]
): Promise<void> {
  if (!trayInstance) return;
  const menu = await buildJobMenu(projects);
  await trayInstance.setMenu(menu);
}

export async function destroyTray(): Promise<void> {
  if (trayInstance) {
    await trayInstance.close();
    trayInstance = null;
  }
}
