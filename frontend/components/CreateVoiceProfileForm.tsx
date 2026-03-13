"use client";

import { useState } from "react";
import { ApiError, createVoiceProfile } from "@/lib/api";
import type { VoiceProfile } from "@/types/voice";
import styles from "./CreateVoiceProfileForm.module.css";

export function CreateVoiceProfileForm({
  onCreated,
}: {
  onCreated: (profile: VoiceProfile) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && consentConfirmed && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      const profile = await createVoiceProfile({
        name: name.trim(),
        description: description.trim() || undefined,
        consent_confirmed: consentConfirmed,
      });
      onCreated(profile);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create voice profile.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <h2 className={styles.heading}>Create Target Voice</h2>

      <label className={styles.field}>
        <span>Voice Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Person A"
          maxLength={200}
          required
        />
      </label>

      <label className={styles.field}>
        <span>Description</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="My target voice profile"
          maxLength={2000}
          rows={3}
        />
      </label>

      <label className={styles.consent}>
        <input
          type="checkbox"
          checked={consentConfirmed}
          onChange={(event) => setConsentConfirmed(event.target.checked)}
        />
        <span>I confirm I have permission to create and use this voice profile.</span>
      </label>

      {error && <p className={styles.error}>{error}</p>}

      <button type="submit" disabled={!canSubmit}>
        {submitting ? "Creating..." : "Create Voice Profile"}
      </button>
    </form>
  );
}
