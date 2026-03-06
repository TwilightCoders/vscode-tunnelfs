import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const exec = promisify(execCb);

let currentMountPoint: string | undefined;

export function getMountPoint(): string | undefined {
  return currentMountPoint;
}

export async function mountVolume(url: string, volumeName: string): Promise<string> {
  const safeName = volumeName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const mountPoint = path.join(os.tmpdir(), `tunnelmount-${safeName}`);

  await fs.promises.mkdir(mountPoint, { recursive: true });

  try {
    // Prefer mount_webdav (standard macOS tool)
    await exec(`mount_webdav "${url}" "${mountPoint}"`, { timeout: 30000 });
    currentMountPoint = mountPoint;
    return mountPoint;
  } catch {
    // Fallback: Finder's "Connect to Server" via AppleScript
    try {
      await exec(
        `osascript -e 'tell application "Finder" to mount volume "${url}"'`,
        { timeout: 30000 },
      );

      // Find where Finder mounted it
      const found = await findMountByPort(url);
      if (found) {
        currentMountPoint = found;
        return found;
      }

      // If we can't find it, try the original mount point
      if (await isMountedAt(mountPoint)) {
        currentMountPoint = mountPoint;
        return mountPoint;
      }

      throw new Error('Mount appeared to succeed but mount point could not be determined');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to mount WebDAV volume: ${msg}`);
    }
  }
}

export async function unmountVolume(): Promise<void> {
  if (!currentMountPoint) return;

  try {
    await exec(`umount "${currentMountPoint}"`, { timeout: 10000 });
  } catch {
    try {
      await exec(`diskutil unmount force "${currentMountPoint}"`, { timeout: 10000 });
    } catch { /* best effort */ }
  }

  try {
    await fs.promises.rmdir(currentMountPoint);
  } catch { /* ignore */ }

  currentMountPoint = undefined;
}

export async function isMounted(): Promise<boolean> {
  if (!currentMountPoint) return false;
  return isMountedAt(currentMountPoint);
}

async function isMountedAt(mountPoint: string): Promise<boolean> {
  try {
    const { stdout } = await exec('mount');
    return stdout.includes(mountPoint);
  } catch {
    return false;
  }
}

async function findMountByPort(url: string): Promise<string | undefined> {
  const portMatch = url.match(/:(\d+)/);
  if (!portMatch) return undefined;

  try {
    const { stdout } = await exec('mount');
    const line = stdout.split('\n').find(l => l.includes(`localhost:${portMatch[1]}`));
    if (line) {
      const match = line.match(/on\s+(.+?)\s+\(/);
      if (match) return match[1];
    }
  } catch { /* ignore */ }

  return undefined;
}

export async function cleanStaleMounts(): Promise<void> {
  try {
    const { stdout } = await exec('mount');
    for (const line of stdout.split('\n')) {
      if (line.includes('tunnelmount-')) {
        const match = line.match(/on\s+(.+?)\s+\(/);
        if (match) {
          try {
            await exec(`umount "${match[1]}"`, { timeout: 5000 });
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
}

export async function revealInFinder(localPath: string): Promise<void> {
  await exec(`open -R "${localPath}"`);
}
