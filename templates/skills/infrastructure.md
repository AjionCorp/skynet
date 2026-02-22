---
name: infrastructure
description: Infrastructure and DevOps conventions
tags: INFRA
---

## Infrastructure Conventions

- Shell scripts must be bash 3.2 compatible (macOS default)
- Use mkdir-based mutex locks for concurrency, not file-based checks
- Prefer atomic operations (write to temp file, then rename)
- Never hardcode absolute paths -- use config variables
- Log with timestamps using the log() function
- Always clean up resources (lock files, temp files) in EXIT traps
