import { posix } from 'node:path';
import { unzipSync } from 'fflate';

/*
 * Packages people upload or install from a link: themes now, worlds and the catalog later
 * (#128, #129). Everything here works on the package's bytes in memory and never writes a file
 * from it, so a link in the ZIP can only ever become a plain file holding the link's text.
 */

export class PackageError extends Error {
  constructor(
    /** Stable code the app translates: `not-zip`, `too-large`, `too-many-files`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PackageLimits {
  /** Largest total size of all files, unpacked. */
  maxBytes: number;
  maxFiles: number;
}

/** A package's files by their path inside it, `/`-separated, without a leading folder. */
export type PackageFiles = Map<string, Uint8Array>;

/**
 * Unpacks a ZIP into memory. Leaves out folders, `.git`, macOS metadata, and any path that is
 * absolute or climbs out of the package. When every file sits in one top folder (a zipped
 * folder), that folder is dropped, so `my-theme/theme.css` becomes `theme.css`.
 */
export function readZip(bytes: Uint8Array, limits: PackageLimits): PackageFiles {
  let declared = 0;
  let count = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith('/') || !safePath(file.name)) return false;
        count++;
        declared += file.originalSize;
        if (count > limits.maxFiles) {
          throw new PackageError('too-many-files', `More than ${limits.maxFiles} files`);
        }
        // Checked before unpacking, against what the ZIP claims; checked again below against
        // what came out, in case the claim was false.
        if (declared > limits.maxBytes) throw tooLarge(limits);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof PackageError) throw err;
    throw new PackageError('not-zip', 'The file is not a ZIP archive');
  }
  let total = 0;
  const files: PackageFiles = new Map();
  for (const [name, data] of Object.entries(raw)) {
    total += data.byteLength;
    if (total > limits.maxBytes) throw tooLarge(limits);
    files.set(posix.normalize(name.replaceAll('\\', '/')), data);
  }
  return stripTopFolder(files);
}

const tooLarge = (limits: PackageLimits) =>
  new PackageError('too-large', `Larger than ${Math.round(limits.maxBytes / 1e6)} MB unpacked`);

/** Whether a path from a package stays inside it and is worth keeping. */
export function safePath(name: string): boolean {
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0')) return false;
  const parts = posix.normalize(path).split('/');
  if (parts.includes('..') || parts[0] === '') return false;
  // A Git folder's hooks would run on this server; macOS adds its own metadata to ZIPs.
  return !parts.some((p) => p === '.git' || p === '__MACOSX' || p === '.DS_Store');
}

function stripTopFolder(files: PackageFiles): PackageFiles {
  const tops = new Set([...files.keys()].map((name) => name.split('/')[0]));
  const [top] = tops;
  if (tops.size !== 1 || top === undefined || files.has(top)) return files;
  return new Map([...files].map(([name, data]) => [name.slice(top.length + 1), data]));
}
