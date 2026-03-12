import * as vscode from "vscode";
import {
  activateWithDependencies,
  OUTPUT_CHANNEL_NAME,
} from "./core";
import { RuntimeManager } from "./runtimeManager";
import { SidecarManager } from "./sidecarManager";

let sidecarManager: SidecarManager | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  const runtimeManager = new RuntimeManager(context, output);
  sidecarManager = new SidecarManager(context, output);
  context.subscriptions.push(sidecarManager);

  activateWithDependencies(context, {
    commands: vscode.commands,
    window: vscode.window,
    output,
    config: {
      get: <T>(section: string, key: string, defaultValue: T): T =>
        vscode.workspace.getConfiguration(section).get<T>(key, defaultValue),
    },
    state: context.globalState,
    runtimeManager,
    sidecarManager,
    now: () => Date.now(),
  });
}

export function deactivate(): void {
  sidecarManager?.dispose();
  sidecarManager = null;
}
