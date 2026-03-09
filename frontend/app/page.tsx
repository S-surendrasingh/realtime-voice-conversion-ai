"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BackendStatusBadge } from "@/components/BackendStatusBadge";
import { CreateVoiceProfileForm } from "@/components/CreateVoiceProfileForm";
import { VoiceProfileStatusBadge } from "@/components/VoiceProfileStatusBadge";
import { useVoiceProfiles } from "@/hooks/useVoiceProfiles";
import styles from "./page.module.css";

export default function Home() {
  const router = useRouter();
  const { profiles, loading, error } = useVoiceProfiles();

  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1 className={styles.title}>Realtime AI Voice Conversion</h1>
        <p className={styles.phase}>Phase 2 · Voice Enrollment</p>

        {error && <p className={styles.error}>{error}</p>}

        {!loading && profiles.length > 0 && (
          <section className={styles.profileList}>
            <h2 className={styles.sectionHeading}>Your voice profiles</h2>
            <ul>
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <Link href={`/voices/${profile.id}`} className={styles.profileLink}>
                    {profile.name}
                  </Link>
                  <VoiceProfileStatusBadge status={profile.status} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <CreateVoiceProfileForm onCreated={(profile) => router.push(`/voices/${profile.id}`)} />

        <BackendStatusBadge />
      </div>
    </main>
  );
}
