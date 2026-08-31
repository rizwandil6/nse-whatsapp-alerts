"""
Thin FastAPI wrapper around the real TauricResearch/TradingAgents repo
(https://github.com/TauricResearch/TradingAgents), installed straight from
GitHub in the Dockerfile -- NOT the unrelated `tradingagents` PyPI package,
which resolves to a different project (github.com/Mai0313/TradingAgents).

Async job pattern (POST /analyze returns a job_id immediately, GET
/analyze/{job_id} polls for the result) rather than a single synchronous
request -- confirmed live (2026-08-30) that Railway's edge proxy cuts the
connection before a real TradingAgents run finishes (multi-minute, several
sequential LLM calls per ticker), returning a 502 even though the backend
was still working. The Java dashboard's nightly PortfolioAnalysisScheduler
polls this the same way any client must.

Bearer-token gated (API_TOKEN env var) on every endpoint since this is a
public Railway URL and every /analyze call triggers real LLM + data-provider
API spend.
"""
import json
import os
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

import anthropic
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

API_TOKEN = os.environ.get("API_TOKEN", "")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "google")
# Verbose per-node TradingAgentsGraph logging -- off by default (noisy, and every
# portfolio ticker runs through this daily), toggle on via Railway var when diagnosing
# a specific run (e.g. tracking down where time actually goes mid-pipeline).
DEBUG = os.environ.get("TRADINGAGENTS_DEBUG", "false").lower() == "true"
JOB_RETENTION = timedelta(hours=24)

# TradingAgents' own signal_processing.process_signal() extracts one of five
# hardcoded labels from final_trade_decision: Buy/Overweight/Hold/Underweight/Sell
# (institutional portfolio-weighting terms, not configurable upstream). Collapsed to
# plain retail terms for the Portfolio tab -- Buy/Sell/Hold already read fine as-is.
_RETAIL_LABELS = {"Overweight": "Buy", "Underweight": "Sell"}

# $/1M tokens, each provider's own published rates -- update this if the models used
# below ever change. Model name is the dict key regardless of provider (names don't
# collide across Anthropic/Google), so lookup stays provider-agnostic.
_PRICE_PER_1M = {
    "claude-haiku-4-5-20251001": {"input": 1.00, "output": 5.00},
    # NOT gemini-3.5-flash ($1.50/$9.00 -- confirmed live 2026-08-31 that's MORE
    # expensive than Haiku, despite "Gemini free/cheap tier" assumptions from
    # gemini-2.5-flash-era pricing). flash-lite is the actually-cheap Gemini tier.
    "gemini-3.1-flash-lite": {"input": 0.25, "output": 1.50},
}

# Real per-run token usage/cost logging (2026-08-31, after burning through Anthropic
# credits faster than expected during earlier testing) -- patches the actual provider
# SDKs' raw call methods, NOT a LangChain-level hook. LangChain's own usage-tracking
# callbacks (get_openai_callback()-style) are provider-specific and not guaranteed to
# fire correctly through TradingAgents' own langchain_anthropic/langchain_google_genai
# wiring; patching the SDK call every LLM call ultimately goes through, regardless of
# abstraction layers on top, is the one point guaranteed to see every real request.
# thread-local, not global -- each /analyze job runs in its own dedicated thread (see
# _run_job), so this keeps concurrent jobs' usage from mixing. Model name is passed in
# explicitly by _start_usage_tracking (not parsed from each SDK's own response field --
# Anthropic's is reliable but Gemini's response.model_version carries a versioned
# suffix that wouldn't match the price table's key), since each provider branch in
# _run_job already knows deterministically which single model it's using.
_usage_local = threading.local()

_original_anthropic_create = anthropic.resources.messages.Messages.create


def _usage_tracking_anthropic(self, *args, **kwargs):
    response = _original_anthropic_create(self, *args, **kwargs)
    bucket = getattr(_usage_local, "usage", None)
    if bucket is not None and getattr(response, "usage", None) is not None:
        bucket["input_tokens"] += response.usage.input_tokens
        bucket["output_tokens"] += response.usage.output_tokens
        bucket["calls"] += 1
    return response


anthropic.resources.messages.Messages.create = _usage_tracking_anthropic

