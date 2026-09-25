## Summary

<!-- What changed and why. Link related issues: Fixes #123 -->

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation / UI copy
- [ ] Refactor / chore (no behavior change)

## Verification

- [ ] `uv run --frozen pytest` passes locally
- [ ] `uv run --frozen python -m compileall -q server tests` passes
- [ ] `for file in web/*.js; do node --check "$file"; done` passes (if web changed)
- [ ] `git diff --check` passes
- [ ] New/changed behavior has a test

## Notes

<!-- Screenshots for UI changes; metric-definition changes must state the new formula -->
