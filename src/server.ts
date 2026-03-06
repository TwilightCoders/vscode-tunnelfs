import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.xml': 'application/xml', '.zip': 'application/zip', '.ts': 'text/plain',
  '.py': 'text/plain', '.rb': 'text/plain', '.go': 'text/plain',
  '.rs': 'text/plain', '.sh': 'text/plain', '.yaml': 'text/yaml',
  '.yml': 'text/yaml', '.toml': 'text/plain',
};

function getMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_TYPES[filename.substring(dot).toLowerCase()] || 'application/octet-stream';
}

function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface ResolvedPath {
  uri: vscode.Uri;
  name: string;
  isVirtualRoot: boolean;
}

interface PropEntry {
  href: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  ctime: number;
  name: string;
}

export class WebDAVServer implements vscode.Disposable {
  private server: http.Server;
  private _port = 0;
  private readonly token: string;
  private readonly log: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.log = outputChannel;
    this.token = crypto.randomBytes(32).toString('hex');
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        this.log.appendLine(`Error handling ${req.method} ${req.url}: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });
  }

  get port(): number {
    return this._port;
  }

  get credentials(): { username: string; password: string } {
    return { username: 'tunnelmount', password: this.token };
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
          this.log.appendLine(`WebDAV server listening on 127.0.0.1:${this._port}`);
          resolve(this._port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => {
        this.log.appendLine('WebDAV server stopped');
        resolve();
      });
    });
  }

  dispose(): void {
    this.stop();
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) return false;
    return decoded.substring(0, colonIdx) === 'tunnelmount' &&
           decoded.substring(colonIdx + 1) === this.token;
  }

  private resolvePath(rawUrl: string): ResolvedPath | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return null;

    const urlPath = decodeURIComponent(rawUrl.split('?')[0]);
    const segments = urlPath.split('/').filter(Boolean);

    if (folders.length === 1) {
      const folder = folders[0];
      if (segments.length === 0) {
        return { uri: folder.uri, name: folder.name, isVirtualRoot: false };
      }
      return {
        uri: vscode.Uri.joinPath(folder.uri, ...segments),
        name: segments[segments.length - 1],
        isVirtualRoot: false,
      };
    }

    // Multiple workspace folders: virtual root lists them
    if (segments.length === 0) {
      return { uri: folders[0].uri, name: '', isVirtualRoot: true };
    }

    const folder = folders.find(f => f.name === segments[0]);
    if (!folder) return null;

    if (segments.length === 1) {
      return { uri: folder.uri, name: folder.name, isVirtualRoot: false };
    }

    return {
      uri: vscode.Uri.joinPath(folder.uri, ...segments.slice(1)),
      name: segments[segments.length - 1],
      isVirtualRoot: false,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.log.appendLine(`${req.method} ${req.url}`);

    if (!this.checkAuth(req)) {
      res.setHeader('WWW-Authenticate', 'Basic realm="TunnelMount"');
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    switch (req.method?.toUpperCase()) {
      case 'OPTIONS': return this.handleOptions(res);
      case 'PROPFIND': return this.handlePropfind(req, res);
      case 'GET': return this.handleGet(req, res);
      case 'HEAD': return this.handleHead(req, res);
      default:
        res.writeHead(405, { 'Allow': 'OPTIONS, PROPFIND, GET, HEAD' });
        res.end('Method Not Allowed');
    }
  }

  private handleOptions(res: http.ServerResponse): void {
    res.writeHead(200, {
      'DAV': '1',
      'Allow': 'OPTIONS, PROPFIND, GET, HEAD',
      'Content-Length': '0',
    });
    res.end();
  }

  private async handlePropfind(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Drain request body (Finder sends XML we ignore — we return all properties)
    await new Promise<void>(r => { req.on('data', () => {}); req.on('end', r); });

    const resolved = this.resolvePath(req.url || '/');
    if (!resolved) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const depth = req.headers['depth'] === '0' ? 0 : 1;
    const rawPath = (req.url || '/').split('?')[0];

    try {
      const entries: PropEntry[] = [];

      if (resolved.isVirtualRoot) {
        const href = rawPath.endsWith('/') ? rawPath : rawPath + '/';
        entries.push({
          href,
          isDirectory: true,
          size: 0,
          mtime: Date.now(),
          ctime: Date.now(),
          name: '',
        });

        if (depth === 1) {
          for (const folder of vscode.workspace.workspaceFolders || []) {
            try {
              const stat = await vscode.workspace.fs.stat(folder.uri);
              entries.push({
                href: href + encodeURIComponent(folder.name) + '/',
                isDirectory: true,
                size: stat.size,
                mtime: stat.mtime,
                ctime: stat.ctime,
                name: folder.name,
              });
            } catch { /* skip inaccessible */ }
          }
        }
      } else {
        const stat = await vscode.workspace.fs.stat(resolved.uri);
        const isDir = (stat.type & vscode.FileType.Directory) !== 0;
        const href = isDir && !rawPath.endsWith('/') ? rawPath + '/' : rawPath;

        entries.push({
          href,
          isDirectory: isDir,
          size: stat.size,
          mtime: stat.mtime,
          ctime: stat.ctime,
          name: resolved.name,
        });

        if (depth === 1 && isDir) {
          const children = await vscode.workspace.fs.readDirectory(resolved.uri);
          const basePath = href.endsWith('/') ? href : href + '/';

          for (const [name, type] of children) {
            try {
              const childUri = vscode.Uri.joinPath(resolved.uri, name);
              const childStat = await vscode.workspace.fs.stat(childUri);
              const childIsDir = (type & vscode.FileType.Directory) !== 0;
              entries.push({
                href: basePath + encodeURIComponent(name) + (childIsDir ? '/' : ''),
                isDirectory: childIsDir,
                size: childStat.size,
                mtime: childStat.mtime,
                ctime: childStat.ctime,
                name,
              });
            } catch { /* skip */ }
          }
        }
      }

      const xml = this.buildMultistatus(entries);
      res.writeHead(207, {
        'Content-Type': 'application/xml; charset=utf-8',
        'DAV': '1',
      });
      res.end(xml);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private buildMultistatus(entries: PropEntry[]): string {
    let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
    xml += '<D:multistatus xmlns:D="DAV:">\n';

    for (const entry of entries) {
      xml += '  <D:response>\n';
      xml += `    <D:href>${escapeXml(entry.href)}</D:href>\n`;
      xml += '    <D:propstat>\n';
      xml += '      <D:prop>\n';

      if (entry.isDirectory) {
        xml += '        <D:resourcetype><D:collection/></D:resourcetype>\n';
      } else {
        xml += '        <D:resourcetype/>\n';
        xml += `        <D:getcontentlength>${entry.size}</D:getcontentlength>\n`;
        xml += `        <D:getcontenttype>${escapeXml(getMimeType(entry.name))}</D:getcontenttype>\n`;
      }

      xml += `        <D:getlastmodified>${httpDate(entry.mtime)}</D:getlastmodified>\n`;
      xml += `        <D:creationdate>${new Date(entry.ctime).toISOString()}</D:creationdate>\n`;
      xml += `        <D:displayname>${escapeXml(entry.name)}</D:displayname>\n`;
      xml += '      </D:prop>\n';
      xml += '      <D:status>HTTP/1.1 200 OK</D:status>\n';
      xml += '    </D:propstat>\n';
      xml += '  </D:response>\n';
    }

    xml += '</D:multistatus>\n';
    return xml;
  }

  private async handleGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const resolved = this.resolvePath(req.url || '/');
    if (!resolved || resolved.isVirtualRoot) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    try {
      const stat = await vscode.workspace.fs.stat(resolved.uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        res.writeHead(405);
        res.end('Cannot GET a directory');
        return;
      }

      const content = await vscode.workspace.fs.readFile(resolved.uri);
      res.writeHead(200, {
        'Content-Type': getMimeType(resolved.name),
        'Content-Length': content.byteLength,
        'Last-Modified': httpDate(stat.mtime),
      });
      res.end(Buffer.from(content));
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private async handleHead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const resolved = this.resolvePath(req.url || '/');
    if (!resolved || resolved.isVirtualRoot) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const stat = await vscode.workspace.fs.stat(resolved.uri);
      const isDir = (stat.type & vscode.FileType.Directory) !== 0;
      res.writeHead(200, {
        'Content-Type': isDir ? 'httpd/unix-directory' : getMimeType(resolved.name),
        'Content-Length': stat.size,
        'Last-Modified': httpDate(stat.mtime),
      });
      res.end();
    } catch {
      res.writeHead(404);
      res.end();
    }
  }
}
