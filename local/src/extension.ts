import * as vscode from 'vscode';
import { mountVolume, unmountVolume, isMounted, cleanStaleMounts, getMountPoint } from './mount';
import { exec } from 'child_process';

interface RemoteInfo {
  url: string;
  root: string;
}

let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel;

type StatusState = 'mounted' | 'disconnected' | 'connecting' | 'error';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.env.remoteName !== 'tunnel') {
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

async function getRemoteInfo(): Promise<RemoteInfo> {
  // The remote extension may still be starting — retry a few times
  for (let i = 0; i < 10; i++) {
    try {
      const info = await vscode.commands.executeCommand<RemoteInfo>('tunnelfs-remote.getInfo');
      if (info?.url) return info;
    } catch { /* command not registered yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(
    'TunnelFS Remote extension not responding. Is it installed on the remote host?',
  );
}

async function doMount(): Promise<void> {
  if (await isMounted()) {
    vscode.window.showInformationMessage('TunnelFS: Already mounted.');
    return;
  }

  try {
    updateStatusBar('connecting');

    outputChannel.appendLine('Querying remote extension for WebDAV info...');
    const info = await getRemoteInfo();
    outputChannel.appendLine(`Remote URL: ${info.url}, root: ${info.root}`);

    // Build volume name from remote host + root directory
    const remoteAuthority: string = (vscode.env as Record<string, unknown>).remoteAuthority as string || '';
    const hostName = remoteAuthority.replace(/^tunnel\+/, '').replace(/\+.*$/, '') || 'remote';
    const rootName = info.root.split('/').filter(Boolean).pop() || 'root';
    const volumeName = `${hostName} - ${rootName}`;

    outputChannel.appendLine(`Mounting as "${volumeName}"...`);
    const mountPoint = await mountVolume(info.url, volumeName);

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
    updateStatusBar('disconnected');
    vscode.window.showInformationMessage('TunnelFS: Unmounted.');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`TunnelFS: Unmount failed \u2014 ${msg}`);
  }
}

function showStatus(): void {
  const mountPoint = getMountPoint();
  if (mountPoint) {
    vscode.window.showInformationMessage(`TunnelFS: Mounted at ${mountPoint}`);
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
  } catch { /* best effort */ }
}
