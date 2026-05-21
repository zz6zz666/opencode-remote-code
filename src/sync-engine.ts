import fs from "fs/promises"
import path from "path"
import type { RemoteConfig } from "./config.js"
import type { ManifestManager } from "./manifest.js"
import type { PathMapper } from "./path-mapper.js"
import type { SSHPool } from "./ssh-pool.js"

export class SyncEngine {
  private mutex = Promise.resolve()

  constructor(
    _config: RemoteConfig,
    private pathMapper: PathMapper,
    private manifest: ManifestManager,
    private sshPool: SSHPool
  ) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = this.mutex
    let resolveRelease: () => void
    this.mutex = new Promise((resolve) => {
      resolveRelease = resolve
    })
    await release
    try {
      return await fn()
    } finally {
      resolveRelease!()
    }
  }

  /** Pull all tracked files from remote to local mirror */
  async pullAll(): Promise<void> {
    await this.withLock(async () => {
      const files = this.manifest.remotePaths()
      if (files.length === 0) return
      await this.runSftp("pull", files)
    })
  }

  /** Push all tracked files from local mirror to remote */
  async pushAll(): Promise<void> {
    await this.withLock(async () => {
      const files = this.manifest.remotePaths()
      if (files.length === 0) return
      await this.runSftp("push", files)
    })
  }

  /** Register a new remote file and ensure its parent directory exists locally */
  async register(remotePath: string): Promise<string> {
    const rel = this.manifest.register(remotePath)
    const localPath = this.pathMapper.toLocal(remotePath)
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await this.manifest.save()
    return rel
  }

  private async runSftp(direction: "pull" | "push", remotePaths: string[]): Promise<void> {
    await this.sshPool.withSftp(async (sftp) => {
      for (const rp of remotePaths) {
        const localPath = this.pathMapper.toLocal(rp)

        if (direction === "pull") {
          // Ensure local parent dir exists
          await fs.mkdir(path.dirname(localPath), { recursive: true }).catch(() => {})
          try {
            await sftpFastGet(sftp, rp, localPath)
          } catch (err) {
            // If remote file does not exist, create an empty local file
            // (handles "add file" patches where the file is new)
            const msg = (err as Error).message.toLowerCase()
            if (msg.includes("no such file") || msg.includes("not found")) {
              await fs.writeFile(localPath, "", "utf-8")
            } else {
              throw err
            }
          }
        } else {
          // Ensure remote parent dir exists
          const remoteDir = path.posix.dirname(rp)
          await this.sshPool.exec(`mkdir -p ${quoteShell(remoteDir)}`, { timeout: 10_000 }).catch(() => {})
          await sftpFastPut(sftp, localPath, rp)
        }
      }
    })
  }
}

function sftpFastGet(
  sftp: any,
  remotePath: string,
  localPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err: Error | undefined) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function sftpFastPut(
  sftp: any,
  localPath: string,
  remotePath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err: Error | undefined) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

import { quoteShell } from "./shell-quote.js"
