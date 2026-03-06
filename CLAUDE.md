# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TunnelFS is a pair of VS Code extensions that mount the remote filesystem in macOS Finder when connected via VS Code Remote Tunnels. A WebDAV server on the remote serves files directly from disk; the local extension forwards the port through the tunnel and mounts it in Finder.

## Build Commands

```bash
# Remote extension
cd remote && npm run compile

# Local extension
cd local && npm run compile
```

Each package has `compile`, `watch`, and `package` scripts. CI builds both and attaches `.vsix` files to GitHub releases on version tags.

## Architecture

**Two extensions, one repo.** VS Code only runs one instance of an extension per window, so code on both sides requires two packages.

### `remote/` — TunnelFS Remote (`extensionKind: ["workspace"]`)

Runs on the remote host. Starts a read-only WebDAV server with direct `fs` access (no vscode.workspace.fs overhead).

- **`src/extension.ts`** — Reads `tunnelfs.root` setting (defaults to `os.homedir()`), starts server, forwards port via `vscode.env.asExternalUri`, registers `tunnelfs-remote.getInfo` command.
- **`src/server.ts`** — Minimal WebDAV server (Node `http`/`fs` modules). Handles OPTIONS/PROPFIND/GET/HEAD. Path traversal protection. Finder-compatible DAV XML responses.

### `local/` — TunnelFS (`extensionKind: ["ui"]`)

Runs on the local Mac. Queries the remote extension, mounts the forwarded WebDAV endpoint in Finder.

- **`src/extension.ts`** — Activates on tunnel connections. Calls `tunnelfs-remote.getInfo` (with retry) to get the forwarded URL. Mounts in Finder. Status bar indicator.
- **`src/mount.ts`** — `mount_webdav -S -v` with osascript fallback. Mount point under `/Volumes/<host - root>`. Stale mount cleanup.

### Cross-extension Communication

The remote extension registers command `tunnelfs-remote.getInfo` which returns `{ url, root }`. The local extension calls it via `vscode.commands.executeCommand`. Commands registered by workspace extensions are callable from the UI side.

## Extension Commands

| Command | Side | Description |
|---------|------|-------------|
| `tunnelfs-remote.getInfo` | Remote | Returns forwarded WebDAV URL and root path |
| `tunnelfs.mount` | Local | Mount remote filesystem in Finder |
| `tunnelfs.unmount` | Local | Unmount |
| `tunnelfs.status` | Local | Show mount state |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `tunnelfs.root` | `""` (home dir) | Root directory to serve via WebDAV |

## Key Constraints

- **macOS-only** local side. Extension no-ops on other platforms.
- **Read-only** — only GET/HEAD/PROPFIND. No write-back yet.
- **Tunnel-only** — local extension checks `vscode.env.remoteName === 'tunnel'`.
- TypeScript strict mode, ES2020 target, esbuild bundler, no runtime deps.
- Two `.vsix` files per release: `tunnelfs-remote` (install on remote) + `tunnelfs` (install on laptop).
