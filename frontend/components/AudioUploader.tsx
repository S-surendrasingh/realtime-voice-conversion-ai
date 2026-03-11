"use client";

import styles from "./AudioUploader.module.css";

const ACCEPTED_TYPES = ".wav,.flac,.ogg,audio/wav,audio/x-wav,audio/flac,audio/ogg";

export function AudioUploader({
  onUpload,
  uploading,
}: {
  onUpload: (file: File) => void;
  uploading: boolean;
}) {
  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      onUpload(file);
    }
  }

  return (
    <div className={styles.uploader}>
      <input
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleChange}
        disabled={uploading}
        className={styles.input}
        id="voice-sample-upload"
      />
      <label htmlFor="voice-sample-upload" className={styles.label}>
        {uploading ? "Uploading..." : "🎙 Upload Voice Sample"}
      </label>
      <p className={styles.hint}>WAV, FLAC, or OGG · 3–60 seconds</p>
    </div>
  );
}
