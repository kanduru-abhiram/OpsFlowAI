#!/usr/bin/env bash
set -e
echo "Starting OpsFlow AI..."
(cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python seed.py && uvicorn app.main:app --reload --port 8000) &
(cd frontend && npm install && npm run dev) &
wait
