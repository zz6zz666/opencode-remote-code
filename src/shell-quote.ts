/**
 * Quote a string for safe use in a POSIX shell command.
 *
 * Safe rules:
 * - If the string contains only safe chars [a-zA-Z0-9_.\/\-], pass through unchanged.
 * - Otherwise wrap in single quotes, where NOTHING is interpreted by the shell.
 * - To embed a literal single quote, close the quote, add an escaped quote
 *   in double quotes, and reopen:  'it'"'"'s'  →  it's
 */
export function quoteShell(input: string): string {
  if (/^[a-zA-Z0-9_.\/\-]+$/.test(input)) {
    return input
  }
  return `'${input.replace(/'/g, "'\"'\"'")}'`
}
