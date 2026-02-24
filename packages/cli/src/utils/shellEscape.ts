/**
 * Shell-escape a value for safe embedding in bash double-quoted strings.
 * Escapes: " \ $ ` ! \n \r
 *
 * `!` is escaped for defense-in-depth. Bash history expansion (where `!` is
 * special) only triggers in interactive shells, not in scripts. But escaping
 * it has zero cost and prevents surprises in edge cases.
 */
export function shellEscape(s: string): string {
  return s.replace(/["\\$`!\n\r]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    return "\\" + ch;
  });
}

/**
 * Reject values containing shell injection patterns.
 * Blocks: backticks, $(), ${}, semicolons, pipes, ampersands, redirects, parens, quotes, newlines.
 * Returns an error message or null if the value looks safe.
 */
export function validateShellValue(value: string): string | null {
  if (/[`"'|&><()]|\$[({]|;|\n|\r/.test(value)) {
    return "Value contains disallowed shell characters";
  }
  return null;
}
