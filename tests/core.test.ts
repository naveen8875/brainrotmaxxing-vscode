import { strict as assert } from "assert";
import sinon from "sinon";
import {
  ACTION_INSTALL_RUNTIME,
  ACTION_OPEN_REPORT,
  ACTION_RESTART_SIDECAR,
  ACTION_RUN_DIAGNOSTICS,
  COMPAT_COMMAND_ID,
  INSTALL_RUNTIME_COMMAND_ID,
  OPEN_SIDECAR_COMMAND_ID,
  RESTART_SIDECAR_COMMAND_ID,
  RUN_DIAGNOSTICS_COMMAND_ID,
  STATE_LAST_DIAGNOSTICS_KEY,
  STATE_PROFILE_LOCK_EVENTS_KEY,
  STATE_RUNTIME_METADATA_KEY,
  activateWithDependencies,
  clampFps,
  evaluateSidecarRisk,
  getPostOpenWarning,
  installRuntimeCommand,
  openReelsSidecar,
  runSidecarDiagnostics,
} from "../src/core";

const NOW_MS = Date.parse("2026-03-12T00:00:00.000Z");

function createDependencies() {
  const store = new Map<string, unknown>();
  const showErrorMessage = sinon.stub().resolves(undefined);
  const showWarningMessage = sinon.stub().resolves(undefined);
  const showInformationMessage = sinon.stub().resolves(undefined);
  const registerCommand = sinon.stub().returns({ dispose: sinon.stub() });
  const clear = sinon.stub();
  const appendLine = sinon.stub();
  const show = sinon.stub();
  const getConfig = sinon.stub().callsFake((_: string, key: string, defaultValue: unknown) => {
    if (key === "stream.fpsCap") {
      return 30;
    }
    if (key === "profile.mode") {
      return "persistent";
    }
    if (key === "viewport.mode") {
      return "mobile";
    }
    if (key === "audio.enabled") {
      return true;
    }
    return defaultValue;
  });
  const getState = sinon
    .stub()
    .callsFake(<T>(key: string): T | undefined => store.get(key) as T | undefined);
  const updateState = sinon.stub().callsFake(async (key: string, value: unknown) => {
    store.set(key, value);
  });

  const getInstalledRuntime = sinon.stub().resolves(null);
  const installRuntime = sinon.stub().resolves({
    metadata: {
      source: "system-chrome",
      browserName: "chrome",
      browserVersion: "134.0.0.0",
      platform: "darwin",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      installedAt: new Date(NOW_MS).toISOString(),
    },
    installedNow: true,
  });
  const getProfileDir = sinon.stub().callsFake((mode: "persistent" | "ephemeral") => {
    if (mode === "ephemeral") {
      return "/tmp/profile-ephemeral";
    }
    return "/tmp/profile";
  });
  const checkProfileHealth = sinon.stub().resolves({ exists: true, writable: true });
  const checkRuntimeHealth = sinon
    .stub()
    .resolves({ executableExists: true, cacheDirExists: true });

  const openPanel = sinon.stub().resolves();
  const restart = sinon.stub().resolves();
  const resetSession = sinon.stub().resolves();
  const getStats = sinon.stub().returns({
    running: true,
    port: 7878,
    fps: 29,
    averageFrameLatencyMs: 45,
    droppedFrames: 3,
    transportConnectedClients: 1,
    lastFrameAt: new Date(NOW_MS).toISOString(),
    lastError: null,
    codecSupport: "supported",
    codecDetails: "{}",
  });

  const deps = {
    commands: { registerCommand },
    window: { showErrorMessage, showWarningMessage, showInformationMessage },
    output: { clear, appendLine, show },
    config: { get: getConfig },
    state: { get: getState, update: updateState },
    runtimeManager: {
      getInstalledRuntime,
      installRuntime,
      getProfileDir,
      checkProfileHealth,
      checkRuntimeHealth,
    },
    sidecarManager: { openPanel, restart, resetSession, getStats },
    now: () => NOW_MS,
  };

  return {
    deps,
    stubs: {
      store,
      showErrorMessage,
      showWarningMessage,
      showInformationMessage,
      registerCommand,
      clear,
      appendLine,
      show,
      getInstalledRuntime,
      installRuntime,
      getProfileDir,
      checkProfileHealth,
      checkRuntimeHealth,
      openPanel,
      restart,
      resetSession,
      getStats,
      updateState,
    },
  };
}

