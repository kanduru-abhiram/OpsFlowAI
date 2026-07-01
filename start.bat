@echo off
echo Starting OpsFlow AI...
start "OpsFlow Backend" cmd /k "cd backend && if not exist .venv python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && python seed.py && uvicorn app.main:app --reload --port 8000"
start "OpsFlow Frontend" cmd /k "cd frontend && npm install && npm run dev"
echo Backend: http://localhost:8000
echo Frontend: http://localhost:5173
