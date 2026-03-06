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
 * Blocks: backticks, $(), ${}, $VAR, positional/special params ($1, $?, $!, $@, $*, $#, $$, $-),
 * semicolons, pipes, ampersands, redirects, parens, hash, quotes, tabs, newlines.
 * Aligned with dashboard's validateUpdates regex in config.ts.
 * Returns an error message or null if the value looks safe.
 */
export function validateShellValue(value: string): string | null {
  if (/[`"'|&><()#]|\$[({a-zA-Z_0-9?!@*#$-]|;|\n|\r|\t/.test(value)) {
    return "Value contains disallowed shell characters";
  }
  return null;
}
