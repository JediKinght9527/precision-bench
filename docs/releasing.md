# Release checklist

Run this before publishing a GitHub release.

## Pre-release

```bash
uv sync --frozen --group dev
uv run --frozen pytest
uv run --frozen python -m compileall -q server tests
for file in web/*.js; do node --check "$file"; done
git diff --check
docker build -t precision-bench:local .
./service.sh restart
curl -fsS http://127.0.0.1:8787/api/health
```

## Content

- Update `pyproject.toml` version.
- Update `CHANGELOG.md` with the release date and user-visible changes.
- Refresh the product preview and screenshots if the UI changed.
- Verify the English and Chinese quickstart commands.
- Verify the demo does not use a real key or private endpoint.
- Confirm `.gitignore` excludes `data/*.db`, logs, `.shots/`, and local credentials.

## GitHub

- Create a tag using the version in `pyproject.toml`.
- Add release notes with the migration and compatibility notes.
- Link the English README, Chinese README, demo, security policy, and changelog.
- Confirm CI passed on the release commit.

No commit or push is performed by this checklist.
