import tempfile
import httpx
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

from fastapi.testclient import TestClient
import app


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(app, "DB_PATH", Path(self.temp.name) / "experiments.db")
        self.db_patch.start()
        self.client = TestClient(app.app)
        self.request = {"prompt": "Explain a response cache", "models": ["gpt-4.1-mini", "claude-sonnet-4-20250514", "gemini-2.5-flash"], "max_tokens": 1024}

    def tearDown(self):
        self.db_patch.stop()
        self.temp.cleanup()

    def test_pricing(self):
        self.assertAlmostEqual(app.calculate_cost(1000, 500, {"input": 0.4, "output": 1.6}), 0.0012)

    def test_sample_is_not_saved(self):
        response = self.client.get("/api/example")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["results"]), 3)
        self.assertEqual(self.client.get("/api/history").json(), [])

    def test_speed_and_zero_cost_ranking(self):
        results = [{"id": "cheap", "name": "Cheap", "cost": 0, "latency": 2, "checks": [{"passed": True}]}, {"id": "fast", "name": "Fast", "cost": 0.02, "latency": 1, "checks": [{"passed": True}]}]
        self.assertEqual(app.recommendation(results, "speed", 1)["winner"], "fast")
        result = app.recommendation(results, "cost", 1)
        self.assertEqual(result["winner"], "cheap")
        self.assertIsNone(result["runs"])

    def test_live_provider_usage_adapters(self):
        responses = {
            "OpenAI": {"choices": [{"message": {"content": "cache"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 100, "completion_tokens": 50}},
            "Anthropic": {"content": [{"type": "text", "text": "cache"}], "stop_reason": "end_turn", "usage": {"input_tokens": 100, "output_tokens": 50}},
            "Google": {"candidates": [{"content": {"parts": [{"text": "private thought", "thought": True}, {"text": "cache"}]}, "finishReason": "STOP"}], "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": 30, "thoughtsTokenCount": 20}},
        }

        async def fake_post(url, **kwargs):
            provider = "OpenAI" if "openai.com" in url else "Anthropic" if "anthropic.com" in url else "Google"
            return httpx.Response(200, json=responses[provider])

        with patch.dict(app.os.environ, {key: "test-placeholder" for key in app.KEY_NAMES.values()}), patch.object(app.httpx, "AsyncClient") as client:
            client.return_value.__aenter__.return_value.post = AsyncMock(side_effect=fake_post)
            body = self.client.post("/api/compare", json={**self.request, "mode": "live"}).json()
        for result in body["results"]:
            self.assertNotIn("error", result)
            self.assertEqual(result["token_source"], "provider")
            self.assertEqual(result["input_tokens"], 100)
            self.assertEqual(result["output_tokens"], 50)
            self.assertEqual(result["text"], "cache")

    def test_demo_compare_and_history(self):
        response = self.client.post("/api/compare", json=self.request)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(len(body["results"]), 3)
        self.assertEqual(body["request"]["mode"], "demo")
        self.assertTrue(all(result["token_source"] == "simulated" for result in body["results"]))
        self.assertEqual(body["recommendation"]["winner"], "gpt-4.1-mini")
        self.assertEqual(self.client.get("/api/history").json()[0]["id"], body["id"])
        self.assertEqual(self.client.delete("/api/history").status_code, 200)
        self.assertEqual(self.client.get("/api/history").json(), [])

    def test_budget_blocks_provider_calls(self):
        with patch.object(app, "fetch_model", new_callable=AsyncMock) as fetch:
            response = self.client.post("/api/compare", json={**self.request, "budget": 0.00001})
            self.assertEqual(response.status_code, 422)
            fetch.assert_not_called()

    def test_failure_isolated(self):
        async def fake_fetch(model, request):
            if model["provider"] == "Anthropic":
                raise ValueError("Provider unavailable")
            return {"text": "cache", "input_tokens": 100, "output_tokens": 100, "latency": 1, "complete": True, "token_source": "provider"}
        with patch.object(app, "fetch_model", side_effect=fake_fetch):
            body = self.client.post("/api/compare", json=self.request).json()
            self.assertIn("error", body["results"][1])
            self.assertIsNotNone(body["recommendation"]["winner"])

    def test_failed_checks_excluded(self):
        results = [{"id": "cheap", "name": "Cheap", "cost": 0.01, "latency": 1, "checks": [{"passed": False}]}, {"id": "valid", "name": "Valid", "cost": 0.02, "latency": 2, "checks": [{"passed": True}]}]
        self.assertEqual(app.recommendation(results, "cost", 1)["winner"], "valid")
        results[1]["checks"][0]["passed"] = False
        self.assertIsNone(app.recommendation(results, "cost", 1)["winner"])

    def test_json_checks_and_truncation(self):
        request = app.Experiment(**self.request, format="json", keywords=["cache"])
        self.assertTrue(all(check["passed"] for check in app.output_checks('{"cache": true}', request)))
        self.assertFalse(app.output_checks("not JSON", request)[1]["passed"])
        body = self.client.post("/api/compare", json={**self.request, "max_tokens": 64}).json()
        self.assertIsNone(body["recommendation"]["winner"])

    def test_duplicate_and_unknown_models_rejected(self):
        for models in [["gpt-4.1-mini", "gpt-4.1-mini"], ["unknown", "gpt-4.1"]]:
            self.assertEqual(self.client.post("/api/compare", json={**self.request, "models": models}).status_code, 422)

    def test_missing_keys_are_not_mocked(self):
        with patch.dict(app.os.environ, {}, clear=True):
            body = self.client.post("/api/compare", json={**self.request, "mode": "live"}).json()
        self.assertTrue(all("error" in result for result in body["results"]))
        self.assertIsNone(body["recommendation"]["winner"])


if __name__ == "__main__":
    unittest.main()