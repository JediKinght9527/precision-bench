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
uv build && uv run --with twine twine check dist/*
./service.sh restart
curl -fsS http://127.0.0.1:8787/api/health
```

Verify the built wheel actually runs, not just that it builds:

```bash
uv venv /tmp/pbcheck && uv pip install --python /tmp/pbcheck/bin/python dist/*.whl
/tmp/pbcheck/bin/precision-bench --port 8899   # then curl the health endpoint
```

## Content

- Update the version in `pyproject.toml`.
- Update `CHANGELOG.md` with the release date and user-visible changes.
- Refresh the screenshots under `docs/screenshots/` if the UI changed.
- Verify the English and Chinese quickstart commands.
- Verify the demo does not use a real key or private endpoint.
- Confirm `.gitignore` excludes `data/*.db`, logs, `.shots/`, `coverage.xml`, and local credentials.

## PyPI

The distribution name is `precision-bench` (the `llm-bench` name on PyPI belongs to another project). One-time setup on pypi.org:

1. Create the project `precision-bench` and the `pypi` environment.
2. Add a trusted publisher: repository `JediKinght9527/precision-bench`, workflow `publish.yml`, environment `pypi`.
3. No API token is needed with trusted publishing. To use a token instead, store it as the `PYPI_API_TOKEN` secret and swap the upload step for `pypa/gh-action-pypi-publish` with `password: ${{ secrets.PYPI_API_TOKEN }}`.

Then publish by creating a GitHub release — the `Publish` workflow builds, verifies metadata, test-uploads, and publishes. It also re-installs the package from PyPI to confirm the published artifact works.

Dry run without uploading:

```bash
gh workflow run publish.yml -f dry-run=true
```

After the first successful upload, add the PyPI badge to both READMEs:

```html
<img alt="pypi" src="https://img.shields.io/pypi/v/precision-bench?label=pypi">
```

## GitHub

- Create a tag matching the version in `pyproject.toml`.
- Add release notes with the migration and compatibility notes.
- Link the English README, Chinese README, screenshots, demo, security policy, and changelog.
- Confirm CI passed on the release commit.
