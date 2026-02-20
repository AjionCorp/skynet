# Current Task
## [TEST] Expand E2E CLI test suite with export/import round-trip and doctor --fix verification — in `tests/e2e/cli-commands.test.sh`, add 3 new test cases after the existing ones: (a) **Export/import round-trip**: run `skynet export --output /tmp/skynet-test-export.json`, verify JSON file exists and contains expected keys, then modify backlog.md (add a test line), run `skynet import /tmp/skynet-test-export.json --force`, verify backlog.md was restored to pre-modification state. (b) **Doctor --fix**: create a stale `.dev/worker-99.heartbeat` file with epoch 0, run `skynet doctor` and verify WARN for stale heartbeat, run `skynet doctor --fix` and verify the stale file was deleted, re-run `skynet doctor` and verify PASS. (c) **Config set/get round-trip**: run `skynet config set SKYNET_MAX_WORKERS 6`, then `skynet config get SKYNET_MAX_WORKERS` and verify output is "6", then restore original value. These are the last untested CLI workflows. Criterion #2 (comprehensive E2E coverage)
**Status:** completed
**Started:** 2026-02-20 01:05
**Completed:** 2026-02-20
**Branch:** dev/expand-e2e-cli-test-suite-with-exportimp
**Worker:** 4

### Changes
-- See git log for details
