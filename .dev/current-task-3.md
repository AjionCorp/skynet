# Current Task
## [FIX] Fix lint:sh glob to include scripts/notify/*.sh — in root `package.json`, update the `lint:sh` script from `"shellcheck -S warning scripts/*.sh scripts/agents/*.sh"` to `"shellcheck -S warning scripts/*.sh scripts/agents/*.sh scripts/notify/*.sh"`. The 3 notification channel plugins (telegram.sh, slack.sh, discord.sh) are currently not shellchecked, meaning syntax errors or unsafe patterns could slip into the notification system undetected
**Status:** completed
**Started:** 2026-02-19 17:16
**Completed:** 2026-02-19
**Branch:** dev/fix-lintsh-glob-to-include-scriptsnotify
**Worker:** 3

### Changes
-- See git log for details
