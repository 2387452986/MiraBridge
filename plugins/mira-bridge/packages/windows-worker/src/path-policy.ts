import { lstat, realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { BridgeError } from "../../protocol/src/index.js";

function rejectWindowsPath(value: string, absolute: boolean): void {
  if (value.includes("\0")) throw new BridgeError("INVALID_ARGUMENT", "Paths may not contain NUL bytes.");
  if (/^(?:\\\\|\\\?|\\\.)/.test(value)) throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "UNC and Windows device paths are not allowed.");
  if (value.split(/[\\/]+/).includes("..")) throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Parent path traversal is not allowed.");
  if (absolute && !/^[A-Za-z]:[\\/]/.test(value)) throw new BridgeError("INVALID_ARGUMENT", "An absolute Windows drive path is required.");
  if (!absolute && win32.isAbsolute(value)) throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Workspace paths must be relative.");
  const withoutDrive = absolute ? value.slice(2) : value;
  if (withoutDrive.includes(":")) throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "NTFS alternate data streams are not allowed.");
}

export function normalizeWindowsAbsolute(value: string): string {
  rejectWindowsPath(value, true);
  return win32.normalize(value);
}

export function normalizeWorkspaceRelative(value: string): string {
  rejectWindowsPath(value, false);
  const normalized = win32.normalize(value || ".");
  if (normalized === ".." || normalized.startsWith(`..${win32.sep}`)) {
    throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Workspace path escapes are not allowed.");
  }
  return normalized;
}

export function isWithinWindowsRoot(candidate: string, root: string): boolean {
  const relative = win32.relative(root.toLowerCase(), candidate.toLowerCase());
  return relative === "" || (!relative.startsWith("..") && !win32.isAbsolute(relative));
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = win32.dirname(current);
      if (parent === current) throw new BridgeError("PATH_NOT_FOUND", "No existing parent was found for the requested path.");
      current = parent;
    }
  }
}

export class PathPolicy {
  private constructor(readonly allowedRoots: string[]) {}

  static async create(configuredRoots: string[]): Promise<PathPolicy> {
    const roots: string[] = [];
    for (const configured of configuredRoots) {
      const normalized = normalizeWindowsAbsolute(configured);
      const canonical = await realpath(normalized).catch((error) => {
        throw new BridgeError("PATH_NOT_FOUND", `Allowed root does not exist: ${configured}`, { cause: error, details: { path: configured } });
      });
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) throw new BridgeError("INVALID_ARGUMENT", `Allowed root is not a directory: ${configured}`);
      roots.push(win32.normalize(canonical));
    }
    return new PathPolicy(roots);
  }

  private assertAllowed(canonical: string): void {
    if (!this.allowedRoots.some((root) => isWithinWindowsRoot(canonical, root))) {
      throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Requested path is outside the allowed roots.", { details: { path: canonical } });
    }
  }

  async openWorkspace(path: string): Promise<string> {
    const normalized = normalizeWindowsAbsolute(path);
    const canonical = win32.normalize(await realpath(normalized));
    this.assertAllowed(canonical);
    if (!(await stat(canonical)).isDirectory()) throw new BridgeError("INVALID_ARGUMENT", "Workspace path is not a directory.");
    return canonical;
  }

  async resolveAbsolute(path: string, mustExist: boolean): Promise<string> {
    const normalized = normalizeWindowsAbsolute(path);
    const existing = mustExist ? normalized : await nearestExisting(normalized);
    const canonicalExisting = win32.normalize(await realpath(existing));
    this.assertAllowed(canonicalExisting);
    if (mustExist) return canonicalExisting;
    return win32.join(canonicalExisting, win32.relative(existing, normalized));
  }

  async resolveWorkspace(workspaceRoot: string, relativePath: string, mustExist: boolean): Promise<string> {
    const relative = normalizeWorkspaceRelative(relativePath);
    const joined = win32.join(workspaceRoot, relative);
    const existing = mustExist ? joined : await nearestExisting(joined);
    const canonicalExisting = win32.normalize(await realpath(existing));
    if (!isWithinWindowsRoot(canonicalExisting, workspaceRoot)) {
      throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Requested path escapes the workspace through a link or junction.");
    }
    this.assertAllowed(canonicalExisting);
    if (mustExist) return canonicalExisting;
    return win32.join(canonicalExisting, win32.relative(existing, joined));
  }

  /**
   * Resolve an existing directory entry without following its final component.
   * This is intentionally limited to operations such as unlinking a junction:
   * the parent is canonicalized and checked, while the entry itself remains the
   * lexical object that the filesystem operation will remove.
   */
  async resolveWorkspaceEntry(workspaceRoot: string, relativePath: string): Promise<string> {
    const relative = normalizeWorkspaceRelative(relativePath);
    const joined = win32.join(workspaceRoot, relative);
    const parent = win32.dirname(joined);
    const canonicalParent = win32.normalize(await realpath(parent));
    if (!isWithinWindowsRoot(canonicalParent, workspaceRoot)) {
      throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Requested path escapes the workspace through a link or junction.");
    }
    this.assertAllowed(canonicalParent);
    const entry = win32.join(canonicalParent, win32.basename(joined));
    await lstat(entry);
    return entry;
  }
}
