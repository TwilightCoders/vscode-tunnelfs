import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const exec = promisify(execCb);

let currentMountPoint: string | undefined;

export function getMountPoint(): string | undefined {
  return currentMountPoint;
}

export async function mountVolume(url: string, volumeName: string): Promise<string> {
  const safeName = volumeName.replace(/[^a-zA-Z0-9_ -]/g, '_');
  const mountPoint = path.join('/Volumes', safeName);

  // Clean up stale mount point from a previous crash
  try {
    const stat = await fs.promises.stat(mountPoint);
    if (stat.isDirectory()) {
      if (await isMountedAt(mountPoint)) {
        await exec(`umount "${mountPoint}"`, { timeout: 5000 });
      }
      await fs.promises.rmdir(mountPoint);
    }
  } catch { /* doesn't exist, fine */ }

  await fs.promises.mkdir(mountPoint, { recursive: true });
  const errors: string[] = [];

  // Strategy 1: mount_webdav with -S (suppress UI) and -v (volume name for Finder)
  try {
    await exec(`mount_webdav -S -v "${safeName}" "${url}" "${mountPoint}"`, { timeout: 30000 });
    currentMountPoint = mountPoint;
    return mountPoint;
  } catch (err: unknown) {
    errors.push(`mount_webdav: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Strategy 2: Finder's "Connect to Server" via AppleScript
  try {
    await exec(
      `osascript -e 'mount volume "${url}"'`,
      { timeout: 30000 },
    );
    await new Promise(r => setTimeout(r, 1000));

    const found = await findMountByUrl(url);
    if (found) {
      currentMountPoint = found;
      return found;
    }
  } catch (err: unknown) {
    errors.push(`osascript: ${err instanceof Error ? err.message : String(err)}`);
  }

  try { await fs.promises.rmdir(mountPoint); } catch { /* ignore */ }
  throw new Error(`Failed to mount WebDAV volume:\n${errors.join('\n')}`);
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

async function findMountByUrl(url: string): Promise<string | undefined> {
  const portMatch = url.match(/:(\d+)/);
  if (!portMatch) return undefined;

  try {
    const { stdout } = await exec('mount');
    const line = stdout.split('\n').find((l: string) => l.includes(`localhost:${portMatch[1]}`));
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
      if (line.includes('tunnelfs-') || line.includes('webdav') && line.includes('/Volumes/')) {
        // Only clean up mounts that look like ours
        const match = line.match(/on\s+(\/Volumes\/[^\s]+)\s+\(/);
        if (match) {
          try {
            await exec(`umount "${match[1]}"`, { timeout: 5000 });
          } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
}
