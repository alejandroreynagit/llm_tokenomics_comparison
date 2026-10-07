import asyncio
import json
import math
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from typing import Literal


ROOT = Path(__file__).parent
DB_PATH = ROOT / "data" / "experiments.db"
MODELS = [
    {"id": "gpt-4.1-mini", "name": "GPT-4.1 mini", "provider": "OpenAI", "input": 0.40, "output": 1.60, "tag": "Efficient", "color": "green"},
    {"id": "gpt-4.1", "name": "GPT-4.1", "provider": "OpenAI", "input": 2.00, "output": 8.00, "tag": "Capable", "color": "green"},
    {"id": "gpt-4.1-nano", "name": "GPT-4.1 nano", "provider": "OpenAI", "input": 0.10, "output": 0.40, "tag": "Lightweight", "color": "green"},
    {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "provider": "Anthropic", "input": 3.00, "output": 15.00, "tag": "Capable", "color": "orange"},
    {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku", "provider": "Anthropic", "input": 0.80, "output": 4.00, "tag": "Efficient", "color": "orange"},
    {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "provider": "Google", "input": 0.30, "output": 2.50, "tag": "Efficient", "color": "blue"},
]
KEY_NAMES = {"OpenAI": "OPENAI_API_KEY", "Anthropic": "ANTHROPIC_API_KEY", "Google": "GOOGLE_API_KEY"}
app = FastAPI(title="Tokenwise", docs_url="/api/docs", redoc_url=None)


class Rate(BaseModel):
    input: float = Field(ge=0, le=1000, allow_inf_nan=False)
    output: float = Field(ge=0, le=1000, allow_inf_nan=False)


class Experiment(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    system: str = Field(default="You are a helpful, precise assistant.", max_length=5000)
    models: list[str] = Field(min_length=2, max_length=4)
    mode: Literal["demo", "live"] = "demo"
    objective: Literal["balanced", "cost", "speed"] = "balanced"
    temperature: float = Field(default=0.7, ge=0, le=2, allow_inf_nan=False)
    max_tokens: int = Field(default=512, ge=64, le=4096)
    budget: float = Field(default=1, ge=0.00001, le=1000, allow_inf_nan=False)
    credit_value: float = Field(default=0.01, gt=0, le=1000, allow_inf_nan=False)
    format: Literal["text", "json"] = "text"
    keywords: list[str] = Field(default_factory=list, max_length=10)
    rates: dict[str, Rate] = Field(default_factory=dict)

    
def estimate_tokens(text):
    """
    Estimate the number of tokens in the given text based on its UTF-8 byte length.

    Each token is approximately 3 bytes in UTF-8 encoding.
    Calculate the number of tokens by dividing the byte length by 3 and rounding up.
    Ensure that at least one token is returned.

    Args:
        text (str): The input text to estimate tokens for.

    Returns:
        int: The estimated number of tokens.
    """
    return max(1, math.ceil(len(text.encode("utf-8")) / 3))


def calculate_cost(input_tokens, output_tokens, rate):
    return (input_tokens * rate["input"] + output_tokens * rate["output"]) / 1_000_000


def output_checks(text, request, complete=True):
    checks = [{"name": "Complete response", "passed": bool(text.strip()) and complete}]
    if request.format == "json":
        try:
            json.loads(text)
            valid = True
        except (ValueError, TypeError):
            valid = False
        checks.append({"name": "Valid JSON", "passed": valid})
    for keyword in request.keywords:
        if keyword.strip():
            checks.append({"name": f'Contains "{keyword[:80]}"', "passed": keyword.casefold() in text.casefold()})
    return checks


def recommendation(results, objective, budget):
    eligible = [result for result in results if not result.get("error") and all(check["passed"] for check in result["checks"])]
    if not eligible:
        return {"winner": None, "reason": "No completed response passed every selected check. Review the outputs or adjust your checks before choosing a model.", "savings": 0, "runs": 0}
    min_cost = min(result["cost"] for result in eligible)
    min_latency = min(result["latency"] for result in eligible)
    for result in eligible:
        cost_score = min_cost / result["cost"] if result["cost"] else 1
        speed_score = min_latency / max(result["latency"], 0.001)
        result["score"] = round(100 * (cost_score if objective == "cost" else speed_score if objective == "speed" else 0.7 * cost_score + 0.3 * speed_score), 1)
    winner = max(eligible, key=lambda result: result["score"])
    most_expensive = max(result["cost"] for result in eligible)
    savings = 100 * (1 - winner["cost"] / most_expensive) if most_expensive else 0
    reasons = {"cost": "the lowest estimated cost", "speed": "the lowest measured response time", "balanced": "the best 70% cost / 30% speed score"}
    return {"winner": winner["id"], "reason": f'{winner["name"]} has {reasons[objective]} among responses that passed all checks. Checks verify completion and your constraints, not factual correctness or code quality.', "savings": round(savings, 1), "runs": math.floor(budget / winner["cost"]) if winner["cost"] else None}


def demo_response(model, request):
    if request.format == "json":
        text = json.dumps({"mode": "demo", "model": model["name"], "summary": "A reusable response cache avoids duplicate LLM requests.", "steps": ["Normalize the prompt and parameters", "Hash the model, prompt, and settings", "Read from cache before requesting a completion", "Set a TTL and track cache hits"], "keywords": request.keywords}, indent=2)
    else:
        text = "## A practical response cache\n\nCache identical requests before calling your LLM provider. Use a stable key that includes the model, prompt, and generation settings.\n\n```python\nimport hashlib\nimport json\n\ndef cache_key(model, prompt, settings):\n    payload = json.dumps(\n        [model, prompt, settings], sort_keys=True\n    )\n    return hashlib.sha256(payload.encode()).hexdigest()\n```\n\n1. Check Redis for the cache key.\n2. On a miss, call the provider and store the response.\n3. Set a TTL and measure the cache-hit rate.\n\nAvoid caching sensitive data without an explicit retention policy."
        if model["provider"] == "Anthropic":
            text += "\n\nFor production, add request coalescing so concurrent cache misses don't trigger duplicate calls. Use tenant-scoped keys and invalidate entries when your system prompt changes."
        elif model["provider"] == "Google":
            text += "\n\nStart with a 1-hour TTL. Track tokens avoided alongside latency, and bypass the cache for requests that need fresh data."
        if request.keywords:
            text += "\n\nRequested terms: " + ", ".join(request.keywords)
    input_tokens = estimate_tokens(request.system + request.prompt)
    token_count = estimate_tokens(text)
    complete = token_count <= request.max_tokens
    if not complete:
        text = text[:request.max_tokens * 3]
    demo_latency = {"OpenAI": 1.24, "Anthropic": 2.18, "Google": 0.86}[model["provider"]]
    return {"text": text, "input_tokens": input_tokens, "output_tokens": min(token_count, request.max_tokens), "latency": demo_latency, "complete": complete, "token_source": "simulated"}


async def fetch_model(model, request):
    if request.mode == "demo":
        return demo_response(model, request)
    key = os.getenv(KEY_NAMES[model["provider"]])
    if not key:
        raise ValueError(f'{KEY_NAMES[model["provider"]]} is not configured on the server.')
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=90) as client:
        if model["provider"] == "OpenAI":
            response = await client.post("https://api.openai.com/v1/chat/completions", headers={"Authorization": f"Bearer {key}"}, json={"model": model["id"], "messages": [{"role": "system", "content": request.system}, {"role": "user", "content": request.prompt}], "temperature": request.temperature, "max_completion_tokens": request.max_tokens})
        elif model["provider"] == "Anthropic":
            response = await client.post("https://api.anthropic.com/v1/messages", headers={"x-api-key": key, "anthropic-version": "2023-06-01"}, json={"model": model["id"], "system": request.system, "messages": [{"role": "user", "content": request.prompt}], "temperature": min(request.temperature, 1), "max_tokens": request.max_tokens})
        else:
            response = await client.post(f'https://generativelanguage.googleapis.com/v1beta/models/{model["id"]}:generateContent', headers={"x-goog-api-key": key}, json={"systemInstruction": {"parts": [{"text": request.system}]}, "contents": [{"parts": [{"text": request.prompt}]}], "generationConfig": {"temperature": request.temperature, "maxOutputTokens": request.max_tokens}})
        if response.status_code >= 400:
            raise ValueError(f"Provider returned HTTP {response.status_code}. Check model availability, billing, and server credentials.")
        data = response.json()
    if model["provider"] == "OpenAI":
        choice = data["choices"][0]
        text = choice["message"].get("content") or ""
        usage = data.get("usage", {})
        input_tokens, output_tokens = usage.get("prompt_tokens"), usage.get("completion_tokens")
        complete = choice.get("finish_reason") == "stop"
    elif model["provider"] == "Anthropic":
        text = "\n".join(block["text"] for block in data["content"] if block.get("type") == "text")
        usage = data.get("usage", {})
        input_tokens, output_tokens = usage.get("input_tokens"), usage.get("output_tokens")
        complete = data.get("stop_reason") == "end_turn"
    else:
        choice = data["candidates"][0]
        text = "\n".join(part.get("text", "") for part in choice.get("content", {}).get("parts", []) if not part.get("thought"))
        usage = data.get("usageMetadata", {})
        input_tokens = usage.get("promptTokenCount")
        output_tokens = usage.get("candidatesTokenCount")
        if output_tokens is not None:
            output_tokens += usage.get("thoughtsTokenCount", 0)
        complete = choice.get("finishReason") == "STOP"
    measured = input_tokens is not None and output_tokens is not None
    return {"text": text, "input_tokens": input_tokens if input_tokens is not None else estimate_tokens(request.prompt + request.system), "output_tokens": output_tokens if output_tokens is not None else estimate_tokens(text), "latency": round(time.perf_counter() - started, 3), "complete": complete, "token_source": "provider" if measured else "estimated"}


def database():
    DB_PATH.parent.mkdir(exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.execute("CREATE TABLE IF NOT EXISTS experiments (id TEXT PRIMARY KEY, created TEXT NOT NULL, payload TEXT NOT NULL)")
    return connection


@app.get("/api/models")
def models():
    return {"models": MODELS, "providers": {provider: bool(os.getenv(key)) for provider, key in KEY_NAMES.items()}, "pricing_note": "Editable planning rates in USD per 1M tokens. Not live quotes; verify rates and model availability with each provider. Cached input, tiers, tools, and other surcharges are not included."}


async def build_comparison(request: Experiment, persist=True):
    catalog = {model["id"]: model for model in MODELS}
    if not request.prompt.strip() or len(set(request.models)) != len(request.models) or any(model_id not in catalog for model_id in request.models):
        raise HTTPException(422, "Use a nonempty prompt and 2-4 distinct supported models.")
    if any(len(keyword) > 80 for keyword in request.keywords):
        raise HTTPException(422, "Required terms must be 80 characters or shorter.")
    selected = [{**catalog[model_id], **(request.rates[model_id].model_dump() if model_id in request.rates else {})} for model_id in request.models]
    upper_estimate = sum(calculate_cost(estimate_tokens(request.system + request.prompt), request.max_tokens, model) for model in selected)
    if upper_estimate > request.budget:
        raise HTTPException(422, f"Batch estimate (${upper_estimate:.5f}) exceeds your ${request.budget:.5f} budget. Reduce output tokens or choose cheaper models. This is a planning guard, not a provider billing cap.")

    async def run(model):
        result = {"id": model["id"], "name": model["name"], "provider": model["provider"], "color": model["color"], "rates": {"input": model["input"], "output": model["output"]}}
        try:
            output = await fetch_model(model, request)
            cost = calculate_cost(output["input_tokens"], output["output_tokens"], model)
            result.update(output, cost=cost, credits=cost / request.credit_value, checks=output_checks(output["text"], request, output["complete"]))
        except ValueError as error:
            result.update(error=str(error), checks=[])
        except (httpx.HTTPError, KeyError, IndexError, TypeError):
            result.update(error="The provider timed out or returned an unexpected response. Try again or check the provider status.", checks=[])
        return result

    results = await asyncio.gather(*(run(model) for model in selected))
    payload = {"id": str(uuid.uuid4()), "created": datetime.now(timezone.utc).isoformat(), "request": request.model_dump(), "results": results, "recommendation": recommendation(results, request.objective, request.budget), "total_cost": sum(result.get("cost", 0) for result in results), "batch_estimate": upper_estimate}
    if persist:
        with database() as connection:
            connection.execute("INSERT INTO experiments VALUES (?, ?, ?)", (payload["id"], payload["created"], json.dumps(payload)))
    return payload


@app.post("/api/compare")
async def compare(request: Experiment):
    return await build_comparison(request)


@app.get("/api/example")
async def example():
    request = Experiment(prompt="Write a Python function that caches LLM responses using Redis. Include a stable cache key, TTL, and a short explanation.", models=["gpt-4.1-mini", "claude-sonnet-4-20250514", "gemini-2.5-flash"], max_tokens=1024)
    return await build_comparison(request, persist=False)

@app.get("/api/history")
def history():
    with database() as connection:
        rows = connection.execute("SELECT payload FROM experiments ORDER BY created DESC LIMIT 50").fetchall()
    return [json.loads(row[0]) for row in rows]


@app.delete("/api/history")
def clear_history():
    with database() as connection:
        connection.execute("DELETE FROM experiments")
    return {"deleted": True}


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


app.mount("/static", StaticFiles(directory=ROOT / "static", check_dir=False), name="static")