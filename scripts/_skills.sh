#!/usr/bin/env bash
# _skills.sh — Skill discovery and tag-filtered injection for worker prompts
# Sourced by _config.sh. Provides get_skills_for_tag() to all scripts.
#
# Skills are markdown files in $SKYNET_SKILLS_DIR (default: $DEV_DIR/skills/).
# Each skill has YAML frontmatter with optional `tags:` field.
# If tags are specified, the skill only loads for matching task tags.
# If tags are empty/absent, the skill loads for all tasks (universal).

export SKYNET_SKILLS_DIR="${SKYNET_SKILLS_DIR:-${DEV_DIR}/skills}"

# Parse the `tags:` field from a skill file's YAML frontmatter.
# Returns comma-separated tag list (uppercase), or empty string if none.
# Usage: _skill_tags "/path/to/skill.md"
_skill_tags() {
  local file="$1"
  local in_frontmatter=false
  while IFS= read -r line; do
    if [ "$line" = "---" ]; then
      if $in_frontmatter; then
        break
      fi
      in_frontmatter=true
      continue
    fi
    if $in_frontmatter; then
      case "$line" in
        tags:*|Tags:*|TAGS:*)
          local tag_val
          tag_val="${line#*:}"
          # Trim leading whitespace (bash 3.2 compatible)
          tag_val="$(echo "$tag_val" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
          if [ -n "$tag_val" ]; then
            echo "$tag_val" | tr '[:lower:]' '[:upper:]' | sed 's/ *, */,/g'
          fi
          return 0
          ;;
      esac
    fi
  done < "$file"
}

# Get the body content of a skill file (everything after the closing ---).
# If no frontmatter, returns the entire file.
# Usage: _skill_body "/path/to/skill.md"
_skill_body() {
  local file="$1"
  local past_frontmatter=false
  local found_first=false
  while IFS= read -r line; do
    if [ "$line" = "---" ]; then
      if $found_first; then
        past_frontmatter=true
        continue
      fi
      found_first=true
      continue
    fi
    if $past_frontmatter; then
      printf '%s\n' "$line"
    fi
  done < "$file"

  # If no frontmatter delimiters found, return entire file
  if ! $found_first; then
    cat "$file"
  fi
}

# Return concatenated skill content for a given task tag.
# Skills with no tags match everything. Skills with tags match only if
# the task tag appears in their comma-separated tag list.
# Usage: get_skills_for_tag "FEAT"
# Output: multi-line string with all matching skill bodies
get_skills_for_tag() {
  local task_tag="$1"
  task_tag="$(echo "$task_tag" | tr '[:lower:]' '[:upper:]')"
  local result=""

  [ -d "$SKYNET_SKILLS_DIR" ] || return 0

  local skill_file
  for skill_file in "$SKYNET_SKILLS_DIR"/*.md; do
    [ -f "$skill_file" ] || continue

    local skill_tags
    skill_tags="$(_skill_tags "$skill_file")"

    local match=false
    if [ -z "$skill_tags" ]; then
      match=true  # universal skill
    elif [ -n "$task_tag" ]; then
      # Check if task_tag appears in comma-separated list
      # Use case statement for bash 3.2 compatibility
      case ",$skill_tags," in
        *,"$task_tag",*) match=true ;;
      esac
    fi

    if $match; then
      local body
      body="$(_skill_body "$skill_file")"
      if [ -n "$body" ]; then
        if [ -n "$result" ]; then
          result="${result}

${body}"
        else
          result="$body"
        fi
      fi
    fi
  done

  if [ -n "$result" ]; then
    printf '%s\n' "$result"
  fi
}
