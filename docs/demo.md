# Demo: verify a relay channel in five minutes

This demo uses the local mock upstream, so it does not spend tokens or require a real API key.

## 1. Start the mock upstream

```bash
./run_mock.sh
```

## 2. Start LLM Bench

```bash
./run.sh
```

Open `http://127.0.0.1:8787`.

## 3. Run a baseline

Paste:

```text
base_url: http://127.0.0.1:8899
api_key: demo
model: gpt-4o
```

Keep the default closed-loop profile, set **Total requests** to `20`, and start the run.

## 4. Verify Prompt Cache

Open **Cache detection**, choose a provider-compatible prefix length, and run the check. The first round is the write round; later rounds are compared by TTFT and reported cached tokens.

## 5. Generate the verification report

Click **生成验真报告** above the performance summary. The report combines the current performance run with the latest matching cache and quality records, then exports as Markdown.
