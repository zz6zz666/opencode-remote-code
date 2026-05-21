import fs from "fs/promises"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { createTwoFilesPatch, diffLines } from "diff"
import type { PathMapper } from "../path-mapper.js"
import type { SyncEngine } from "../sync-engine.js"
import { readFileWithBom, joinBom, splitBom } from "../bom.js"
import { trimDiff } from "../diff-utils.js"

// ========================================================================
// Per-file edit locks
// ========================================================================
const fileLocks = new Map<string, Promise<void>>()

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath)
  const current = (async () => {
    if (previous) await previous
    return fn()
  })()
  fileLocks.set(filePath, current.then(() => {}, () => {}))
  try {
    return await current
  } finally {
    if (fileLocks.get(filePath) === current) {
      fileLocks.delete(filePath)
    }
  }
}

// ========================================================================
// Line ending helpers
// ========================================================================
function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

// ====================================================================
// Local processing layer — ported from OpenCode 1.15.6 edit.ts
// (removed Effect framework; replaced replaceAll to avoid $-meta bug)
// ====================================================================

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

function* simpleReplacer(_content: string, find: string): Generator<string> {
  yield find
}

function* lineTrimmedReplacer(content: string, find: string): Generator<string> {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false
        break
      }
    }
    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1
      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) matchEndIndex += 1
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      )
    }
  }
  return matrix[a.length][b.length]
}

function* blockAnchorReplacer(content: string, find: string): Generator<string> {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.length < 3) return
  if (searchLines[searchLines.length - 1] === "") searchLines.pop()
  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break
      }
    }
  }
  if (candidates.length === 0) return

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break
      }
    } else {
      similarity = 1.0
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) matchEndIndex += 1
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1
  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) matchEndIndex += 1
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

function* whitespaceNormalizedReplacer(content: string, find: string): Generator<string> {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) yield match[0]
          } catch {}
        }
      }
    }
  }
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) yield block.join("\n")
    }
  }
}

function* indentationFlexibleReplacer(content: string, find: string): Generator<string> {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text
    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }
  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) yield block
  }
}

function* escapeNormalizedReplacer(content: string, find: string): Generator<string> {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n": return "\n"
        case "t": return "\t"
        case "r": return "\r"
        case "'": return "'"
        case '"': return '"'
        case "`": return "`"
        case "\\": return "\\"
        case "\n": return "\n"
        case "$": return "$"
        default: return match
      }
    })
  }
  const unescapedFind = unescapeString(find)
  if (content.includes(unescapedFind)) yield unescapedFind
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (unescapeString(block) === unescapedFind) yield block
  }
}

function* multiOccurrenceReplacer(content: string, find: string): Generator<string> {
  let startIndex = 0
  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break
    yield find
    startIndex = index + find.length
  }
}

function* trimmedBoundaryReplacer(content: string, find: string): Generator<string> {
  const trimmedFind = find.trim()
  if (trimmedFind === find) return
  if (content.includes(trimmedFind)) yield trimmedFind
  const lines = content.split("\n")
  const findLines = find.split("\n")
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    if (block.trim() === trimmedFind) yield block
  }
}

function* contextAwareReplacer(content: string, find: string): Generator<string> {
  const findLines = find.split("\n")
  if (findLines.length < 3) return
  if (findLines[findLines.length - 1] === "") findLines.pop()
  const contentLines = content.split("\n")
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0
          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()
            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) matchingLines++
            }
          }
          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break
          }
        }
        break
      }
    }
  }
}

function replaceContent(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }
  if (oldString === "") {
    return newString
  }

  let notFound = true
  for (const replacer of [
    simpleReplacer,
    lineTrimmedReplacer,
    blockAnchorReplacer,
    whitespaceNormalizedReplacer,
    indentationFlexibleReplacer,
    escapeNormalizedReplacer,
    trimmedBoundaryReplacer,
    contextAwareReplacer,
    multiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        // Manual replacement to avoid String.replaceAll's $-meta-character semantics
        let result = content
        let idx = result.indexOf(search)
        while (idx !== -1) {
          result = result.substring(0, idx) + newString + result.substring(idx + search.length)
          idx = result.indexOf(search, idx + newString.length)
        }
        return result
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error(
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
  )
}

function countDiffStats(oldText: string, newText: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldText, newText)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

// ========================================================================
// Tool definition
// ========================================================================

export function createEditTool(pathMapper: PathMapper, syncEngine: SyncEngine) {
  return tool({
    description: `Make precise text replacements in a remote file.`,
    args: {
      filePath: tool.schema.string().describe("The absolute path to the file to modify"),
      oldString: tool.schema.string().describe("The text to replace"),
      newString: tool.schema.string().describe("The text to replace it with (must be different from oldString)"),
      replaceAll: tool.schema.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
    },
    async execute(args, ctx) {
      if (args.oldString === args.newString) {
        throw new Error("No changes to apply: oldString and newString are identical.")
      }

      let remotePath = path.posix.normalize(args.filePath)
      if (!path.posix.isAbsolute(remotePath)) {
        remotePath = path.posix.join(pathMapper.remoteRoot, remotePath)
      }
      if (!pathMapper.isWithinWorkspace(remotePath)) {
        await ctx.ask({
          permission: "edit",
          patterns: [remotePath],
          always: [remotePath],
          metadata: {},
        })
      }

      const localPath = pathMapper.toLocal(remotePath)

      return withFileLock(localPath, async () => {
        // Track, pull, edit, push
        await syncEngine.register(remotePath)
        await syncEngine.pullAll()

        let content = ""
        let bom = false
        let existed = false
        try {
          const existing = await readFileWithBom(fs, localPath)
          content = existing.text
          bom = existing.bom
          existed = true
        } catch {}

        if (!existed && args.oldString !== "") {
          throw new Error(`File ${remotePath} not found`)
        }

        const ending = detectLineEnding(content)
        const oldNorm = convertToLineEnding(normalizeLineEndings(args.oldString), ending)
        const newNorm = convertToLineEnding(normalizeLineEndings(args.newString), ending)

        const result = replaceContent(content, oldNorm, newNorm, args.replaceAll ?? false)

        // Build diff preview for permission request
        const diffPreview = generateDiffPreview(remotePath, content, result)
        await ctx.ask({
          permission: "edit",
          patterns: [remotePath],
          always: [remotePath],
          metadata: { diff: diffPreview },
        })

        const next = splitBom(result)
        const desiredBom = bom || next.bom
        await fs.writeFile(localPath, joinBom(result, desiredBom), "utf-8")
        await syncEngine.pushAll()

        const stats = countDiffStats(content, result)

        return {
          title: remotePath,
          output: `Edit applied successfully.`,
          metadata: {
            filepath: remotePath,
            additions: stats.additions,
            deletions: stats.deletions,
          },
        }
      })
    },
  })
}

function generateDiffPreview(filePath: string, oldText: string, newText: string): string {
  return trimDiff(createTwoFilesPatch(filePath, filePath, oldText, newText))
}
