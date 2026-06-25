import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

interface RemoteSample {
  id: string;
  status: string;
  original_filename: string;
  mime_type: string;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/ogg": ".ogg",
};

function extensionFor(sample: RemoteSample): string {
  if (MIME_EXTENSIONS[sample.mime_type]) return MIME_EXTENSIONS[sample.mime_type];
  const fromName = path.extname(sample.original_filename);
  return fromName || ".wav";
}

/** The resident engine's `engine.load_voice` message (see
 * ai-worker/app/server/protocol.py) takes local file paths, not inline
 * bytes — the simplest option for local IPC where the caller already has
 * the files on disk (see docs/phase3.1-resident-engine.md "IPC Protocol").
 * The desktop app is a separate process from the backend and does not
 * share its storage directory, so this fetches each VALID reference
 * sample's audio over the existing backend API
 * (GET /voices/{id}/samples/{sample_id}/audio) and writes it to a scratch
 * directory the engine process can read — mirroring exactly what
 * backend/app/services/conversion.py already does internally for its own
 * offline conversion path (read from storage, write a local temp file,
 * pass that path to ai-worker). No new conversion logic, just the same
 * pattern executed from a different process. */
export async function materializeReferenceFiles(
  backendUrl: string,
  voiceProfileId: string,
  scratchRoot: string
): Promise<string[]> {
  const samplesRes = await fetch(`${backendUrl}/api/v1/voices/${voiceProfileId}/samples`);
  if (!samplesRes.ok) {
    throw new Error(`Failed to list samples for voice profile ${voiceProfileId}: HTTP ${samplesRes.status}`);
  }
  const samples = (await samplesRes.json()) as RemoteSample[];
  const validSamples = samples.filter((s) => s.status === "VALID");
  if (validSamples.length === 0) {
    throw new Error(`Voice profile ${voiceProfileId} has no VALID reference samples`);
  }

  const targetDir = path.join(scratchRoot, "voiceshift-references", voiceProfileId);
  mkdirSync(targetDir, { recursive: true });

  const paths: string[] = [];
  for (const [index, sample] of validSamples.entries()) {
    const audioRes = await fetch(`${backendUrl}/api/v1/voices/${voiceProfileId}/samples/${sample.id}/audio`);
    if (!audioRes.ok) {
      throw new Error(`Failed to fetch sample ${sample.id} audio: HTTP ${audioRes.status}`);
    }
    const buffer = Buffer.from(await audioRes.arrayBuffer());
    const filePath = path.join(targetDir, `reference_${index}${extensionFor(sample)}`);
    writeFileSync(filePath, buffer);
    paths.push(filePath);
  }
  return paths;
}
