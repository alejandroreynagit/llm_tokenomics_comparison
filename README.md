# Tokenwise

A local developer workspace for comparing LLM responses, latency, and estimated credit usage. Python/FastAPI backend with a plain HTML, CSS, and JavaScript frontend.

## Run

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

Open http://127.0.0.1:8000. API reference: http://127.0.0.1:8000/api/docs.

## Providers

Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `GOOGLE_API_KEY` in the server environment before starting the server. Do not put credentials in frontend files. Only configured providers can make live requests; an unavailable provider produces an individual error without blocking the other results. A configured key does not guarantee access to the listed models. The catalog is in `app.py` and model availability should be verified with each provider.

Demo mode works without keys. It uses **fixed caching examples**, approximate token counts, and simulated latency. It does not generate answers to custom prompts or establish which real model is better. The first screen loads a sample without saving a run. Explicit comparisons are saved to SQLite in `data/experiments.db`; the Experiments view can reopen and clear them. JSON exports include prompts, outputs, settings, and estimates, never server keys.

## Decisions and credits

- Cost = `(input tokens * input rate + output tokens * output rate) / 1,000,000`.
- Rates are editable estimates in USD per million tokens, not live price quotes. Rate cards persist in browser storage. Cached input discounts, tools, tiers, and provider surcharges are not modeled.
- One workspace credit defaults to $0.01; its value is editable. This is a conversion convention, not a provider-specific balance.
- Only complete, nonempty responses passing selected JSON and required-term checks are ranked. No LLM quality judge is used. Correctness, usefulness, security, and factual accuracy need human review.
- Balanced score: `100 * (0.7 * cheapest eligible cost / model cost + 0.3 * fastest eligible latency / model latency)`. Cost and speed modes use only the corresponding term. Zero-cost rate cards receive a cost score of 100.
- Latency is wall-clock time for a full provider response, not time to first token. Compare multiple live runs before making production decisions.
- Live costs use provider-reported tokens where available. Gemini thinking tokens are included in output usage. Fallback counts use a UTF-8 byte heuristic, explicitly labeled as estimates.
- The budget guard estimates a batch using approximate input tokens and the maximum output allowance. It blocks obviously over-budget batches before any calls. It is **not a hard billing cap**; use provider-side limits for that.

## Tests

```sh
.venv/bin/python -m unittest test_app -v
```

## Deployment Boundary

This app intentionally binds to localhost. There is no authentication or multi-tenant isolation, and stored prompts and outputs are not encrypted. Do not expose it publicly as-is. A shared deployment needs authentication, per-user credential isolation, rate limiting, retention controls, and provider billing limits.

Frontend dependencies (Lucide icons, Marked, and DOMPurify) are vendored in `static/`. The sidebar visualization is rendered locally from model output rates. DM Sans and IBM Plex Mono load from Google Fonts. Markdown output is sanitized and cannot embed images or forms.