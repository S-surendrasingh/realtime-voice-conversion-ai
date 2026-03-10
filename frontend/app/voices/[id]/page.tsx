"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { AudioUploader } from "@/components/AudioUploader";
import { TestConversionPanel } from "@/components/TestConversionPanel";
import { VoiceProfileStatusBadge } from "@/components/VoiceProfileStatusBadge";
import { VoiceSampleList } from "@/components/VoiceSampleList";
import { useVoiceProfile } from "@/hooks/useVoiceProfile";
import styles from "./page.module.css";

const RECORDING_TIPS = [
  "Record in a quiet environment.",
  "Use a normal speaking voice.",
  "Keep the microphone at a consistent distance.",
  "Avoid music or background conversations.",
  "Provide multiple natural sentences.",
  "Avoid excessive noise or clipping.",
];

export default function VoiceProfilePage() {
  const params = useParams<{ id: string }>();
  const profileId = params.id;
  const {
    profile,
    samples,
    loading,
    error,
    uploading,
    completing,
    uploadSample,
    deleteSample,
    complete,
  } = useVoiceProfile(profileId);

  if (loading) {
    return (
      <main className={styles.main}>
        <p>Loading...</p>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <p>Voice profile not found.</p>
          <Link href="/">← Back to dashboard</Link>
        </div>
      </main>
    );
  }

  const isReady = profile.status === "READY_FOR_AI_PROCESSING";
  const canComplete = profile.status === "RECORDING" && profile.valid_sample_count > 0 && !completing;

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <Link href="/" className={styles.back}>
          ← All voice profiles
        </Link>

        <div className={styles.header}>
          <h1 className={styles.title}>{profile.name}</h1>
          <VoiceProfileStatusBadge status={profile.status} />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {isReady && (
          <>
            <p className={styles.readyMessage}>✓ Ready for AI processing.</p>
            <TestConversionPanel profile={profile} />
          </>
        )}

        <section>
          <h2 className={styles.sectionHeading}>
            {isReady ? "Enrolled voice samples" : "Add voice samples"}
          </h2>
          <AudioUploader onUpload={uploadSample} uploading={uploading} />
        </section>

        <div className={styles.stats}>
          <span>Samples: {profile.sample_count}</span>
          <span>Valid: {profile.valid_sample_count}</span>
          <span>Total Duration: {profile.total_duration_seconds.toFixed(1)} sec</span>
        </div>

        <VoiceSampleList samples={samples} onDelete={deleteSample} />

        {!isReady && (
          <>
            <button
              type="button"
              disabled={!canComplete}
              onClick={complete}
              className={styles.completeButton}
            >
              {completing ? "Completing..." : "Complete Voice Enrollment"}
            </button>

            <section className={styles.tips}>
              <h3>For best results:</h3>
              <ul>
                {RECORDING_TIPS.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
