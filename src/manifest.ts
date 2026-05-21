import fs from "fs/promises"
import path from "path"
import type { PathMapper } from "./path-mapper.js"

export interface Manifest {
  remote_root: string
  files: Record<string, string>
}

export class ManifestManager {
  private manifest: Manifest
  private path: string
  private dirty = false

  constructor(pathMapper: PathMapper) {
    this.path = pathMapper.manifestPath()
    this.manifest = {
      remote_root: pathMapper.remoteRoot,
      files: {},
    }
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.path, "utf-8")
      const parsed = JSON.parse(data) as Manifest
      if (parsed.remote_root && typeof parsed.files === "object") {
        this.manifest = parsed
      }
    } catch {
      // Manifest doesn't exist yet; start empty
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    await fs.mkdir(path.dirname(this.path), { recursive: true })
    await fs.writeFile(this.path, JSON.stringify(this.manifest, null, 2), "utf-8")
    this.dirty = false
  }

  /** Register a remote file path. Returns its local relative path. */
  register(remotePath: string): string {
    if (this.manifest.files[remotePath]) {
      return this.manifest.files[remotePath]
    }
    const normalized = path.posix.normalize(remotePath)
    let rel: string
    if (
      normalized === this.manifest.remote_root ||
      normalized.startsWith(this.manifest.remote_root + "/")
    ) {
      rel = path.posix.relative(this.manifest.remote_root, normalized)
    } else {
      // Path outside remote_root: use full absolute path (strip leading /)
      rel = normalized.replace(/^\//, "")
    }
    this.manifest.files[remotePath] = rel
    this.dirty = true
    return rel
  }

  /** Check if a remote path is already tracked. */
  has(remotePath: string): boolean {
    return remotePath in this.manifest.files
  }

  /** Get all tracked remote paths. */
  remotePaths(): string[] {
    return Object.keys(this.manifest.files)
  }

  /** Get the relative local path for a tracked remote path. */
  getRel(remotePath: string): string | undefined {
    return this.manifest.files[remotePath]
  }

  /** Remove a tracked path. */
  remove(remotePath: string): void {
    if (remotePath in this.manifest.files) {
      delete this.manifest.files[remotePath]
      this.dirty = true
    }
  }
}
