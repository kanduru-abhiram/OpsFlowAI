$ErrorActionPreference = "Stop"
Write-Host "Starting OpsFlow AI backend and frontend..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd backend; if (!(Test-Path .venv)) { python -m venv .venv }; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt; python seed.py; uvicorn app.main:app --reload --port 8000" -WindowStyle Hidden
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd frontend; npm install; npm run dev" -WindowStyle Hidden
Write-Host "Backend: http://localhost:8000"
Write-Host "Frontend: http://localhost:5173"
