import * as vscode from 'vscode';
import { WebDAVServer } from './server';
import { mountVolume, unmountVolume, isMounted, cleanStaleMounts, getMountPoint } from './mount';
import { exec } from 'child_process';

let server: WebDAVServer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel;

type StatusState = 'mounted' | 'disconnected' | 'connecting' | 'error';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const isTunnel = vscode.env.remoteName === 'tunnel';

  // Always register the force-activate command so it's available from the command palette
  context.subscriptions.push(
    vscode.commands.registerCommand('tunnelfs.forceActivate', () => bootstrap(context)),
  );

  if (!isTunnel) {
    return;
  }

  if (process.platform !== 'darwin') {
    vscode.window.showWarningMessage('TunnelFS currently supports macOS only.');
    return;
  }

  await bootstrap(context);
}

async function bootstrap(context: vscode.ExtensionContext): Promise<void> {
  if (outputChannel) {
    // Already bootstrapped
    await doMount();
    return;
  }

  if (process.platform !== 'darwin') {
    vscode.window.showWarningMessage('TunnelFS currently supports macOS only.');
    return;
  }

  outputChannel = vscode.window.createOutputChannel('TunnelFS');
  context.subscriptions.push(outputChannel);

  await cleanStaleMounts();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'tunnelfs.mount';
  updateStatusBar('disconnected');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('tunnelfs.mount', doMount),
    vscode.commands.registerCommand('tunnelfs.unmount', doUnmount),
    vscode.commands.registerCommand('tunnelfs.status', showStatus),
  );

  await doMount();
}

async function doMount(): Promise<void> {
  if (await isMounted()) {
    vscode.window.showInformationMessage('TunnelFS: Already mounted.');
    return;
  }

  try {
    updateStatusBar('connecting');

    if (!server) {
      server = new WebDAVServer(outputChannel);
    }
    const port = await server.start();

    // Auth disabled for now — server is localhost-only.
    // macOS mount_webdav and osascript don't handle Basic Auth in URLs well.
    const url = `http://localhost:${port}/`;
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name || 'remote';

    outputChannel.appendLine(`Mounting ${workspaceName} via WebDAV on port ${port}...`);

    const mountPoint = await mountVolume(url, workspaceName);

    updateStatusBar('mounted');
    outputChannel.appendLine(`Mounted at ${mountPoint}`);
    vscode.window.showInformationMessage(`TunnelFS: Mounted at ${mountPoint}`);

    exec(`open "${mountPoint}"`);
  } catch (err: unknown) {
    updateStatusBar('error');
    const msg = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`Mount failed: ${msg}`);
    vscode.window.showErrorMessage(`TunnelFS: Mount failed \u2014 ${msg}`);
  }
}

async function doUnmount(): Promise<void> {
  try {
    await unmountVolume();

    if (server) {
      await server.stop();
      server = undefined;
    }

    updateStatusBar('disconnected');
    vscode.window.showInformationMessage('TunnelFS: Unmounted.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`TunnelFS: Unmount failed \u2014 ${msg}`);
  }
}

function showStatus(): void {
  const mountPoint = getMountPoint();
  if (mountPoint && server) {
    vscode.window.showInformationMessage(
      `TunnelFS: Mounted at ${mountPoint} (port ${server.port})`,
    );
  } else {
    vscode.window.showInformationMessage('TunnelFS: Not mounted.');
  }
}

function updateStatusBar(state: StatusState): void {
  if (!statusBarItem) return;

  switch (state) {
    case 'mounted':
      statusBarItem.text = '$(folder-opened) TunnelFS';
      statusBarItem.tooltip = `Mounted at ${getMountPoint()}`;
      statusBarItem.command = 'tunnelfs.unmount';
      break;
    case 'connecting':
      statusBarItem.text = '$(sync~spin) TunnelFS';
      statusBarItem.tooltip = 'Connecting...';
      statusBarItem.command = undefined;
      break;
    case 'error':
      statusBarItem.text = '$(error) TunnelFS';
      statusBarItem.tooltip = 'Mount failed \u2014 click to retry';
      statusBarItem.command = 'tunnelfs.mount';
      break;
    case 'disconnected':
      statusBarItem.text = '$(plug) TunnelFS';
      statusBarItem.tooltip = 'Click to mount remote filesystem';
      statusBarItem.command = 'tunnelfs.mount';
      break;
  }
}

export async function deactivate(): Promise<void> {
  try {
    await unmountVolume();
  } catch { /* best effort on shutdown */ }

  if (server) {
    try {
      await server.stop();
    } catch { /* best effort */ }
  }
}
