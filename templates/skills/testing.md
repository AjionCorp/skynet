---
name: testing
description: Testing conventions for test and fix tasks
tags: TEST,FIX
---

## Testing Conventions

- Every bug fix must include a regression test proving the fix works
- Place test files adjacent to the code they test
- Use the project's existing test runner (check package.json scripts)
- Mock external dependencies -- tests must run without network access
- Test edge cases: empty inputs, missing fields, boundary values
- Name test files consistently with the project's existing convention
