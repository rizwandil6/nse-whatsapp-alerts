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
    # The actually-cheap Gemini tier -- used for quick_think (the bulk of each run's calls).
    "gemini-3.1-flash-lite": {"input": 0.25, "output": 1.50},
    # deep_think_llm only (2026-08-31) -- stronger judgment on the decision-critical
    # synthesis steps (research manager, trader plan, risk judge), a small minority of
    # each run's ~18 calls. MORE expensive than Haiku per-token, despite "Gemini free/
    # cheap tier" assumptions from gemini-2.5-flash-era pricing -- but low call volume
    # keeps the blended per-run cost down.
    "gemini-3.5-flash": {"input": 1.50, "output": 9.00},
    # Not currently used -- confirmed live 2026-08-31 this tier has a hard 0 free-tier
    # quota, needs real billing enabled on the Google account. Priced here in case that
    # changes later.
    "gemini-3.1-pro-preview": {"input": 2.00, "output": 12.00},
}

# Real per-run token usage/cost logging (2026-08-31, after burning through Anthropic
# credits faster than expected during earlier testing) -- patches the actual provider
# SDKs' raw call methods, NOT a LangChain-level hook. LangChain's own usage-tracking
# callbacks (get_openai_callback()-style) are provider-specific and not guaranteed to
# fire correctly through TradingAgents' own langchain_anthropic/langchain_google_genai
# wiring; patching the SDK call every LLM call ultimately goes through, regardless of
# abstraction layers on top, is the one point guaranteed to see every real request.
# thread-local, not global -- each /analyze job runs in its own dedicated thread (see
# _run_job), so this keeps concurrent jobs' usage from mixing.
#
# Tracked PER MODEL, not one model per job (2026-08-31 revision) -- deep_think_llm and
# quick_think_llm can now differ within a single run (see _run_job), so a single
# job-wide model name is no longer enough to price the run correctly. Anthropic's
# response.model is reliable for this; Gemini's response.model_version carries a
# versioned suffix that wouldn't match the price table's key, so the Gemini patch reads
# the model straight from the call's own kwargs (generate_content(model=..., ...)) --
# the exact string this service requested, guaranteed to match _PRICE_PER_1M's keys.
_usage_local = threading.local()

_original_anthropic_create = anthropic.resources.messages.Messages.create


def _usage_tracking_anthropic(self, *args, **kwargs):
    response = _original_anthropic_create(self, *args, **kwargs)
    bucket = getattr(_usage_local, "usage", None)
    if bucket is not None and getattr(response, "usage", None) is not None:
        model = getattr(response, "model", None) or "unknown"
        entry = bucket["by_model"].setdefault(model, {"input_tokens": 0, "output_tokens": 0, "calls": 0})
        entry["input_tokens"] += response.usage.input_tokens
        entry["output_tokens"] += response.usage.output_tokens
        entry["calls"] += 1
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
            model = kwargs.get("model") or "unknown"
            entry = bucket["by_model"].setdefault(model, {"input_tokens": 0, "output_tokens": 0, "calls": 0})
            entry["input_tokens"] += response.usage_metadata.prompt_token_count or 0
            entry["output_tokens"] += response.usage_metadata.candidates_token_count or 0
            entry["calls"] += 1
        return response

    Models.generate_content = _usage_tracking_gemini
except ImportError:
    # Verified present as a transitive dependency (langchain-google-genai -> this
    # package) as of 2026-08-31, but don't crash the whole service over usage-tracking
    # if that ever changes -- Gemini calls would just go untracked, not fail outright.
    pass


def _start_usage_tracking():
    _usage_local.usage = {"by_model": {}}


def _finish_usage_tracking() -> dict[str, Any]:
    usage = getattr(_usage_local, "usage", None) or {"by_model": {}}
    by_model = usage["by_model"]
    total_input = sum(m["input_tokens"] for m in by_model.values())
    total_output = sum(m["output_tokens"] for m in by_model.values())
    total_calls = sum(m["calls"] for m in by_model.values())
    total_cost = 0.0
    cost_known = True
    for model, m in by_model.items():
        prices = _PRICE_PER_1M.get(model)
        if not prices:
            cost_known = False
            continue
        total_cost += m["input_tokens"] / 1_000_000 * prices["input"] + m["output_tokens"] / 1_000_000 * prices["output"]
    _usage_local.usage = None
    return {
        "by_model": by_model,
        "input_tokens": total_input,
        "output_tokens": total_output,
        "calls": total_calls,
        "estimated_cost_usd": round(total_cost, 4) if (cost_known and by_model) else None,
    }


