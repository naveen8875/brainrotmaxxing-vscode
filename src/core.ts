import * as path from "path";

export const EXTENSION_NAME = "BrainrotMaxxing";
export const OUTPUT_CHANNEL_NAME = "BrainrotMaxxing Diagnostics";
export const SIDE_CAR_PANEL_TYPE = "brainrotmaxxing.sidecarPanel";

export const COMPAT_COMMAND_ID = "brainrotmaxxing.openInstagramSideBySide";
export const OPEN_SIDECAR_COMMAND_ID = "brainrotmaxxing.openReelsSidecar";
export const INSTALL_RUNTIME_COMMAND_ID = "brainrotmaxxing.installRuntime";
export const RUN_DIAGNOSTICS_COMMAND_ID = "brainrotmaxxing.runIntegratedDiagnostics";
export const RESTART_SIDECAR_COMMAND_ID = "brainrotmaxxing.restartSidecar";

export const STATE_RUNTIME_METADATA_KEY = "brainrotmaxxing.runtimeMetadata";
export const STATE_LAST_DIAGNOSTICS_KEY = "brainrotmaxxing.lastDiagnostics";
export const STATE_PROFILE_LOCK_EVENTS_KEY =
  "brainrotmaxxing.profileLockEvents";

export const ACTION_INSTALL_RUNTIME = "Validate Runtime";
export const ACTION_RUN_DIAGNOSTICS = "Run Diagnostics";
export const ACTION_OPEN_REPORT = "Open Report";
export const ACTION_RESTART_SIDECAR = "Restart Sidecar";

export const DIAGNOSTICS_STALE_MS = 3 * 24 * 60 * 60 * 1000;
export const DEFAULT_START_URL = "https://www.instagram.com/reels/";

export type RiskLevel = "low" | "medium" | "high";

export interface DisposableLike {
  dispose(): void;
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[];
}

export interface CommandsLike {
  registerCommand(
    command: string,
    callback: (...args: unknown[]) => unknown
  ): DisposableLike;
}

export interface WindowLike {
  showErrorMessage(message: string): PromiseLike<string | undefined>;
  showWarningMessage(
    message: string,
    ...items: string[]
  ): PromiseLike<string | undefined>;
  showInformationMessage(
    message: string,
    ...items: string[]
  ): PromiseLike<string | undefined>;
}

export interface OutputChannelLike {
  clear(): void;
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
}

