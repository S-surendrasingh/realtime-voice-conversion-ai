import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, type PersistedSettings } from "../shared/types";

/** Small JSON-file-backed settings store. Only ever holds the non-sensitive
 * preference fields in PersistedSettings — never raw audio, never voice
 * sample bytes. */
export class SettingsStore {
  private readonly filePath: string;
  private cache: PersistedSettings;

  constructor(userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true });
    this.filePath = path.join(userDataDir, "settings.json");
    this.cache = this.load();
  }

  private load(): PersistedSettings {
    if (!existsSync(this.filePath)) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      // Corrupt settings file must never crash the app — fall back to
      // defaults rather than surfacing a raw JSON parse error to the user.
      return { ...DEFAULT_SETTINGS };
    }
  }

  get(): PersistedSettings {
    return { ...this.cache };
  }

  set(patch: Partial<PersistedSettings>): PersistedSettings {
    this.cache = { ...this.cache, ...patch };
    writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
    return this.get();
  }
}
