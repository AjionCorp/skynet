#!/usr/bin/env bash
# tests/unit/skills.test.sh — Unit tests for scripts/_skills.sh skill dispatch
#
# Tests _skill_tags(), _skill_body(), and get_skills_for_tag() for correct
# tag parsing, body extraction, and tag-filtered dispatch.
#
# Usage: bash tests/unit/skills.test.sh

# NOTE: -e is intentionally omitted — the test uses its own PASS/FAIL counters
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

log()  { printf "  %s\n" "$*"; }
pass() { PASS=$((PASS + 1)); printf "  \033[32m✓\033[0m %s\n" "$*"; }
fail() { FAIL=$((FAIL + 1)); printf "  \033[31m✗\033[0m %s\n" "$*"; }

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$msg"
  else
    fail "$msg (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass "$msg"
  else
    fail "$msg (expected to contain '$needle')"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail "$msg (should NOT contain '$needle')"
  else
    pass "$msg"
  fi
}

assert_empty() {
  local val="$1" msg="$2"
  if [ -z "$val" ]; then
    pass "$msg"
  else
    fail "$msg (expected empty, got '$val')"
  fi
}

assert_not_empty() {
  local val="$1" msg="$2"
  if [ -n "$val" ]; then
    pass "$msg"
  else
    fail "$msg (was empty)"
  fi
}

# ── Setup: create isolated environment ──────────────────────────────

TMPDIR_ROOT=$(mktemp -d)
cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

export DEV_DIR="$TMPDIR_ROOT/.dev"
export SKYNET_SKILLS_DIR="$TMPDIR_ROOT/.dev/skills"
mkdir -p "$SKYNET_SKILLS_DIR"

source "$REPO_ROOT/scripts/_skills.sh"

# ── Helper: create skill files in the temp skills dir ───────────────

create_skill() {
  local name="$1" content="$2"
  printf '%s\n' "$content" > "$SKYNET_SKILLS_DIR/$name"
}

# ── _skill_tags() tests ────────────────────────────────────────────

echo ""
log "=== _skill_tags: Parse tags from frontmatter ==="

create_skill "tagged.md" "---
name: tagged
tags: FEAT,TEST
---
Body here"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/tagged.md")
assert_eq "$result" "FEAT,TEST" "_skill_tags: parses comma-separated tags"

# ── Tags with lowercase ──

echo ""
log "=== _skill_tags: Lowercase tags normalized to uppercase ==="

create_skill "lower.md" "---
tags: feat, bugfix
---
Body"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/lower.md")
assert_eq "$result" "FEAT,BUGFIX" "_skill_tags: lowercase tags uppercased"

# ── Empty tags field (universal skill) ──

echo ""
log "=== _skill_tags: Empty tags field ==="

create_skill "universal.md" "---
name: universal
tags:
---
Universal body"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/universal.md")
assert_empty "$result" "_skill_tags: empty tags returns empty string"

# ── No frontmatter at all ──

echo ""
log "=== _skill_tags: No frontmatter ==="

create_skill "no-front.md" "Just plain content
no frontmatter here"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/no-front.md")
assert_empty "$result" "_skill_tags: no frontmatter returns empty string"

# ── Case-insensitive field name: Tags: ──

echo ""
log "=== _skill_tags: Case-insensitive field name ==="

create_skill "title-tags.md" "---
Tags: INFRA, DEVOPS
---
Body"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/title-tags.md")
assert_eq "$result" "INFRA,DEVOPS" "_skill_tags: 'Tags:' field parsed"

create_skill "upper-tags.md" "---
TAGS: FIX
---
Body"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/upper-tags.md")
assert_eq "$result" "FIX" "_skill_tags: 'TAGS:' field parsed"

# ── Single tag ──

echo ""
log "=== _skill_tags: Single tag ==="

create_skill "single-tag.md" "---
tags: TEST
---
Body"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/single-tag.md")
assert_eq "$result" "TEST" "_skill_tags: single tag parsed correctly"

# ── Tags with extra whitespace ──

echo ""
log "=== _skill_tags: Tags with extra whitespace ==="

create_skill "spaced.md" "---
tags:   FEAT ,  TEST ,  FIX
---
Body"

