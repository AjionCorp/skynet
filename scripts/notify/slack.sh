#!/usr/bin/env bash
# notify/slack.sh — Slack notification channel plugin
# Sourced by _notify.sh. Implements notify_slack().

# Send a Slack message via incoming webhook. No-op if not configured.
notify_slack() {
  local msg="$1"
  [ -n "${SKYNET_SLACK_WEBHOOK_URL:-}" ] || return 0

  if ! curl -sf -X POST "$SKYNET_SLACK_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"text\": $(printf '%s' "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    > /dev/null 2>&1; then
    # Log failure with redacted webhook URL — never expose raw URL
    if declare -f _redact_for_log >/dev/null 2>&1; then
      log "Slack notify failed (webhook=$(_redact_for_log "$SKYNET_SLACK_WEBHOOK_URL"))"
    fi
  fi
}