describe("BrainrotMaxxing core sidecar", () => {
  afterEach(() => sinon.restore());

  it("registers all commands during activation", () => {
    const { deps, stubs } = createDependencies();
    const context = { subscriptions: [] as Array<{ dispose(): void }> };

    activateWithDependencies(context, deps);

    assert.equal(stubs.registerCommand.callCount, 5);
    const ids = stubs.registerCommand.getCalls().map((c) => c.args[0]);
    assert.deepEqual(ids, [
      COMPAT_COMMAND_ID,
      OPEN_SIDECAR_COMMAND_ID,
      INSTALL_RUNTIME_COMMAND_ID,
      RUN_DIAGNOSTICS_COMMAND_ID,
      RESTART_SIDECAR_COMMAND_ID,
    ]);
    assert.equal(context.subscriptions.length, 5);
  });

  it("prompts runtime validation when browser runtime missing and opens after validation", async () => {
    const { deps, stubs } = createDependencies();
    stubs.showWarningMessage.resolves(ACTION_INSTALL_RUNTIME);

    await openReelsSidecar(deps);

    assert.equal(stubs.installRuntime.calledOnce, true);
    assert.equal(stubs.openPanel.calledOnce, true);
    assert.equal(stubs.updateState.calledWithMatch(STATE_RUNTIME_METADATA_KEY), true);
  });

  it("does not open panel when runtime missing and user skips validation", async () => {
    const { deps, stubs } = createDependencies();
    stubs.showWarningMessage.resolves(undefined);

    await openReelsSidecar(deps);

    assert.equal(stubs.installRuntime.notCalled, true);
    assert.equal(stubs.openPanel.notCalled, true);
  });

  it("uses installed runtime without revalidating", async () => {
    const { deps, stubs } = createDependencies();
    stubs.getInstalledRuntime.resolves({
      source: "system-chrome",
      browserName: "chrome",
      browserVersion: "134.0.0.0",
      platform: "darwin",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      installedAt: new Date(NOW_MS).toISOString(),
    });

    await openReelsSidecar(deps);

    assert.equal(stubs.installRuntime.notCalled, true);
    assert.equal(stubs.openPanel.calledOnce, true);
  });

  it("recovers from profile lock by resetting and retrying persistent profile first", async () => {
    const { deps, stubs } = createDependencies();
    stubs.getInstalledRuntime.resolves({
      source: "system-chrome",
      browserName: "chrome",
      browserVersion: "134.0.0.0",
      platform: "darwin",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      installedAt: new Date(NOW_MS).toISOString(),
    });
    stubs.store.set(STATE_LAST_DIAGNOSTICS_KEY, {
      generatedAt: new Date(NOW_MS).toISOString(),
      riskLevel: "low",
      runtimeInstalled: true,
      sidecarRunning: true,
      averageFrameLatencyMs: 15,
      droppedFrames: 0,
      codecSupport: "supported",
      profileLockEvents: 0,
    });
    stubs.openPanel
      .onFirstCall()
      .rejects(
        new Error(
          "Worker fatal: {\"message\":\"Failed to create a ProcessSingleton for your profile directory\"}"
        )
      )
      .onSecondCall()
      .resolves();

    await openReelsSidecar(deps);

    assert.equal(stubs.resetSession.calledOnce, true);
    assert.equal(stubs.openPanel.calledTwice, true);
    const secondProfile = stubs.openPanel.secondCall.args[0].profileDir;
    assert.equal(secondProfile, "/tmp/profile");
    assert.equal(
      stubs.store.get(STATE_PROFILE_LOCK_EVENTS_KEY),
      1
    );
  });

  it("falls back to recovery profile when lock persists after retry", async () => {
    const { deps, stubs } = createDependencies();
    stubs.getInstalledRuntime.resolves({
      source: "system-chrome",
      browserName: "chrome",
      browserVersion: "134.0.0.0",
      platform: "darwin",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      installedAt: new Date(NOW_MS).toISOString(),
    });
    stubs.openPanel
      .onFirstCall()
      .rejects(new Error("ProcessSingleton profile is already in use"))
      .onSecondCall()
      .rejects(new Error("already in use by another instance of Chromium"))
      .onThirdCall()
      .resolves();

    await openReelsSidecar(deps);

    assert.equal(stubs.openPanel.callCount, 3);
    const thirdProfile = stubs.openPanel.thirdCall.args[0].profileDir;
    assert.equal(String(thirdProfile).includes("recovery-"), true);
    assert.equal(stubs.store.get(STATE_PROFILE_LOCK_EVENTS_KEY), 2);
  });

  it("shows diagnostics action warning when snapshot is high risk", async () => {
    const { deps, stubs } = createDependencies();
    stubs.getInstalledRuntime.resolves({
      source: "system-chrome",
      browserName: "chrome",
      browserVersion: "134.0.0.0",
      platform: "darwin",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      installedAt: new Date(NOW_MS).toISOString(),
    });
    stubs.store.set(STATE_LAST_DIAGNOSTICS_KEY, {
      generatedAt: new Date(NOW_MS).toISOString(),
      riskLevel: "high",
      runtimeInstalled: true,
      sidecarRunning: true,
      averageFrameLatencyMs: 100,
      droppedFrames: 10,
      codecSupport: "supported",
      profileLockEvents: 0,
    });
    stubs.showWarningMessage.resolves(ACTION_RUN_DIAGNOSTICS);

    await openReelsSidecar(deps);

    assert.equal(stubs.showWarningMessage.calledOnce, true);
    assert.equal(stubs.showInformationMessage.calledOnce, true);
  });

  it("runtime validation command reports success", async () => {
    const { deps, stubs } = createDependencies();
    await installRuntimeCommand(deps);
    assert.equal(stubs.installRuntime.calledOnce, true);
    assert.equal(stubs.showInformationMessage.calledOnce, true);
  });

  it("run diagnostics writes output and persists snapshot", async () => {
    const { deps, stubs } = createDependencies();
    stubs.getInstalledRuntime.resolves({
      source: "system-chrome",
      browserName: "chrome",
      browserVersion: "134.0.0.0",
      platform: "darwin",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      installedAt: new Date(NOW_MS).toISOString(),
    });

    const result = await runSidecarDiagnostics(deps);

    assert.equal(result.riskLevel, "low");
    assert.equal(stubs.clear.calledOnce, true);
    assert.equal(stubs.appendLine.called, true);
    assert.equal(stubs.updateState.calledWithMatch(STATE_LAST_DIAGNOSTICS_KEY), true);
    assert.equal(stubs.show.called, true);
  });

  it("evaluates high risk when runtime and sidecar are down", () => {
    const evaluation = evaluateSidecarRisk({
      runtimeInstalled: false,
      runtimeMetadata: null,
      runtimeHealth: { executableExists: false, cacheDirExists: false },
      sidecar: {
        running: false,
        port: null,
        fps: null,
        averageFrameLatencyMs: null,
        droppedFrames: 0,
        transportConnectedClients: 0,
        lastFrameAt: null,
        lastError: null,
        codecSupport: "unsupported",
        codecDetails: null,
      },
      profileLockEvents: 0,
      profileHealth: { exists: false, writable: false },
      audio: { enabledSetting: true, status: "not_implemented" },
    });
    assert.equal(evaluation.riskLevel, "high");
  });

  it("supports open report action after diagnostics", async () => {
    const { deps, stubs } = createDependencies();
    stubs.showInformationMessage.resolves(ACTION_OPEN_REPORT);
    await runSidecarDiagnostics(deps);
    assert.equal(stubs.show.calledTwice, true);
  });

  it("clamps fps values to valid range", () => {
    assert.equal(clampFps(1), 5);
    assert.equal(clampFps(120), 60);
    assert.equal(clampFps(29.6), 30);
  });

  it("generates warnings for missing and stale snapshots", () => {
    assert.equal(getPostOpenWarning(undefined, NOW_MS) !== null, true);
    assert.equal(
      getPostOpenWarning(
        {
          generatedAt: "2020-01-01T00:00:00.000Z",
          riskLevel: "low",
          runtimeInstalled: true,
          sidecarRunning: true,
          averageFrameLatencyMs: 10,
          droppedFrames: 0,
          codecSupport: "supported",
          profileLockEvents: 0,
        },
        NOW_MS
      ) !== null,
      true
    );
    assert.equal(
      getPostOpenWarning(
        {
          generatedAt: new Date(NOW_MS).toISOString(),
          riskLevel: "low",
          runtimeInstalled: true,
          sidecarRunning: true,
          averageFrameLatencyMs: 10,
          droppedFrames: 0,
          codecSupport: "supported",
          profileLockEvents: 0,
        },
        NOW_MS
      ),
      null
    );
  });

  it("offers restart action constant for post-open warnings", () => {
    assert.equal(typeof ACTION_RESTART_SIDECAR, "string");
  });
});
