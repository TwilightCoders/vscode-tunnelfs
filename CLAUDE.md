# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TunnelMount is a VS Code extension that mounts remote filesystems in macOS Finder when connected via VS Code Remote Tunnels. It runs a local WebDAV server backed by `vscode.workspace.fs`, which transparently proxies remote file operations through the existing tunnel — no remote-side component needed.

## Build Commands

```bash
npm run compile    # Bundle with esbuild → dist/extension.js
npm run watch      # Watch mode
npm run package    # Minified production bundle
```

To test: press F5 in VS Code to launch an Extension Development Host. The extension only activates during tunnel connections (`vscode.env.remoteName === 'tunnel'`).

## Architecture

**Single-side design:** The extension runs entirely on the UI (local) side. No remote extension host code.

1. **`src/extension.ts`** — Entry point. Guards activation behind tunnel + macOS checks. Registers commands, manages status bar, orchestrates mount lifecycle.

2. **`src/server.ts`** — Minimal WebDAV server (Node `http` module, no dependencies). Handles OPTIONS/PROPFIND/GET/HEAD. Backs all file operations with `vscode.workspace.fs` which transparently reads remote files through the tunnel. Generates Finder-compatible DAV XML responses. Session auth via random token + HTTP Basic Auth.

3. **`src/mount.ts`** — macOS mount/unmount via `mount_webdav` (fallback: osascript). Mount point in `$TMPDIR/tunnelmount-<name>`. Handles stale mount cleanup on activation.

### Path Resolution

- **Single workspace folder:** served directly at WebDAV root `/`
- **Multiple folders:** virtual root at `/` lists folders; each folder at `/<FolderName>/`

### Auth Model

Random 32-byte hex token generated per session. Required via HTTP Basic Auth (`tunnelmount:<token>`). Credentials embedded in the mount URL. Localhost-only server binding.

## Extension Commands

| Command | Description |
|---------|-------------|
| `tunnelmount.mount` | Mount remote filesystem in Finder |
| `tunnelmount.unmount` | Unmount |
| `tunnelmount.status` | Show mount state and port info |

## Key Constraints

- **macOS-only** client side (`process.platform === 'darwin'`). Extension no-ops elsewhere.
- **Read-only** — only GET/HEAD/PROPFIND. No write-back yet.
- **Tunnel-only** — checks `vscode.env.remoteName === 'tunnel'`. Inert for SSH/container remotes.
- TypeScript strict mode, ES2020 target, esbuild bundler, no runtime dependencies beyond Node builtins + vscode API.

## Open Questions

1. Does macOS `mount_webdav` work with `http://` or does it require HTTPS?
2. Performance of `vscode.workspace.fs` as a WebDAV backend for large directories.
3. Stale mount cleanup reliability after crashes.
