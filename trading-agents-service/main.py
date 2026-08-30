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
import os
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

API_TOKEN = os.environ.get("API_TOKEN", "")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "google")
JOB_RETENTION = timedelta(hours=24)

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


def _run_job(job_id: str, ticker: str, analysis_date: str):
    try:
        config = DEFAULT_CONFIG.copy()
        config["llm_provider"] = LLM_PROVIDER
        config["max_debate_rounds"] = 1  # keep each run bounded (cost + latency)
        # DEFAULT_CONFIG's deep_think_llm/quick_think_llm default to OpenAI model
        # names (e.g. "gpt-5.5") regardless of llm_provider -- confirmed live, this
        # 404'd calling Anthropic for a model named "gpt-5.4-mini". Must override
        # both model names whenever provider is switched.
        if LLM_PROVIDER == "anthropic":
            config["deep_think_llm"] = "claude-sonnet-5"
            config["quick_think_llm"] = "claude-haiku-4-5-20251001"
        elif LLM_PROVIDER == "google":
            # gemini-3.5-flash for both -- Google's free tier covers the flash tier;
            # gemini-3.1-pro-preview (TradingAgents' model_catalog.py also lists it)
            # is not expected to be free-tier eligible, so deliberately not used here
            # even for deep_think.
            config["deep_think_llm"] = "gemini-3.5-flash"
            config["quick_think_llm"] = "gemini-3.5-flash"

        ta = TradingAgentsGraph(debug=False, config=config)
        _, decision = ta.propagate(ticker, analysis_date)

        with _jobs_lock:
            _jobs[job_id].update(status="done", decision=decision)
    except Exception as e:
        with _jobs_lock:
            _jobs[job_id].update(status="error", error=str(e))


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
    return {k: v for k, v in job.items() if k != "created_at"}
