import path from "node:path";
import { app, BrowserWindow, session, shell } from "electron";
import { EngineProcessManager } from "./engineProcessManager";
import { SettingsStore } from "./settingsStore";
import { getPlatformIntegration } from "./platform";
import { loadMainConfig } from "./config";
import { registerIpcHandlers } from "./ipcHandlers";
import { IPC } from "../shared/ipcChannels";

const config = loadMainConfig();
const platformIntegration = getPlatformIntegration(process.platform);
const settingsStore = new SettingsStore(app.getPath("userData"));

let mainWindow: BrowserWindow | null = null;

const engineProcessManager = new EngineProcessManager({
  mode: config.engineMode,
  host: config.engineHost,
  port: config.engineWsPort,
  pythonPath: config.enginePythonPath,
  cwd: config.engineCwd,
  engineName: config.engineName,
  onLog: (line) => mainWindow?.webContents.send(IPC.ENGINE_LOG, line),
  onStatusChange: (status) => mainWindow?.webContents.send(IPC.ENGINE_STATUS_CHANGED, status),
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "VoiceShift AI",
    backgroundColor: "#0b1120",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // This is a trusted, first-party desktop app (not a browser rendering
  // arbitrary remote content) — Live Voice genuinely needs microphone
  // access, so auto-approve only that, on our own window, and deny
  // everything else explicitly rather than falling through to Electron's
  // default prompt-less allow for unhandled permission types.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const isOwnWindow = webContents.id === win.webContents.id;
    callback(isOwnWindow && permission === "media");
  });

  // Never let the renderer navigate to or open arbitrary remote content.
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://localhost:") && !url.startsWith("file://")) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  mainWindow = createWindow();
  registerIpcHandlers({
    engineProcessManager,
    settingsStore,
    platformIntegration,
    config,
    scratchRoot: app.getPath("temp"),
  });

  if (config.engineMode === "managed") {
    engineProcessManager.start().catch((err) => {
      console.error("Failed to start resident engine:", err);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  if (config.engineMode !== "managed") return;
  event.preventDefault();
  shuttingDown = true;
  engineProcessManager
    .stop()
    .catch(() => undefined)
    .finally(() => app.quit());
});
