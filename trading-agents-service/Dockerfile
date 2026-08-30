# Standalone Railway service, root directory = this folder.
# Installs the real upstream TauricResearch/TradingAgents repo from GitHub via
# requirements.txt (git+https://...) -- do NOT switch this to
# `pip install tradingagents`, that PyPI package name is an unrelated project
# (github.com/Mai0313/TradingAgents).
FROM python:3.12-slim

WORKDIR /app

# git is needed for pip's `git+https://...` VCS install below.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8080
# Shell form so Railway's injected $PORT is honored (falls back to 8080 locally).
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
