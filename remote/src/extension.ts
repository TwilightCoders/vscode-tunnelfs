import * as vscode from 'vscode';
import * as os from 'os';
import { WebDAVServer } from './server';

let server: WebDAVServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('tunnelfs');
  const rootDir = config.get<string>('root') || os.homedir();

  const log = vscode.window.createOutputChannel('TunnelFS Remote');
  context.subscriptions.push(log);

  server = new WebDAVServer(rootDir);
  const port = await server.start();
  log.appendLine(`WebDAV server started on 127.0.0.1:${port}, serving ${rootDir}`);

  // Forward the port through the tunnel so the local side can reach it
  const forwardedUri = await vscode.env.asExternalUri(
    vscode.Uri.parse(`http://localhost:${port}`),
  );

  let url = forwardedUri.toString();
  if (!url.endsWith('/')) url += '/';
  log.appendLine(`Forwarded to ${url}`);

  // Register command for the local extension to query
  context.subscriptions.push(
    vscode.commands.registerCommand('tunnelfs-remote.getInfo', () => ({
      url,
      root: rootDir,
    })),
  );
}

export async function deactivate(): Promise<void> {
  if (server) {
    await server.stop();
  }
}