result=$(_skill_tags "$SKYNET_SKILLS_DIR/spaced.md")
assert_eq "$result" "FEAT,TEST,FIX" "_skill_tags: whitespace around tags trimmed"

# ── _skill_body() tests ────────────────────────────────────────────

echo ""
log "=== _skill_body: Extract body after frontmatter ==="

create_skill "body-test.md" "---
name: test
tags: FEAT
---
## Guidelines
- Rule one
- Rule two"

result=$(_skill_body "$SKYNET_SKILLS_DIR/body-test.md")
assert_contains "$result" "## Guidelines" "_skill_body: body contains markdown heading"
assert_contains "$result" "Rule one" "_skill_body: body contains first rule"
assert_contains "$result" "Rule two" "_skill_body: body contains second rule"
assert_not_contains "$result" "tags:" "_skill_body: body does not contain frontmatter"
assert_not_contains "$result" "---" "_skill_body: body does not contain frontmatter delimiters"

# ── Body with no frontmatter returns entire file ──

echo ""
log "=== _skill_body: No frontmatter returns entire file ==="

create_skill "plain.md" "This is plain content
with multiple lines
no frontmatter"

result=$(_skill_body "$SKYNET_SKILLS_DIR/plain.md")
assert_contains "$result" "This is plain content" "_skill_body: returns first line of plain file"
assert_contains "$result" "no frontmatter" "_skill_body: returns last line of plain file"

# ── Empty body after frontmatter ──

echo ""
log "=== _skill_body: Empty body after frontmatter ==="

create_skill "empty-body.md" "---
tags: TEST
---"

result=$(_skill_body "$SKYNET_SKILLS_DIR/empty-body.md")
assert_empty "$result" "_skill_body: empty body returns empty string"

# ── get_skills_for_tag() tests ─────────────────────────────────────

echo ""
log "=== get_skills_for_tag: Setup fresh skills directory ==="

# Clear skills dir and create a known set of skills
rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "universal.md" "---
name: universal
tags:
---
Universal guidelines apply to all tasks."

create_skill "feat-skill.md" "---
name: feat-skill
tags: FEAT
---
Feature development guidelines."

create_skill "test-skill.md" "---
name: test-skill
tags: TEST, FIX
---
Testing and fix guidelines."

create_skill "infra-skill.md" "---
name: infra-skill
tags: INFRA
---
Infrastructure guidelines."

pass "setup: created 4 skill files (1 universal, 3 tagged)"

# ── Universal skills match any tag ──

echo ""
log "=== get_skills_for_tag: Universal skills included for any tag ==="

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "Universal guidelines" "universal: included for FEAT"

result=$(get_skills_for_tag "INFRA")
assert_contains "$result" "Universal guidelines" "universal: included for INFRA"

result=$(get_skills_for_tag "RANDOM")
assert_contains "$result" "Universal guidelines" "universal: included for unknown tag"

# ── Tagged skill matches correct tag ──

echo ""
log "=== get_skills_for_tag: Tagged skills match correct tag ==="

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "Feature development guidelines" "tag match: FEAT skill included for FEAT"

result=$(get_skills_for_tag "TEST")
assert_contains "$result" "Testing and fix guidelines" "tag match: TEST skill included for TEST"

result=$(get_skills_for_tag "FIX")
assert_contains "$result" "Testing and fix guidelines" "tag match: TEST,FIX skill included for FIX"

result=$(get_skills_for_tag "INFRA")
assert_contains "$result" "Infrastructure guidelines" "tag match: INFRA skill included for INFRA"

# ── Tagged skill does NOT match wrong tag ──

echo ""
log "=== get_skills_for_tag: Tagged skills excluded for wrong tag ==="

result=$(get_skills_for_tag "FEAT")
assert_not_contains "$result" "Infrastructure guidelines" "tag mismatch: INFRA skill excluded for FEAT"
assert_not_contains "$result" "Testing and fix" "tag mismatch: TEST skill excluded for FEAT"

result=$(get_skills_for_tag "TEST")
assert_not_contains "$result" "Feature development" "tag mismatch: FEAT skill excluded for TEST"
assert_not_contains "$result" "Infrastructure" "tag mismatch: INFRA skill excluded for TEST"

# ── Case-insensitive tag matching ──

