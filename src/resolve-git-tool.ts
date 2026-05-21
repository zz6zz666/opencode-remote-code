import { execSync } from "child_process"
import fs from "fs"
import path from "path"

let cachedGitDir: string | undefined

function findGitExeOnWindows(): string | undefined {
  if (cachedGitDir) return cachedGitDir
  try {
    const out = execSync("where git", { encoding: "utf-8", windowsHide: true })
    const candidates = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // Prefer the canonical Windows wrapper (Git\cmd\git.exe) over the
    // mingw64 internal binary, because its parent dir is a stable anchor.
    const canonical =
      candidates.find((p) => p.toLowerCase().includes("\\cmd\\git.exe")) ||
      candidates.find((p) => p.toLowerCase().includes("\\bin\\git.exe")) ||
      candidates[0]
    if (canonical && fs.existsSync(canonical)) {
      cachedGitDir = path.dirname(canonical)
      return cachedGitDir
    }
  } catch {
    // where git failed
  }
  return undefined
}

export function resolveGitTool(toolName: string): string {
  if (process.platform !== "win32") {
    return toolName
  }

  const gitDir = findGitExeOnWindows()
  if (!gitDir) {
    return toolName
  }

  // Git for Windows layout:
  //   C:\Program Files\Git\cmd\git.exe      <-- anchor
  //   C:\Program Files\Git\usr\bin\ssh.exe
  //   C:\Program Files\Git\mingw64\bin\sshpass.exe
  //   C:\Program Files\Git\usr\bin\rsync.exe
  const gitRoot = path.resolve(gitDir, "..")
  const searchDirs = [
    path.join(gitRoot, "usr", "bin"),
    path.join(gitRoot, "mingw64", "bin"),
  ]

  for (const dir of searchDirs) {
    const full = path.join(dir, `${toolName}.exe`)
    if (fs.existsSync(full)) {
      return full
    }
  }

  return toolName
}