export interface ConfigurationLike {
  get<T>(section: string, key: string, defaultValue: T): T;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface RuntimeMetadata {
  source: "system-chrome" | "downloaded-chromium";
  browserName?: "chrome" | "edge" | "brave";
  browserVersion?: string;
  channel?: string;
  buildId?: string;
  platform: string;
  executablePath: string;
  cacheDir?: string;
  installedAt: string;
}

export interface RuntimeInstallResult {
  metadata: RuntimeMetadata;
  installedNow: boolean;
}

export interface SidecarStats {
  running: boolean;
  port: number | null;
  fps: number | null;
  averageFrameLatencyMs: number | null;
  droppedFrames: number;
  transportConnectedClients: number;
  lastFrameAt: string | null;
  lastError: string | null;
  codecSupport: "unknown" | "supported" | "unsupported";
  codecDetails: string | null;
}

export interface LastDiagnosticsSnapshot {
  generatedAt: string;
  riskLevel: RiskLevel;
  runtimeInstalled: boolean;
  sidecarRunning: boolean;
  averageFrameLatencyMs: number | null;
  droppedFrames: number;
  codecSupport: "unknown" | "supported" | "unsupported";
  profileLockEvents: number;
}

export interface DiagnosticsResult {
  generatedAt: string;
  riskLevel: RiskLevel;
  runtimeInstalled: boolean;
  runtimeMetadata: RuntimeMetadata | null;
  runtimeHealth: {
    executableExists: boolean;
    cacheDirExists: boolean;
  };
  sidecar: SidecarStats;
  profileLockEvents: number;
  profileHealth: {
    profileDir: string;
    exists: boolean;
    writable: boolean;
  };
  audio: {
    enabledSetting: boolean;
    phase: "phase1_pending" | "phase2_ready";
    status: "disabled" | "not_implemented" | "ready";
  };
  recommendations: string[];
}

export interface RuntimeManagerLike {
  getInstalledRuntime(): Promise<RuntimeMetadata | null>;
  installRuntime(channel: string): Promise<RuntimeInstallResult>;
  getProfileDir(mode: "persistent" | "ephemeral"): string;
  checkProfileHealth(profileDir: string): Promise<{ exists: boolean; writable: boolean }>;
  checkRuntimeHealth(
    metadata: RuntimeMetadata | null
  ): Promise<{ executableExists: boolean; cacheDirExists: boolean }>;
}

export interface SidecarManagerLike {
  openPanel(options: {
    runtime: RuntimeMetadata;
    profileDir: string;
    startUrl: string;
    viewportMode: "mobile" | "desktop";
    fpsCap: number;
    audioEnabled: boolean;
  }): Promise<void>;
  restart(): Promise<void>;
  resetSession(): Promise<void>;
  getStats(): SidecarStats;
}

export interface Dependencies {
  commands: CommandsLike;
  window: WindowLike;
  output: OutputChannelLike;
  config: ConfigurationLike;
  state: MementoLike;
  runtimeManager: RuntimeManagerLike;
  sidecarManager: SidecarManagerLike;
  now(): number;
}

export async function openReelsSidecar(
  dependencies: Dependencies
): Promise<void> {
  const profileMode = dependencies.config.get<"persistent" | "ephemeral">(
    "brainrotmaxxing",
    "profile.mode",
    "persistent"
  );
  const viewportMode = dependencies.config.get<"mobile" | "desktop">(
    "brainrotmaxxing",
    "viewport.mode",
    "desktop"
  );
  const fpsCap = dependencies.config.get<number>(
    "brainrotmaxxing",
    "stream.fpsCap",
    30
  );
  const audioEnabled = dependencies.config.get<boolean>(
    "brainrotmaxxing",
    "audio.enabled",
    true
  );

  let runtimeMetadata = await dependencies.runtimeManager.getInstalledRuntime();
  if (!runtimeMetadata) {
    const action = await dependencies.window.showWarningMessage(
      "No supported system browser runtime detected. Install Chrome, Edge, or Brave, then validate runtime.",
      ACTION_INSTALL_RUNTIME
    );
    if (action !== ACTION_INSTALL_RUNTIME) {
      return;
    }

    try {
      const installResult = await dependencies.runtimeManager.installRuntime(
        "system"
      );
      runtimeMetadata = installResult.metadata;
      await dependencies.state.update(
        STATE_RUNTIME_METADATA_KEY,
        installResult.metadata
      );
    } catch (error) {
      await dependencies.window.showErrorMessage(
        `Runtime validation failed: ${toErrorMessage(error)}`
      );
      return;
    }
  }

  const primaryProfileDir = dependencies.runtimeManager.getProfileDir(
    profileMode
  );
  try {
    await dependencies.sidecarManager.openPanel({
      runtime: runtimeMetadata,
      profileDir: primaryProfileDir,
      startUrl: DEFAULT_START_URL,
      viewportMode,
      fpsCap: clampFps(fpsCap),
      audioEnabled,
    });
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    if (profileMode === "persistent" && isProfileInUseError(errorMessage)) {
      await incrementProfileLockEvents(dependencies.state);
      try {
        await dependencies.sidecarManager.resetSession();
      } catch {
        // ignore reset errors and continue with retries
      }

      const recoveryProfileDir = path.join(
        dependencies.runtimeManager.getProfileDir("ephemeral"),
        `recovery-${dependencies.now()}`
      );
      try {
        await dependencies.sidecarManager.openPanel({
          runtime: runtimeMetadata,
          profileDir: primaryProfileDir,
          startUrl: DEFAULT_START_URL,
          viewportMode,
          fpsCap: clampFps(fpsCap),
          audioEnabled,
        });
        await dependencies.window.showWarningMessage(
          "Persistent profile was locked. Sidecar session was reset and retried with your persistent profile."
        );
      } catch (retryError) {
        if (!isProfileInUseError(toErrorMessage(retryError))) {
          await dependencies.window.showErrorMessage(
            `Failed to open in-editor Chromium sidecar: ${sanitizeSidecarError(
              toErrorMessage(retryError)
            )}`
          );
          return;
        }

        await incrementProfileLockEvents(dependencies.state);
        try {
          await dependencies.sidecarManager.openPanel({
            runtime: runtimeMetadata,
            profileDir: recoveryProfileDir,
            startUrl: DEFAULT_START_URL,
            viewportMode,
            fpsCap: clampFps(fpsCap),
            audioEnabled,
          });
          await dependencies.window.showWarningMessage(
            "Persistent profile remains locked. Opened with a temporary recovery profile for this session."
          );
        } catch (recoveryError) {
          await dependencies.window.showErrorMessage(
            `Failed to open in-editor Chromium sidecar: ${sanitizeSidecarError(
              toErrorMessage(recoveryError)
            )}`
          );
          return;
        }
      }
    } else {
      await dependencies.window.showErrorMessage(
        `Failed to open in-editor Chromium sidecar: ${sanitizeSidecarError(
          errorMessage
        )}`
      );
      return;
    }
  }

  const sidecarStats = dependencies.sidecarManager.getStats();
  if (sidecarStats.codecSupport === "unsupported") {
    const action = await dependencies.window.showWarningMessage(
      "System browser codec probe reported unsupported H.264/AAC playback. Reels may fail to play.",
      ACTION_RUN_DIAGNOSTICS,
      ACTION_RESTART_SIDECAR
    );
    if (action === ACTION_RUN_DIAGNOSTICS) {
      await runSidecarDiagnostics(dependencies);
      return;
    }
    if (action === ACTION_RESTART_SIDECAR) {
      await restartSidecar(dependencies);
      return;
    }
  }

  const warning = getPostOpenWarning(
    dependencies.state.get<LastDiagnosticsSnapshot>(STATE_LAST_DIAGNOSTICS_KEY),
    dependencies.now()
  );
  if (!warning) {
    return;
  }

  const action = await dependencies.window.showWarningMessage(
    warning,
    ACTION_RUN_DIAGNOSTICS,
    ACTION_RESTART_SIDECAR
  );
  if (action === ACTION_RUN_DIAGNOSTICS) {
    await runSidecarDiagnostics(dependencies);
    return;
  }
  if (action === ACTION_RESTART_SIDECAR) {
    await restartSidecar(dependencies);
  }
}

export async function installRuntimeCommand(
  dependencies: Dependencies
): Promise<void> {
  try {
    const result = await dependencies.runtimeManager.installRuntime("system");
    await dependencies.state.update(STATE_RUNTIME_METADATA_KEY, result.metadata);
    await dependencies.window.showInformationMessage(
      result.installedNow
        ? "System browser runtime validated successfully."
        : "System browser runtime is already valid."
    );
  } catch (error) {
    await dependencies.window.showErrorMessage(
      `Runtime validation failed: ${toErrorMessage(error)}`
    );
  }
}

export async function restartSidecar(dependencies: Dependencies): Promise<void> {
  try {
    await dependencies.sidecarManager.restart();
    await dependencies.window.showInformationMessage("Sidecar restarted.");
  } catch (error) {
    await dependencies.window.showErrorMessage(
      `Failed to restart sidecar: ${toErrorMessage(error)}`
    );
  }
}

export async function runSidecarDiagnostics(
  dependencies: Dependencies
): Promise<DiagnosticsResult> {
  const generatedAt = new Date(dependencies.now()).toISOString();
  const profileMode = dependencies.config.get<"persistent" | "ephemeral">(
    "brainrotmaxxing",
    "profile.mode",
    "persistent"
  );
  const audioEnabled = dependencies.config.get<boolean>(
    "brainrotmaxxing",
    "audio.enabled",
    true
  );

  const runtimeMetadata = await dependencies.runtimeManager.getInstalledRuntime();
  const runtimeHealth = await dependencies.runtimeManager.checkRuntimeHealth(
    runtimeMetadata
  );
  const sidecar = dependencies.sidecarManager.getStats();
  const profileLockEvents =
    dependencies.state.get<number>(STATE_PROFILE_LOCK_EVENTS_KEY) ?? 0;

  const profileDir = dependencies.runtimeManager.getProfileDir(profileMode);
  const profileHealthRaw = await dependencies.runtimeManager.checkProfileHealth(
    profileDir
  );
  const profileHealth = {
    profileDir,
    exists: profileHealthRaw.exists,
    writable: profileHealthRaw.writable,
  };

  const audio = {
    enabledSetting: audioEnabled,
    phase: "phase1_pending" as const,
    status: audioEnabled ? ("not_implemented" as const) : ("disabled" as const),
  };

  const evaluation = evaluateSidecarRisk({
    runtimeInstalled: runtimeMetadata !== null,
    runtimeMetadata,
    runtimeHealth,
    sidecar,
    profileLockEvents,
    profileHealth,
    audio,
  });

  const diagnostics: DiagnosticsResult = {
    generatedAt,
    riskLevel: evaluation.riskLevel,
    runtimeInstalled: runtimeMetadata !== null,
    runtimeMetadata,
    runtimeHealth,
    sidecar,
    profileLockEvents,
    profileHealth,
    audio,
    recommendations: evaluation.recommendations,
  };

  dependencies.output.clear();
  dependencies.output.appendLine(`${EXTENSION_NAME} Sidecar Diagnostics`);
  dependencies.output.appendLine("=".repeat(50));
  dependencies.output.appendLine(`Generated At: ${diagnostics.generatedAt}`);
  dependencies.output.appendLine("");
  dependencies.output.appendLine("Runtime:");
  dependencies.output.appendLine(
    `- Installed: ${String(diagnostics.runtimeInstalled)}`
  );
  dependencies.output.appendLine(
    `- Executable Exists: ${String(diagnostics.runtimeHealth.executableExists)}`
  );
  dependencies.output.appendLine(
    `- Cache Dir Exists: ${String(diagnostics.runtimeHealth.cacheDirExists)}`
  );
  if (diagnostics.runtimeMetadata) {
    dependencies.output.appendLine(
      `- Executable: ${diagnostics.runtimeMetadata.executablePath}`
    );
    dependencies.output.appendLine(
      `- Browser: ${diagnostics.runtimeMetadata.browserName ?? "unknown"}`
    );
    dependencies.output.appendLine(
      `- Version: ${diagnostics.runtimeMetadata.browserVersion ?? "unknown"}`
    );
    dependencies.output.appendLine(
      `- Source: ${diagnostics.runtimeMetadata.source}`
    );
  }

  dependencies.output.appendLine("");
  dependencies.output.appendLine("Transport:");
  dependencies.output.appendLine(`- Running: ${String(diagnostics.sidecar.running)}`);
  dependencies.output.appendLine(
    `- Port: ${diagnostics.sidecar.port === null ? "none" : diagnostics.sidecar.port}`
  );
  dependencies.output.appendLine(
    `- FPS: ${diagnostics.sidecar.fps === null ? "unknown" : diagnostics.sidecar.fps}`
  );
  dependencies.output.appendLine(
    `- Avg Frame Latency (ms): ${
      diagnostics.sidecar.averageFrameLatencyMs === null
        ? "unknown"
        : diagnostics.sidecar.averageFrameLatencyMs.toFixed(2)
    }`
  );
  dependencies.output.appendLine(
    `- Dropped Frames: ${diagnostics.sidecar.droppedFrames}`
  );
  dependencies.output.appendLine(
    `- Connected Clients: ${diagnostics.sidecar.transportConnectedClients}`
  );
  dependencies.output.appendLine(
    `- Last Frame At: ${diagnostics.sidecar.lastFrameAt ?? "unknown"}`
  );
  dependencies.output.appendLine(
    `- Last Error: ${diagnostics.sidecar.lastError ?? "none"}`
  );
  dependencies.output.appendLine(
    `- Codec Support: ${diagnostics.sidecar.codecSupport}`
  );
  dependencies.output.appendLine(
    `- Codec Details: ${diagnostics.sidecar.codecDetails ?? "none"}`
  );

  dependencies.output.appendLine("");
  dependencies.output.appendLine("Recovery:");
  dependencies.output.appendLine(
    `- Profile Lock Events: ${diagnostics.profileLockEvents}`
  );

  dependencies.output.appendLine("");
  dependencies.output.appendLine("Profile:");
  dependencies.output.appendLine(`- Dir: ${diagnostics.profileHealth.profileDir}`);
  dependencies.output.appendLine(
    `- Exists: ${String(diagnostics.profileHealth.exists)}`
  );
  dependencies.output.appendLine(
    `- Writable: ${String(diagnostics.profileHealth.writable)}`
  );

  dependencies.output.appendLine("");
  dependencies.output.appendLine("Audio:");
  dependencies.output.appendLine(
    `- Enabled Setting: ${String(diagnostics.audio.enabledSetting)}`
  );
  dependencies.output.appendLine(`- Phase: ${diagnostics.audio.phase}`);
  dependencies.output.appendLine(`- Status: ${diagnostics.audio.status}`);

  dependencies.output.appendLine("");
  dependencies.output.appendLine(`Risk: ${diagnostics.riskLevel.toUpperCase()}`);
  dependencies.output.appendLine("Recommendations:");
  if (diagnostics.recommendations.length === 0) {
    dependencies.output.appendLine("- none");
  } else {
    for (const recommendation of diagnostics.recommendations) {
      dependencies.output.appendLine(`- ${recommendation}`);
    }
  }
  dependencies.output.show(true);

  const snapshot: LastDiagnosticsSnapshot = {
    generatedAt: diagnostics.generatedAt,
    riskLevel: diagnostics.riskLevel,
    runtimeInstalled: diagnostics.runtimeInstalled,
    sidecarRunning: diagnostics.sidecar.running,
    averageFrameLatencyMs: diagnostics.sidecar.averageFrameLatencyMs,
    droppedFrames: diagnostics.sidecar.droppedFrames,
    codecSupport: diagnostics.sidecar.codecSupport,
    profileLockEvents: diagnostics.profileLockEvents,
  };
  await dependencies.state.update(STATE_LAST_DIAGNOSTICS_KEY, snapshot);

  const action = await dependencies.window.showInformationMessage(
    `Diagnostics complete: ${diagnostics.riskLevel.toUpperCase()} risk.`,
    ACTION_OPEN_REPORT
  );
  if (action === ACTION_OPEN_REPORT) {
    dependencies.output.show(true);
  }

  return diagnostics;
}

export function evaluateSidecarRisk(input: {
  runtimeInstalled: boolean;
  runtimeMetadata: RuntimeMetadata | null;
  runtimeHealth: { executableExists: boolean; cacheDirExists: boolean };
  sidecar: SidecarStats;
  profileLockEvents: number;
  profileHealth: { exists: boolean; writable: boolean };
  audio: { enabledSetting: boolean; status: "disabled" | "not_implemented" | "ready" };
}): { riskLevel: RiskLevel; recommendations: string[] } {
  const recommendations: string[] = [];
  let score = 0;

  if (!input.runtimeInstalled) {
    score += 6;
    recommendations.push(
      "Run 'Install Runtime' to validate a supported browser (Chrome, Edge, or Brave)."
    );
  }
  if (!input.runtimeHealth.executableExists) {
    score += 3;
    recommendations.push(
      "Detected browser executable is missing. Re-run runtime validation."
    );
  }
  if (
    input.runtimeMetadata &&
    input.runtimeMetadata.source !== "system-chrome"
  ) {
    score += 6;
    recommendations.push(
      "Runtime source is not system browser. Re-validate runtime to switch to Chrome/Edge/Brave."
    );
  }
  if (!input.profileHealth.exists) {
    score += 2;
    recommendations.push("Profile directory is missing. Restart sidecar to recreate it.");
  }
  if (!input.profileHealth.writable) {
    score += 3;
    recommendations.push("Profile directory is not writable. Fix permissions.");
  }
  if (!input.sidecar.running) {
    score += 3;
    recommendations.push("Sidecar is not running. Use 'Restart Sidecar'.");
  }
  if (input.sidecar.codecSupport === "unsupported") {
    score += 6;
    recommendations.push(
      "Codec probe indicates unsupported H.264/AAC playback. Use Google Chrome first, then rerun diagnostics."
    );
  }
  if (input.profileLockEvents >= 2) {
    score += 3;
    recommendations.push(
      "Repeated profile locks detected. Close other Chrome/Edge/Brave instances that may share this profile."
    );
  }
  if (
    input.sidecar.averageFrameLatencyMs !== null &&
    input.sidecar.averageFrameLatencyMs > 250
  ) {
    score += 1;
    recommendations.push(
      "High frame latency detected. Lower stream FPS cap or reduce system load."
    );
  }
  if (input.sidecar.droppedFrames > 100) {
    score += 1;
    recommendations.push(
      "High dropped frame count detected. Restart sidecar and reduce FPS cap."
    );
  }
  if (input.audio.enabledSetting && input.audio.status === "not_implemented") {
    recommendations.push(
      "Audio sync is planned for Phase 2. Current build is video-first."
    );
  }

  let riskLevel: RiskLevel = "low";
  if (score >= 6) {
    riskLevel = "high";
  } else if (score >= 3) {
    riskLevel = "medium";
  }
  return { riskLevel, recommendations };
}

export function getPostOpenWarning(
  snapshot: LastDiagnosticsSnapshot | undefined,
  nowMs: number
): string | null {
  if (!snapshot) {
    return "Diagnostics are missing. Run diagnostics if playback looks unstable.";
  }
  const generatedMs = Date.parse(snapshot.generatedAt);
  if (Number.isNaN(generatedMs) || nowMs - generatedMs > DIAGNOSTICS_STALE_MS) {
    return "Diagnostics are stale. Re-run diagnostics for updated recommendations.";
  }
  if (snapshot.riskLevel === "high") {
    return "Last diagnostics reported HIGH risk for sidecar playback.";
  }
  if (snapshot.codecSupport === "unsupported") {
    return "Last diagnostics detected unsupported video codec support.";
  }
  if (snapshot.profileLockEvents >= 2) {
    return "Recent sessions reported repeated profile lock conflicts.";
  }
  return null;
}

export function clampFps(value: number): number {
  if (!Number.isFinite(value)) {
    return 30;
  }
  return Math.max(5, Math.min(60, Math.round(value)));
}

export function getWorkerScriptPath(extensionOutDir: string): string {
  return path.join(extensionOutDir, "sidecar", "worker.js");
}

export function activateWithDependencies(
  context: ExtensionContextLike,
  dependencies: Dependencies
): void {
  const openCompatDisposable = dependencies.commands.registerCommand(
    COMPAT_COMMAND_ID,
    () => openReelsSidecar(dependencies)
  );
  const openNewDisposable = dependencies.commands.registerCommand(
    OPEN_SIDECAR_COMMAND_ID,
    () => openReelsSidecar(dependencies)
  );
  const installDisposable = dependencies.commands.registerCommand(
    INSTALL_RUNTIME_COMMAND_ID,
    () => installRuntimeCommand(dependencies)
  );
  const diagnosticsDisposable = dependencies.commands.registerCommand(
    RUN_DIAGNOSTICS_COMMAND_ID,
    () => runSidecarDiagnostics(dependencies)
  );
  const restartDisposable = dependencies.commands.registerCommand(
    RESTART_SIDECAR_COMMAND_ID,
    () => restartSidecar(dependencies)
  );

  context.subscriptions.push(
    openCompatDisposable,
    openNewDisposable,
    installDisposable,
    diagnosticsDisposable,
    restartDisposable
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isProfileInUseError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("processsingleton") ||
    lower.includes("profile is already in use") ||
    lower.includes("already in use by another instance of chromium")
  );
}

function sanitizeSidecarError(message: string): string {
  const first = message.split("\nCall log:")[0].split("\n")[0].trim();
  if (first.length <= 220) {
    return first;
  }
  return `${first.slice(0, 217)}...`;
}

async function incrementProfileLockEvents(state: MementoLike): Promise<number> {
  const current = state.get<number>(STATE_PROFILE_LOCK_EVENTS_KEY) ?? 0;
  const next = current + 1;
  await state.update(STATE_PROFILE_LOCK_EVENTS_KEY, next);
  return next;
}