def _log_usage(ticker: str, job_id: str, usage: dict[str, Any], failed: bool):
    status_word = "FAILED" if failed else "done"
    cost_str = f"${usage['estimated_cost_usd']}" if usage["estimated_cost_usd"] is not None else "cost unknown (no pricing on file for one or more models used)"
    breakdown = ", ".join(
        f"{m}: {v['calls']} call(s) {v['input_tokens']}in/{v['output_tokens']}out"
        for m, v in usage["by_model"].items()
    ) or "no calls"
    print(f"[usage] {ticker} job={job_id} {status_word}: {usage['calls']} total call(s) "
          f"[{breakdown}], est. {cost_str}")


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


# Single source of truth for which model(s) each provider uses. deep_think_llm handles
# the decision-critical synthesis steps (research manager judge, trader plan, risk
# judge) -- a small minority of each run's calls; quick_think_llm handles the bulk
# (analyst reports, debate arguments). Split 2026-08-31 per explicit request: shorter
# reasoning text is fine, but the final judgment/rating should stay accurate -- so
# quick_think stays on the cheap flash-lite tier while deep_think gets a stronger model.
_PROVIDER_MODELS = {
    # Cost cut (2026-08-30): was claude-sonnet-5 ($2/$10 per 1M tokens) -- Haiku ($1/$5)
    # for both, matching every other Anthropic call already made elsewhere in this repo
    # (NewsPoller, PromptRatingService, MarketBulletinService all use this same model).
    # No deep/quick split for Anthropic -- only Gemini is the active provider right now.
    "anthropic": {"deep": "claude-haiku-4-5-20251001", "quick": "claude-haiku-4-5-20251001"},
    "google": {
        # NOT gemini-3.1-pro-preview -- confirmed live 2026-08-31: that tier has a HARD
        # 0 free-tier quota (RESOURCE_EXHAUSTED on the very first call, "limit: 0"),
        # unlike flash-lite/flash which both have real (if capped) free allowances.
        # Pro-tier models need actual billing enabled on the Google account to use at
        # all -- gemini-3.5-flash is the strongest model this account can use without
        # that, still meaningfully stronger reasoning than flash-lite for the handful
        # of decision-critical calls per run ($1.50/$9.00 per 1M if billing WERE
        # enabled -- more than flash-lite, but low volume keeps the blended cost down).
        "deep": "gemini-3.5-flash",
        # NOT gemini-3.5-flash for quick_think -- confirmed live 2026-08-31 that's
        # $1.50/$9.00 per 1M, MORE expensive than Haiku. flash-lite ($0.25/$1.50) is
        # the actually-cheap tier, used for the bulk of each run's calls.
        "quick": "gemini-3.1-flash-lite",
    },
    # International DashScope endpoint (not "qwen-cn" -- that's the separate mainland-
    # China-account endpoint, different API key, not interchangeable). Confirmed live
    # against Alibaba's own model-list docs (2026-08-31) -- ~$0.15/1M input, $0.47/1M
    # output. Requires DASHSCOPE_API_KEY. No deep/quick split configured for Qwen yet.
    "qwen": {"deep": "qwen3.8-flash", "quick": "qwen3.8-flash"},
}


def _run_job(job_id: str, ticker: str, analysis_date: str):
    _start_usage_tracking()
    try:
        config = DEFAULT_CONFIG.copy()
        config["llm_provider"] = LLM_PROVIDER
        config["max_debate_rounds"] = 1  # keep each run bounded (cost + latency)
        # DEFAULT_CONFIG's deep_think_llm/quick_think_llm default to OpenAI model
        # names (e.g. "gpt-5.5") regardless of llm_provider -- confirmed live, this
        # 404'd calling Anthropic for a model named "gpt-5.4-mini". Must override
        # both model names whenever provider is switched.
        models = _PROVIDER_MODELS.get(LLM_PROVIDER)
        if models:
            config["deep_think_llm"] = models["deep"]
            config["quick_think_llm"] = models["quick"]

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
