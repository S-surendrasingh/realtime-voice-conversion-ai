import { useMemo } from "react";
import { Card, Row } from "../components/Card";
import { StatusBadge, type StatusTone } from "../components/StatusBadge";
import { useVoiceProfiles } from "../hooks/useVoiceProfiles";
import { useSettings } from "../hooks/useSettings";
import { useLiveVoiceStore } from "../services/singletons";
import type { VoiceProfile, VoiceProfileStatus } from "../services/BackendClient";

const STATUS_TONE: Record<VoiceProfileStatus, StatusTone> = {
  READY_FOR_AI_PROCESSING: "good",
  PROCESSING: "warn",
  RECORDING: "idle",
};

const STATUS_LABEL: Record<VoiceProfileStatus, string> = {
  READY_FOR_AI_PROCESSING: "READY FOR AI",
  PROCESSING: "PROCESSING",
  RECORDING: "RECORDING",
};

/** Read-only selection screen — Step 12 of the product spec. Enrollment,
 * recording, and retraining all happen in the separate web app; this screen
 * only lets the user pick which already-enrolled profile Live Voice should
 * use as its AI-generated target voice. No retrain/re-enroll action here. */
export function VoiceProfilesScreen() {
  const { profiles, loading, error, backendUnavailable, refresh } = useVoiceProfiles();
  const store = useLiveVoiceStore();
  const { update } = useSettings();

  const { ready, notReady } = useMemo(() => {
    return {
      ready: profiles.filter((p) => p.status === "READY_FOR_AI_PROCESSING"),
      notReady: profiles.filter((p) => p.status !== "READY_FOR_AI_PROCESSING"),
    };
  }, [profiles]);

  const handleUseVoice = (profile: VoiceProfile) => {
    store.setSelectedVoiceProfileId(profile.id);
    update({ voiceProfileId: profile.id });
  };

  return (
    <div>
      <h1 className="vs-page-title">Voice Profiles</h1>
      <p className="vs-page-subtitle">
        Pick the AI-generated target voice Live Voice should use. Profiles are enrolled and recorded separately via
        the web app — this screen only selects among ones that already exist.
      </p>

      {backendUnavailable && (
        <Card>
          <div className="vs-banner vs-banner-error">Backend unavailable — check System Check</div>
          <button className="vs-btn" onClick={() => refresh()}>
            Retry
          </button>
        </Card>
      )}

      {!backendUnavailable && loading && (
        <Card>
          <div className="vs-label">Loading voice profiles…</div>
        </Card>
      )}

      {!backendUnavailable && !loading && error && (
        <Card>
          <div className="vs-banner vs-banner-error">{error}</div>
        </Card>
      )}

      {!backendUnavailable && !loading && !error && profiles.length === 0 && (
        <Card>
          <div className="vs-label">No voice profiles yet. Enroll one via the web app.</div>
        </Card>
      )}

      {!backendUnavailable && !loading && !error && profiles.length > 0 && (
        <>
          {ready.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              selected={store.selectedVoiceProfileId === profile.id}
              onUse={() => handleUseVoice(profile)}
            />
          ))}
          {notReady.map((profile) => (
            <ProfileCard key={profile.id} profile={profile} selected={store.selectedVoiceProfileId === profile.id} />
          ))}
        </>
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  selected,
  onUse,
}: {
  profile: VoiceProfile;
  selected: boolean;
  onUse?: () => void;
}) {
  const isReady = profile.status === "READY_FOR_AI_PROCESSING";
  return (
    <div
      style={{
        marginBottom: 14,
        borderRadius: "var(--radius-lg)",
        opacity: isReady ? 1 : 0.65,
        boxShadow: selected ? "0 0 0 2px var(--accent)" : undefined,
      }}
    >
      <Card
        title={profile.name}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {selected && <StatusBadge tone="good" label="Selected" />}
            <StatusBadge tone={STATUS_TONE[profile.status]} label={STATUS_LABEL[profile.status]} />
          </div>
        }
      >
        {profile.description && <Row label="Description" value={profile.description} />}
        {isReady ? (
          <Row label="Samples" value={`${profile.valid_sample_count} valid samples`} />
        ) : (
          <Row label="Status" value={`Not ready yet — status: ${profile.status}`} />
        )}
        {isReady && (
          <div style={{ marginTop: 12 }}>
            <button className="vs-btn vs-btn-primary" onClick={onUse}>
              Use This Voice
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