echo ""
log "=== get_skills_for_tag: Case-insensitive tag matching ==="

result=$(get_skills_for_tag "feat")
assert_contains "$result" "Feature development guidelines" "case: lowercase 'feat' matches FEAT skill"

result=$(get_skills_for_tag "Feat")
assert_contains "$result" "Feature development guidelines" "case: mixed-case 'Feat' matches FEAT skill"

result=$(get_skills_for_tag "test")
assert_contains "$result" "Testing and fix guidelines" "case: lowercase 'test' matches TEST skill"

# ── Multiple skills concatenated with blank line separator ──

echo ""
log "=== get_skills_for_tag: Multiple skills concatenated ==="

result=$(get_skills_for_tag "FEAT")
# Should have both universal + feat skill
assert_contains "$result" "Universal guidelines" "concat: universal skill present"
assert_contains "$result" "Feature development" "concat: feat skill present"

# Verify they're separated by blank line
line_count=$(printf '%s\n' "$result" | wc -l | tr -d ' ')
if [ "$line_count" -gt 2 ]; then
  pass "concat: result has multiple lines (skills separated)"
else
  fail "concat: expected multi-line result with separated skills (got $line_count lines)"
fi

# ── Empty tag returns only universal skills ──

echo ""
log "=== get_skills_for_tag: Empty tag returns only universal skills ==="

result=$(get_skills_for_tag "")
assert_contains "$result" "Universal guidelines" "empty tag: universal skill included"
assert_not_contains "$result" "Feature development" "empty tag: FEAT skill excluded"
assert_not_contains "$result" "Testing and fix" "empty tag: TEST skill excluded"
assert_not_contains "$result" "Infrastructure" "empty tag: INFRA skill excluded"

# ── Missing skills directory returns empty ──

echo ""
log "=== get_skills_for_tag: Missing skills directory ==="

saved_dir="$SKYNET_SKILLS_DIR"
export SKYNET_SKILLS_DIR="$TMPDIR_ROOT/nonexistent-dir"

result=$(get_skills_for_tag "FEAT")
assert_empty "$result" "missing dir: returns empty when skills dir doesn't exist"

export SKYNET_SKILLS_DIR="$saved_dir"

# ── Empty skills directory (no .md files) ──

echo ""
log "=== get_skills_for_tag: Empty skills directory ==="

empty_dir="$TMPDIR_ROOT/empty-skills"
mkdir -p "$empty_dir"
saved_dir="$SKYNET_SKILLS_DIR"
export SKYNET_SKILLS_DIR="$empty_dir"

result=$(get_skills_for_tag "FEAT")
assert_empty "$result" "empty dir: returns empty when no .md files exist"

export SKYNET_SKILLS_DIR="$saved_dir"

# ── _LOADED_SKILLS reset between calls ──

echo ""
log "=== get_skills_for_tag: _LOADED_SKILLS resets between calls ==="

result1=$(get_skills_for_tag "FEAT")
result2=$(get_skills_for_tag "FEAT")
assert_eq "$result1" "$result2" "reset: consecutive calls return same result"

# ── Skill with no body (only frontmatter) is skipped ──

echo ""
log "=== get_skills_for_tag: Skill with empty body is skipped ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "empty-body.md" "---
tags: FEAT
---"

create_skill "has-body.md" "---
tags: FEAT
---
Real content here."

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "Real content here" "empty body: skill with body included"
assert_not_contains "$result" "---" "empty body: no frontmatter leaked"

# ── Skill file with no tags line in frontmatter is universal ──

echo ""
log "=== get_skills_for_tag: No tags line in frontmatter = universal ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "no-tags-line.md" "---
name: no-tags
description: Has frontmatter but no tags line
---
No tags line content."

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "No tags line content" "no tags line: treated as universal"

result=$(get_skills_for_tag "INFRA")
assert_contains "$result" "No tags line content" "no tags line: matches any tag"

# ── Skill without frontmatter is universal ──

echo ""
log "=== get_skills_for_tag: No frontmatter = universal ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "plain.md" "Just plain markdown content.
No frontmatter at all."

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "Just plain markdown" "no frontmatter: treated as universal for FEAT"

result=$(get_skills_for_tag "TEST")
assert_contains "$result" "Just plain markdown" "no frontmatter: treated as universal for TEST"

