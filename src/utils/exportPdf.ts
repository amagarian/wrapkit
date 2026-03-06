function downloadInBrowser(bytes: Uint8Array, fileName: string) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Tries to use native Tauri "Save as…" + filesystem write when available.
 * Falls back to browser download when running as web.
 */
export async function exportPdfBytes(bytes: Uint8Array, suggestedFileName: string): Promise<{
  method: "tauri" | "browser";
  canceled?: boolean;
}> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");

    const path = await save({
      defaultPath: suggestedFileName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (!path) return { method: "tauri", canceled: true };
    await writeFile(path, bytes);
    return { method: "tauri" };
  } catch {
    downloadInBrowser(bytes, suggestedFileName);
    return { method: "browser" };
  }
}

