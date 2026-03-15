"use client";

import { useEffect, useMemo, useState } from "react";
import { conversionAudioUrl } from "@/lib/api";
import { useVoiceConversion } from "@/hooks/useVoiceConversion";
import type { VoiceProfile } from "@/types/voice";
import styles from "./TestConversionPanel.module.css";

const ACCEPTED_TYPES = ".wav,.flac,.ogg,audio/wav,audio/x-wav,audio/flac,audio/ogg";

/**
 * Phase 3 diagnostic surface: converts an uploaded "Person B" clip toward
 * this profile's AI voice and reports real, measured performance numbers.
 * This is explicitly NOT a live/streaming feature — see
 * docs/phase3-ai-conversion.md — it exists to validate the CPU voice
 * conversion engine, one file at a time.
 */
export function TestConversionPanel({ profile }: { profile: VoiceProfile }) {
  const { converting, result, error, convert, reset } = useVoiceConversion(profile.id);
  const [sourceFile, setSourceFile] = useState<File | null>(null);

  // Object URLs are a side-effect *of* the current sourceFile, not
  // independent state — derive it during render and let the effect's only
  // job be revoking the previous one, so no setState happens in the effect.
  const sourceUrl = useMemo(() => (sourceFile ? URL.createObjectURL(sourceFile) : null), [sourceFile]);
  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSourceFile(file);
    reset();
  }

  async function handleConvert() {
    if (sourceFile) {
      await convert(sourceFile);
    }
  }

  return (
    <section className={styles.panel}>
      <h2 className={styles.heading}>Test Voice Conversion</h2>
      <p className={styles.disclaimer}>
        Converted audio is AI-generated and played back here only — it is never sent to a call or
        meeting.
      </p>

      <div className={styles.targetVoice}>
        Target Voice: <strong>{profile.name}</strong>
      </div>

      <div className={styles.field}>
        <label htmlFor="test-conversion-source" className={styles.fileLabel}>
          Upload Person B Audio
        </label>
        <input
          id="test-conversion-source"
          type="file"
          accept={ACCEPTED_TYPES}
          onChange={handleFileChange}
          className={styles.fileInput}
        />
        <p className={styles.hint}>WAV, FLAC, or OGG</p>
      </div>

      {sourceUrl && (
        <div className={styles.playbackRow}>
          <span className={styles.playbackLabel}>Source</span>
          <audio controls src={sourceUrl} className={styles.audio} />
        </div>
      )}

      <button
        type="button"
        className={styles.convertButton}
        disabled={!sourceFile || converting}
        onClick={() => void handleConvert()}
      >
        {converting ? "Processing..." : "Convert to Target Voice"}
      </button>

      {error && <p className={styles.error}>{error}</p>}

      {result && (
        <div className={styles.result}>
          <div className={styles.playbackRow}>
            <span className={styles.playbackLabel}>Result</span>
            <audio
              controls
              src={conversionAudioUrl(profile.id, result.conversion_id)}
              className={styles.audio}
            />
          </div>
          <dl className={styles.metrics}>
            <div>
              <dt>Input duration</dt>
              <dd>{result.source_duration_seconds.toFixed(1)} sec</dd>
            </div>
            <div>
              <dt>Processing</dt>
              <dd>{result.processing_time_seconds.toFixed(1)} sec</dd>
            </div>
            <div>
              <dt>RTF</dt>
              <dd>{result.rtf.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>{result.device.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{result.model ?? "—"}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}
