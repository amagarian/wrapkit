import { useCallback, useState } from "react";
import styles from "./PdfDropzone.module.css";

interface PdfDropzoneProps {
  onDrop: (file: File | null) => void;
}

export function PdfDropzone({ onDrop }: PdfDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file?.type === "application/pdf") {
        onDrop(file);
      } else {
        onDrop(null);
      }
    },
    [onDrop]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file?.type === "application/pdf") {
        onDrop(file);
      } else {
        onDrop(null);
      }
      e.target.value = "";
    },
    [onDrop]
  );

  return (
    <div
      className={`${styles.dropzone} ${isDragOver ? styles.dragOver : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        type="file"
        accept=".pdf,application/pdf"
        className={styles.input}
        onChange={handleFileInput}
        aria-label="Upload PDF"
      />
      <span className={styles.icon}>+</span>
    </div>
  );
}
