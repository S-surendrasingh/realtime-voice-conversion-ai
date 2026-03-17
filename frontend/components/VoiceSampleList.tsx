"use client";

import type { VoiceSample } from "@/types/voice";
import styles from "./VoiceSampleList.module.css";

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  return `${seconds.toFixed(1)} sec`;
}

function formatChannels(channels: number | null): string {
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  if (channels === null) return "—";
  return `${channels} channels`;
}

export function VoiceSampleList({
  samples,
  onDelete,
}: {
  samples: VoiceSample[];
  onDelete: (sampleId: string) => void;
}) {
  if (samples.length === 0) {
    return <p className={styles.empty}>No voice samples uploaded yet.</p>;
  }

  return (
    <ul className={styles.list}>
      {samples.map((sample) => (
        <li key={sample.id} className={styles.item}>
          <div className={styles.info}>
            <span className={styles.filename}>{sample.original_filename}</span>
            {sample.status === "VALID" ? (
              <span className={styles.details}>
                Duration: {formatDuration(sample.duration_seconds)} · Sample rate:{" "}
                {sample.sample_rate ?? "—"} Hz · Channels: {formatChannels(sample.channels)}
              </span>
            ) : (
              <span className={styles.details}>{sample.validation_error}</span>
            )}
          </div>

          <span className={sample.status === "VALID" ? styles.valid : styles.invalid}>
            {sample.status === "VALID" ? "✓ Valid" : "✗ Invalid"}
          </span>

          <button type="button" className={styles.delete} onClick={() => onDelete(sample.id)}>
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
