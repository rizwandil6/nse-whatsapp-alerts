"""
Thin FastAPI wrapper around the real TauricResearch/TradingAgents repo
(https://github.com/TauricResearch/TradingAgents), installed straight from
GitHub in the Dockerfile -- NOT the unrelated `tradingagents` PyPI package,
which resolves to a different project (github.com/Mai0313/TradingAgents).

Exposes one endpoint, POST /analyze, so the Java dashboard's nightly
PortfolioAnalysisScheduler can call it once per distinct portfolio ticker
and get back a decision + reasoning to persist in Postgres. Bearer-token
gated (API_TOKEN env var) since this is a public Railway URL and every
call triggers real LLM + data-provider API spend.
"""
import os
from datetime import date

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

API_TOKEN = os.environ.get("API_TOKEN", "")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic")

app = FastAPI()


class AnalyzeRequest(BaseModel):
    ticker: str
    date: str | None = None


def _check_token(x_api_token: str | None):
    if not API_TOKEN:
        raise HTTPException(status_code=500, detail="API_TOKEN not configured on server")
    if x_api_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid or missing X-API-Token")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.post("/analyze")
def analyze(req: AnalyzeRequest, x_api_token: str | None = Header(default=None)):
    _check_token(x_api_token)

    analysis_date = req.date or date.today().isoformat()

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = LLM_PROVIDER
    config["max_debate_rounds"] = 1  # keep each run bounded (cost + latency)

    ta = TradingAgentsGraph(debug=False, config=config)
    _, decision = ta.propagate(req.ticker, analysis_date)

    return {
        "ticker": req.ticker,
        "date": analysis_date,
        "decision": decision,
    }