try:
    # Confirmed live (2026-08-31) via a temporary diagnostic endpoint against the
    # actual deployed langchain-google-genai (4.3.7): it calls self.client.models.
    # generate_content(...), i.e. google.genai.models.Models.generate_content -- the
    # NEW unified google-genai SDK, not the older google.ai.generativelanguage_v1beta
    # client this was originally (wrongly) patched against, which silently caught
    # nothing (0 tokens logged on confirmed-successful runs, no error either --
    # the old class still exists and imports fine, it's just not what's actually called).
    from google.genai.models import Models

    _original_gemini_generate_content = Models.generate_content

    def _usage_tracking_gemini(self, *args, **kwargs):
        response = _original_gemini_generate_content(self, *args, **kwargs)
        bucket = getattr(_usage_local, "usage", None)
        if bucket is not None and getattr(response, "usage_metadata", None) is not None:
            bucket["input_tokens"] += response.usage_metadata.prompt_token_count or 0
            bucket["output_tokens"] += response.usage_metadata.candidates_token_count or 0
            bucket["calls"] += 1
        return response

    Models.generate_content = _usage_tracking_gemini
except ImportError:
    # Verified present as a transitive dependency (langchain-google-genai -> this
    # package) as of 2026-08-31, but don't crash the whole service over usage-tracking
    # if that ever changes -- Gemini calls would just go untracked, not fail outright.
    pass


def _start_usage_tracking(model_name: str):
    _usage_local.usage = {"input_tokens": 0, "output_tokens": 0, "calls": 0, "model": model_name}


def _finish_usage_tracking() -> dict[str, Any]:
    usage = getattr(_usage_local, "usage", None) or {"input_tokens": 0, "output_tokens": 0, "calls": 0, "model": None}
    prices = _PRICE_PER_1M.get(usage["model"])
    cost = None
    if prices:
        cost = round(
            usage["input_tokens"] / 1_000_000 * prices["input"]
            + usage["output_tokens"] / 1_000_000 * prices["output"],
            4,
        )
    usage["estimated_cost_usd"] = cost
    _usage_local.usage = None
    return usage


def _log_usage(ticker: str, job_id: str, usage: dict[str, Any], failed: bool):
    status_word = "FAILED" if failed else "done"
    cost_str = f"${usage['estimated_cost_usd']}" if usage["estimated_cost_usd"] is not None else "cost unknown (no pricing on file for this model)"
    print(f"[usage] {ticker} job={job_id} {status_word}: {usage['calls']} call(s) on {usage['model']}, "
          f"{usage['input_tokens']} in / {usage['output_tokens']} out tokens, est. {cost_str}")


app = FastAPI()

# In-memory job store -- fine at this scale (single replica, at most a
# handful of distinct tickers per day via the nightly scheduler). Not
# durable across a redeploy, which is acceptable: a lost in-flight job just
# gets retried the next time the caller polls and gets a 404, same as any
# other transient failure the scheduler already treats as best-effort.
_jobs: dict[str, dict[str, Any]] = {}
_jobs_lock = threading.Lock()


class AnalyzeRequest(BaseModel):
    ticker: str
    date: str | None = None


def _check_token(x_api_token: str | None):
    if not API_TOKEN:
        raise HTTPException(status_code=500, detail="API_TOKEN not configured on server")
    if x_api_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Token")


def _prune_old_jobs():
    cutoff = datetime.now(timezone.utc) - JOB_RETENTION
    with _jobs_lock:
        stale = [jid for jid, j in _jobs.items() if j["created_at"] < cutoff]
        for jid in stale:
            del _jobs[jid]


# Single source of truth for which model each provider uses -- both deep_think_llm and
# quick_think_llm use the same model per provider (no separate cheap/expensive split),
# and usage tracking needs this same name to look up pricing (see _start_usage_tracking).
_PROVIDER_MODEL = {
    # Cost cut (2026-08-30): was claude-sonnet-5 ($2/$10 per 1M tokens) -- Haiku ($1/$5),
    # matching every other Anthropic call already made elsewhere in this repo
    # (NewsPoller, PromptRatingService, MarketBulletinService all use this same model).
    "anthropic": "claude-haiku-4-5-20251001",
    # NOT gemini-3.5-flash -- confirmed live 2026-08-31 that's $1.50/$9.00 per 1M,
    # MORE expensive than Haiku. flash-lite ($0.25/$1.50) is the actually-cheap tier.
    "google": "gemini-3.1-flash-lite",
    # International DashScope endpoint (not "qwen-cn" -- that's the separate mainland-
    # China-account endpoint, different API key, not interchangeable). Confirmed live
    # against Alibaba's own model-list docs (2026-08-31) -- ~$0.15/1M input, $0.47/1M
    # output. Requires DASHSCOPE_API_KEY.
    "qwen": "qwen3.8-flash",
}


