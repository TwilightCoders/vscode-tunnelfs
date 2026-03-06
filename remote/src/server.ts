import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

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

interface PropEntry {
  href: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  ctime: number;
  name: string;
}

export class WebDAVServer {
  private server: http.Server;
  private _port = 0;
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
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

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
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
      this.server.close(() => resolve());
    });
  }

  private resolvePath(rawUrl: string): string | null {
    const urlPath = decodeURIComponent(rawUrl.split('?')[0]);
    const resolved = path.resolve(this.rootDir, '.' + urlPath);
    // Prevent path traversal
    if (!resolved.startsWith(this.rootDir)) return null;
    return resolved;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    await new Promise<void>(r => { req.on('data', () => {}); req.on('end', r); });

    const filePath = this.resolvePath(req.url || '/');
    if (!filePath) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const depth = req.headers['depth'] === '0' ? 0 : 1;
    const rawPath = (req.url || '/').split('?')[0];

    try {
      const stat = await fs.promises.stat(filePath);
      const entries: PropEntry[] = [];
      const isDir = stat.isDirectory();
      const href = isDir && !rawPath.endsWith('/') ? rawPath + '/' : rawPath;

      entries.push({
        href,
        isDirectory: isDir,
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        name: path.basename(filePath) || '',
      });

      if (depth === 1 && isDir) {
        const dirents = await fs.promises.readdir(filePath, { withFileTypes: true });
        const basePath = href.endsWith('/') ? href : href + '/';

        for (const dirent of dirents) {
          try {
            const childPath = path.join(filePath, dirent.name);
            const childStat = await fs.promises.stat(childPath);
            entries.push({
              href: basePath + encodeURIComponent(dirent.name) + (dirent.isDirectory() ? '/' : ''),
              isDirectory: dirent.isDirectory(),
              size: childStat.size,
              mtime: childStat.mtimeMs,
              ctime: childStat.ctimeMs,
              name: dirent.name,
            });
          } catch { /* skip inaccessible */ }
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
    const filePath = this.resolvePath(req.url || '/');
    if (!filePath) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        res.writeHead(405);
        res.end('Cannot GET a directory');
        return;
      }

      const content = await fs.promises.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': getMimeType(path.basename(filePath)),
        'Content-Length': content.byteLength,
        'Last-Modified': httpDate(stat.mtimeMs),
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }

  private async handleHead(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const filePath = this.resolvePath(req.url || '/');
    if (!filePath) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      res.writeHead(200, {
        'Content-Type': stat.isDirectory() ? 'httpd/unix-directory' : getMimeType(path.basename(filePath)),
        'Content-Length': stat.size,
        'Last-Modified': httpDate(stat.mtimeMs),
      });
      res.end();
    } catch {
      res.writeHead(404);
      res.end();
    }
  }
}
