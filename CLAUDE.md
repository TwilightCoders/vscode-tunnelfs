# CLAUDE.md — TunnelMount

## What This Is

A VS Code extension that automatically mounts the remote filesystem in macOS Finder when connected via VS Code Remote Tunnels. It piggybacks on the existing tunnel infrastructure — no extra ports exposed to the internet, no separate authentication, no manual setup.

## The Problem

When using VS Code Remote Tunnels, you can edit files but you can't browse the remote filesystem natively in Finder. The built-in "Open with Finder" command runs on the remote host (useless). The "Download" option works but is manual and one-file-at-a-time. There's no way to drag files from the remote machine into local apps, preview images in Quick Look, or interact with the remote filesystem the way you'd interact with any network volume.

## Architecture

The extension has two halves that communicate through VS Code's built-in remote infrastructure.

### Remote Half (workspace extension)

- Runs inside the `code-server` process on the remote machine
- Starts a lightweight **WebDAV server** on a random high port (localhost only — not network-exposed)
- Serves the workspace folders (and optionally the user's home directory or other configured roots)
- Uses an in-process Node.js WebDAV library (`webdav-server` npm package) — no external dependencies like caddy or wsgidav
- The WebDAV server binds to `127.0.0.1` only; it's accessible exclusively through VS Code's port forwarding

### Local Half (UI extension)

- Runs in the VS Code desktop client on the local machine
- Receives the WebDAV port number from the remote half
- Uses `vscode.env.asExternalUri()` to forward the remote port through the active tunnel
- Mounts the forwarded WebDAV endpoint in Finder via `mount_webdav` or `open` command
- Provides a status bar indicator showing mount state
- Unmounts cleanly on disconnect via `umount` in `deactivate()`

### Communication Between Halves

Use VS Code's `vscode.commands.executeCommand` with the remote authority, or a shared output channel / global state to pass the port number from the workspace extension to the UI extension. Explore what's simplest — global state (`workspaceState` or `globalState`) may be the most straightforward.

## Activation Model

This extension must be completely inert when there is no tunnel connection.

```jsonc
// package.json — extensionKind declares both halves
{
  "extensionKind": ["ui", "workspace"],
  "activationEvents": [
    "onResolveRemoteAuthority:tunnel"
  ]
}
```

- The **workspace half** activates only when loaded into a remote extension host (which only exists during a remote connection). Guard with a check: if no remote, return early from `activate()`.
- The **UI half** activates only when `vscode.env.remoteName === 'tunnel'`. If not a tunnel session, return early.
- Both halves tear down in `deactivate()` — the remote half stops the WebDAV server, the local half unmounts the Finder volume.
- If VS Code is open locally with no remote connection, neither half loads.

## Key VS Code APIs

- `vscode.env.remoteName` — `'tunnel'` when connected via Remote Tunnels
- `vscode.env.asExternalUri(uri)` — forwards a remote port through the tunnel; returns a local URI
- `vscode.workspace.workspaceFolders` — the folders open in the remote workspace (roots to serve via WebDAV)
- `vscode.commands.registerCommand` — for manual mount/unmount/status commands
- `vscode.window.createStatusBarItem` — mount state indicator
- `vscode.Disposable` — everything should be disposable and pushed to `context.subscriptions`

## Platform

- **Local (client) side:** macOS only for now (Finder mount via `mount_webdav`). The extension should check `process.platform === 'darwin'` on the UI side and gracefully no-op on other platforms (or show a message suggesting alternatives).
- **Remote (server) side:** Platform-agnostic. The WebDAV server is pure Node.js.

## Project Structure

```
tunnelmount/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts          # Entry point — delegates to local or remote logic
│   ├── remote/
│   │   ├── webdavServer.ts   # WebDAV server setup and lifecycle
│   │   └── activate.ts       # Remote-side activation logic
│   └── local/
│       ├── mount.ts          # Finder mount/unmount via mount_webdav
│       └── activate.ts       # Local-side activation, port forwarding, status bar
├── .vscodeignore
└── README.md
```

## Development Notes

- Use TypeScript, strict mode
- Target ES2020, Node 18+ (VS Code's bundled Node)
- Bundle with esbuild for fast extension load times
- The extension name in the marketplace should be **TunnelMount** (open to renaming)
- Extension ID / publisher TBD

## Unknowns and Things to Investigate

1. **Two-extension-kind packaging:** Can a single extension reliably run code on both sides (`"extensionKind": ["ui", "workspace"]`)? The entry point needs to detect which side it's on and activate accordingly. Alternatively, this may need to be two separate extensions that depend on each other. Research this early.
2. **Port forwarding from extension code:** Confirm `asExternalUri` works for WebDAV (HTTP) traffic. It should — it's just HTTP over the tunnel — but verify.
3. **mount_webdav behavior:** Test whether macOS's built-in `mount_webdav` works with `http://localhost:<port>` or if it demands HTTPS. If HTTPS is required, we may need to use `mount -t webdav` directly or connect via Finder's "Connect to Server" dialog programmatically.
4. **Credential handling:** WebDAV servers often expect Basic Auth. Since this is localhost-only traffic forwarded through an already-authenticated tunnel, we can use a generated nonce/token per session and pass it to both sides. Don't skip auth entirely — other local processes shouldn't be able to access the mount trivially.
5. **Large directory performance:** WebDAV over a tunnel relay (WebSocket → Microsoft servers → WebSocket) will add latency. Test with large directories and see if it's usable. Consider caching PROPFIND responses.
6. **Cleanup on crash:** If VS Code crashes or the tunnel drops ungracefully, the Finder mount will go stale. The UI extension should check for and clean up stale mounts on next activation.

## Non-Goals (for now)

- Windows/Linux local client support (Finder-specific)
- Write-back support (start read-only; add write support once reads are solid)
- Syncing or offline access
- Supporting SSH or container remote connections (tunnel-only for now; could expand later)

## Commands to Register

- `tunnelmount.mount` — Manually mount remote filesystem in Finder
- `tunnelmount.unmount` — Manually unmount
- `tunnelmount.status` — Show current mount state and connection info
- `tunnelmount.revealInFinder` — Context menu action: reveal the selected remote file's mounted path in Finder