def _run_job(job_id: str, ticker: str, analysis_date: str):
    model_name = _PROVIDER_MODEL.get(LLM_PROVIDER)
    _start_usage_tracking(model_name)
    try:
        config = DEFAULT_CONFIG.copy()
        config["llm_provider"] = LLM_PROVIDER
        config["max_debate_rounds"] = 1  # keep each run bounded (cost + latency)
        # DEFAULT_CONFIG's deep_think_llm/quick_think_llm default to OpenAI model
        # names (e.g. "gpt-5.5") regardless of llm_provider -- confirmed live, this
        # 404'd calling Anthropic for a model named "gpt-5.4-mini". Must override
        # both model names whenever provider is switched.
        if model_name:
            config["deep_think_llm"] = model_name
            config["quick_think_llm"] = model_name

        # Drops the default "social" analyst (Reddit/StockTwits sentiment) -- confirmed
        # live on every run so far: those sources 429/404 for essentially every NSE
        # ticker (they're US-retail-platform-centric), so that analyst still burns a
        # full LLM call synthesizing a report from data that's mostly empty. Cuts real
        # call volume, not analysis quality, for this market. Keeps market/news/
        # fundamentals (TradingAgentsGraph's other three default analysts).
        ta = TradingAgentsGraph(debug=DEBUG, config=config, selected_analysts=("market", "news", "fundamentals"))
        # propagate() returns (final_state, decision) -- decision is final_state's
        # "final_trade_decision" boiled down to one word (Buy/Sell/Hold/Overweight/
        # Underweight) via process_signal(). The full final_trade_decision text is
        # the actual reasoning behind that word and was previously discarded here
        # (returned as reasoning=None on every job) -- surfaced now so the Portfolio
        # tab shows more than just a one-word label.
        final_state, decision = ta.propagate(ticker, analysis_date)
        reasoning = final_state.get("final_trade_decision")
        decision = _RETAIL_LABELS.get(decision, decision)

        usage = _finish_usage_tracking()
        _log_usage(ticker, job_id, usage, failed=False)

        with _jobs_lock:
            _jobs[job_id].update(status="done", decision=decision, reasoning=reasoning, usage=usage)
    except Exception as e:
        usage = _finish_usage_tracking()
        _log_usage(ticker, job_id, usage, failed=True)
        with _jobs_lock:
            _jobs[job_id].update(status="error", error=str(e), usage=usage)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/analyze")
def analyze(req: AnalyzeRequest, x_api_token: str | None = Header(default=None)):
    _check_token(x_api_token)
    _prune_old_jobs()

    analysis_date = req.date or date.today().isoformat()
    job_id = uuid.uuid4().hex

    with _jobs_lock:
        _jobs[job_id] = {
            "status": "running",
            "ticker": req.ticker,
            "date": analysis_date,
            "created_at": datetime.now(timezone.utc),
        }

    threading.Thread(target=_run_job, args=(job_id, req.ticker, analysis_date), daemon=True).start()

    return {"job_id": job_id, "status": "running"}


@app.get("/analyze/{job_id}")
def analyze_status(job_id: str, x_api_token: str | None = Header(default=None)):
    _check_token(x_api_token)
    with _jobs_lock:
        job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found (may have expired or the service redeployed)")
    body = {k: v for k, v in job.items() if k != "created_at"}
    # Explicit json.dumps rather than returning the dict for FastAPI's default response
    # class to serialize -- confirmed live (2026-08-30): the `reasoning` field's
    # multi-paragraph text came back over the wire with RAW unescaped newline bytes
    # (verified: stdlib json.dumps does NOT do this in isolation, so something in the
    # default response path here does), producing technically invalid JSON per RFC
    # 8259 -- one that Java's strict Jackson parser (the real caller, in
    # PortfolioAnalysisScheduler) would very likely reject outright. json.dumps here is
    # directly verified correct (always escapes control characters), so this sidesteps
    # whatever the framework-default path was doing wrong, rather than chasing the
    # exact root cause through FastAPI/Starlette internals.
    return Response(content=json.dumps(body), media_type="application/json")