# ── Only .md files are processed ──

echo ""
log "=== get_skills_for_tag: Only .md files processed ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md
rm -f "$SKYNET_SKILLS_DIR"/*.txt

create_skill "valid.md" "---
tags:
---
Valid skill."

echo "Not a skill" > "$SKYNET_SKILLS_DIR/ignored.txt"

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "Valid skill" "md only: .md file included"
assert_not_contains "$result" "Not a skill" "md only: .txt file ignored"

rm -f "$SKYNET_SKILLS_DIR/ignored.txt"

# ── Tag substring does not false-match ──

echo ""
log "=== get_skills_for_tag: Tag substring does not false-match ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "testing-skill.md" "---
tags: TEST
---
Testing skill body."

# "TES" is a substring of "TEST" but should NOT match
result=$(get_skills_for_tag "TES")
assert_not_contains "$result" "Testing skill body" "substring: 'TES' does not match 'TEST'"

# "TESTING" is a superstring of "TEST" but should NOT match
result=$(get_skills_for_tag "TESTING")
assert_not_contains "$result" "Testing skill body" "superstring: 'TESTING' does not match 'TEST'"

# "TEST" exactly should match
result=$(get_skills_for_tag "TEST")
assert_contains "$result" "Testing skill body" "exact match: 'TEST' matches 'TEST'"

# ── Multi-tag skill matched by any of its tags ──

echo ""
log "=== get_skills_for_tag: Multi-tag skill matched by any tag ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "multi-tag.md" "---
tags: FEAT, TEST, FIX
---
Multi-tag body."

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "Multi-tag body" "multi-tag: matched by FEAT"

result=$(get_skills_for_tag "TEST")
assert_contains "$result" "Multi-tag body" "multi-tag: matched by TEST"

result=$(get_skills_for_tag "FIX")
assert_contains "$result" "Multi-tag body" "multi-tag: matched by FIX"

result=$(get_skills_for_tag "INFRA")
assert_not_contains "$result" "Multi-tag body" "multi-tag: not matched by INFRA"

# ── Skills returned in filesystem order ──

echo ""
log "=== get_skills_for_tag: Multiple matching skills combined ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "aaa-first.md" "---
tags: FEAT
---
First skill."

create_skill "bbb-second.md" "---
tags: FEAT
---
Second skill."

create_skill "ccc-third.md" "---
tags: FEAT
---
Third skill."

result=$(get_skills_for_tag "FEAT")
assert_contains "$result" "First skill" "combine: first skill present"
assert_contains "$result" "Second skill" "combine: second skill present"
assert_contains "$result" "Third skill" "combine: third skill present"

# ── Body preserves markdown formatting ──

echo ""
log "=== _skill_body: Preserves markdown formatting ==="

rm -f "$SKYNET_SKILLS_DIR"/*.md

create_skill "formatted.md" "---
tags: FEAT
---
# Heading

- bullet one
- bullet two

\`\`\`bash
echo hello
\`\`\`"

result=$(_skill_body "$SKYNET_SKILLS_DIR/formatted.md")
assert_contains "$result" "# Heading" "formatting: heading preserved"
assert_contains "$result" "- bullet one" "formatting: bullets preserved"
assert_contains "$result" 'echo hello' "formatting: code block preserved"

# ── Frontmatter with extra fields (non-tags) ──

echo ""
log "=== _skill_tags: Extra frontmatter fields ignored ==="

create_skill "extra-fields.md" "---
name: extra
description: Has extra fields
version: 1.0
tags: FEAT
author: test
---
Extra fields body."

result=$(_skill_tags "$SKYNET_SKILLS_DIR/extra-fields.md")
assert_eq "$result" "FEAT" "extra fields: tags still parsed correctly"

result=$(_skill_body "$SKYNET_SKILLS_DIR/extra-fields.md")
assert_contains "$result" "Extra fields body" "extra fields: body extracted correctly"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
TOTAL=$((PASS + FAIL))
log "Results: $PASS/$TOTAL passed, $FAIL failed"
if [ "$FAIL" -eq 0 ]; then
  printf "  \033[32mAll checks passed!\033[0m\n"
else
  printf "  \033[31mSome checks failed!\033[0m\n"
  exit 1
fi
