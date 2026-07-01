import json
import asyncio
import logging
from queue import Queue
from threading import Thread
from datetime import timedelta

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import Base, SessionLocal, engine, get_db
from app.dependencies import get_current_user, require_roles
from app.models import Agent, Approval, AuditLog, Document, KnowledgeItem, Notification, OperationRequest, RequestStatus, User, WorkflowStep, utc_now
from app.schemas import ApprovalDecision, ChatRequest, ChatResponse, KnowledgeCreate, KnowledgeUpdate, LoginRequest, ProfileUpdate, RequestCreate, RequestOut, RequestUpdate, Token, UserCreate, UserOut, UserUpdate
from app.security import authenticate_user, create_access_token
from app.security import decode_token
from app.security import hash_password
from app.services.document_intelligence import extract_entities, extract_text_from_upload, summarize_document
from app.services.agents_sdk_adapter import describe_agent_runtime
from app.services.orchestrator import execute_workflow
from app.services.openai_client import OpenAIConfigurationError
from app.services.openai_client import OpenAIService
from app.services.rag import search_knowledge, upsert_knowledge

settings = get_settings()
Base.metadata.create_all(bind=engine)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("opsflow.api")

ADMIN_ROLES = {"Administrator"}
MANAGER_ROLES = {"Administrator", "Operations Manager"}
OPERATOR_ROLES = {"Administrator", "Operations Manager", "Operations Executive"}
WORKFLOW_STAGES = [
    ("Intake", "Intake Agent"),
    ("Classification", "Classification Agent"),
    ("Knowledge Retrieval", "Knowledge Agent"),
    ("Policy Validation", "Policy Validation Agent"),
    ("Risk Assessment", "Decision Agent"),
    ("Decision", "Decision Agent"),
    ("Ticket Generation", "Ticket Agent"),
    ("Communication", "Communication Agent"),
    ("Audit", "Audit Agent"),
    ("Completed", "Manager Agent"),
]


def can_view_request(user: User, request: OperationRequest) -> bool:
    return user.role in MANAGER_ROLES or request.created_by_id == user.id or user.role == "Viewer"


def can_mutate_request(user: User, request: OperationRequest | None = None) -> bool:
    if user.role in MANAGER_ROLES:
        return True
    return user.role == "Operations Executive" and (request is None or request.created_by_id == user.id)


def scoped_requests_query(db: Session, user: User):
    query = db.query(OperationRequest)
    if user.role == "Operations Executive":
        return query.filter(OperationRequest.created_by_id == user.id)
    return query


def ensure_request_visible(user: User, request: OperationRequest) -> None:
    if not can_view_request(user, request):
        raise HTTPException(status_code=403, detail="Request is not visible to this user")


def ensure_request_mutable(user: User, request: OperationRequest | None = None) -> None:
    if not can_mutate_request(user, request):
        raise HTTPException(status_code=403, detail="Insufficient role for this request")


def workflow_stage_state(request: OperationRequest, stage_index: int, step: WorkflowStep | None) -> str:
    if request.status == RequestStatus.failed.value:
        return "Failed" if step is None else "Completed"
    if step:
        return "Completed"
    completed_count = len({stage.agent_name for stage in request.steps}) if hasattr(request, "steps") else 0
    if request.status == RequestStatus.running.value and stage_index == completed_count:
        return "Running"
    if request.status == RequestStatus.waiting_approval.value and stage_index >= completed_count:
        return "Waiting Approval"
    if request.status == RequestStatus.exception.value and stage_index >= completed_count:
        return "Exception"
    if request.status == RequestStatus.completed.value:
        return "Completed"
    return "Pending"


def serialize_workflow(request: OperationRequest, steps: list[WorkflowStep]) -> dict:
    by_agent: dict[str, WorkflowStep] = {}
    for step in steps:
        by_agent.setdefault(step.agent_name, step)
    stages = []
    for index, (stage_name, agent_name) in enumerate(WORKFLOW_STAGES):
        step = by_agent.get(agent_name)
        citations = json.loads(step.citations_json or "[]") if step else []
        stages.append(
            {
                "name": stage_name,
                "agentName": agent_name,
                "state": workflow_stage_state(request, index, step),
                "executionTimeMs": 900 + (index * 180) if step else 0,
                "confidence": step.confidence if step else 0,
                "businessRules": [citation.get("title", "Operational policy") for citation in citations],
                "retrievedSops": citations,
                "reasoning": step.reasoning if step else "Stage is waiting for upstream workflow context.",
                "inputs": {"requestType": request.request_type, "customer": request.customer_name, "priority": request.priority},
                "outputs": {"message": step.message if step else "", "riskFactors": json.loads(step.risk_factors_json or "[]") if step else []},
            }
        )
    return {"request": RequestOut.model_validate(request).model_dump(mode="json"), "stages": stages}

app = FastAPI(title="OpsFlow AI API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",")],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "healthy", "service": "OpsFlow AI"}


@app.post("/api/auth/login", response_model=Token)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> Token:
    user = authenticate_user(db, payload.email, payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return Token(access_token=create_access_token(user.email))


@app.get("/api/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@app.post("/api/chat", response_model=ChatResponse)
def chat(payload: ChatRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ChatResponse:
    message = payload.message.strip()
    casual = message.lower().strip(" .!?")
    if casual in {"hi", "hello", "hey", "good morning", "good afternoon", "good evening"}:
        return ChatResponse(answer=f"Good day, {user.name}. How can I help with OpsFlow AI or your operations workflow today?")

    citations: list[dict] = []
    try:
        citations = search_knowledge(db, message, limit=4)
    except OpenAIConfigurationError:
        citations = []

    service = OpenAIService()
    if service.enabled():
        answer = service.text_response(
            instructions=(
                "You are OpsFlow AI Assistant inside an enterprise operations platform. "
                "Answer conversationally for general greetings and product questions. "
                "For technical, SOP, policy, workflow, banking operations, compliance, or configuration questions, "
                "use the supplied Knowledge Center citations. If citations are insufficient, say what is missing. "
                "Be concise, professional, and cite policy titles when used."
            ),
            payload={
                "user": {"name": user.name, "role": user.role, "department": user.department},
                "question": message,
                "history": [item.model_dump() for item in payload.history[-8:]],
                "knowledge_citations": [
                    {"title": item["title"], "category": item["category"], "source": item["source"], "content": item["content"][:1200], "score": item["score"]}
                    for item in citations
                ],
            },
        )
        return ChatResponse(answer=answer, citations=[{k: item[k] for k in ("id", "title", "category", "source", "score")} for item in citations])

    if citations:
        top = citations[0]
        return ChatResponse(
            answer=f"I found a relevant Knowledge Center item: {top['title']}. {top['content'][:450]}",
            citations=[{k: item[k] for k in ("id", "title", "category", "source", "score")} for item in citations],
        )
    return ChatResponse(answer="I can help with OpsFlow AI, operations requests, workflows, approvals, audit logs, and Knowledge Center content. Add an OpenAI API key for richer answers grounded in your SOPs.")


@app.put("/api/profile", response_model=UserOut)
def update_profile(payload: ProfileUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> User:
    updates = payload.model_dump(exclude_unset=True)
    if "email" in updates and updates["email"] != user.email and db.query(User).filter(User.email == updates["email"]).first():
        raise HTTPException(status_code=409, detail="Email already exists")
    for key, value in updates.items():
        if key == "password" and value:
            user.hashed_password = hash_password(value)
        elif value is not None:
            setattr(user, key, value)
    db.add(AuditLog(request_id=None, actor=user.name, action="Profile updated", details=json.dumps({k: v for k, v in updates.items() if k != "password"}, default=str)))
    db.commit()
    db.refresh(user)
    return user


@app.delete("/api/profile")
def deactivate_profile(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, str]:
    if user.role == "Administrator":
        raise HTTPException(status_code=400, detail="Administrators cannot deactivate their own account from Profile Settings")
    user.is_active = False
    db.add(AuditLog(request_id=None, actor=user.name, action="Profile deactivated", details=f"{user.email}: {user.role}"))
    db.commit()
    return {"status": "deactivated"}


@app.get("/api/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator"))) -> list[User]:
    return db.query(User).order_by(User.name).all()


@app.post("/api/users", response_model=UserOut)
def create_user(payload: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_roles("Administrator"))) -> User:
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=409, detail="Email already exists")
    user = User(
        name=payload.name,
        email=payload.email,
        role=payload.role,
        department=payload.department,
        is_active=payload.is_active,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    db.flush()
    db.add(AuditLog(request_id=None, actor=admin.name, action="User created", details=f"{user.email} as {user.role}"))
    db.commit()
    db.refresh(user)
    return user


@app.put("/api/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, db: Session = Depends(get_db), admin: User = Depends(require_roles("Administrator"))) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    updates = payload.model_dump(exclude_unset=True)
    if "email" in updates and updates["email"] != user.email and db.query(User).filter(User.email == updates["email"]).first():
        raise HTTPException(status_code=409, detail="Email already exists")
    if user.id == admin.id and updates.get("is_active") is False:
        raise HTTPException(status_code=400, detail="Administrators cannot deactivate their own account")
    if user.id == admin.id and updates.get("role") and updates["role"] != "Administrator":
        raise HTTPException(status_code=400, detail="Administrators cannot remove their own administrator role")
    for key, value in updates.items():
        if key == "password":
            user.hashed_password = hash_password(value)
        elif value is not None:
            setattr(user, key, value)
    db.add(AuditLog(request_id=None, actor=admin.name, action="User updated", details=f"{user.email}: {json.dumps({k: v for k, v in updates.items() if k != 'password'}, default=str)}"))
    db.commit()
    db.refresh(user)
    return user


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_roles("Administrator"))) -> dict[str, str]:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Administrators cannot delete their own account")
    db.query(OperationRequest).filter(OperationRequest.created_by_id == user.id).update({"created_by_id": None})
    db.add(AuditLog(request_id=None, actor=admin.name, action="User deleted", details=f"{user.email}: {user.role}"))
    db.delete(user)
    db.commit()
    return {"status": "deleted"}


@app.get("/api/dashboard/metrics")
def metrics(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    today = utc_now().date()
    request_query = scoped_requests_query(db, user)
    total = request_query.count()
    todays = scoped_requests_query(db, user).filter(func.date(OperationRequest.created_at) == today.isoformat()).count()
    completed = scoped_requests_query(db, user).filter(OperationRequest.status == RequestStatus.completed.value).count()
    pending = scoped_requests_query(db, user).filter(OperationRequest.status != RequestStatus.completed.value).count()
    running = scoped_requests_query(db, user).filter(OperationRequest.status == RequestStatus.running.value).count()
    exceptions = scoped_requests_query(db, user).filter(OperationRequest.status == RequestStatus.exception.value).count()
    pending_approvals = db.query(Approval).filter(Approval.status == "Pending").count() if user.role in MANAGER_ROLES else 0
    decided = db.query(Approval).filter(Approval.status != "Pending").count()
    approvals = db.query(Approval).filter(Approval.status == "Approved").count()
    high_risk = scoped_requests_query(db, user).filter(OperationRequest.risk_score >= 60).count()
    completed_requests = scoped_requests_query(db, user).filter(OperationRequest.status == RequestStatus.completed.value).all()
    if completed_requests:
        avg_hours = sum((item.updated_at - item.created_at).total_seconds() / 3600 for item in completed_requests) / len(completed_requests)
    else:
        avg_hours = 0
    agents = db.query(Agent).all()
    utilization = round((sum(agent.processed_count for agent in agents) / max(len(agents) * max(total, 1), 1)) * 100)
    met_sla = sum(1 for item in completed_requests if item.updated_at <= item.created_at + timedelta(hours=item.sla_hours))
    sla_performance = round((met_sla / max(len(completed_requests), 1)) * 100)
    all_requests = scoped_requests_query(db, user).all()
    average_sla = round(sum(item.sla_hours for item in all_requests) / max(len(all_requests), 1), 1)
    return {
        "todaysRequests": todays,
        "runningWorkflows": running,
        "completedRequests": completed,
        "pendingRequests": pending,
        "pendingApprovals": pending_approvals,
        "exceptions": exceptions,
        "averageSla": f"{average_sla:.1f}h",
        "averageResolutionTime": f"{avg_hours:.1f}h",
        "approvalRate": round((approvals / max(decided, 1)) * 100),
        "agentUtilization": min(utilization, 100),
        "highRiskRequests": high_risk,
        "slaPerformance": sla_performance,
    }


@app.get("/api/workflows")
def workflows(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    requests = scoped_requests_query(db, user).order_by(OperationRequest.updated_at.desc()).all()
    result = []
    for request in requests:
        steps = db.query(WorkflowStep).filter(WorkflowStep.request_id == request.id).order_by(WorkflowStep.created_at).all()
        result.append(serialize_workflow(request, steps))
    return result


@app.post("/api/demo/reset")
def reset_demo(_: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict[str, str]:
    from seed import reset_demo_data

    reset_demo_data()
    return {"status": "reset"}


@app.get("/api/requests", response_model=list[RequestOut])
def list_requests(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[OperationRequest]:
    return scoped_requests_query(db, user).order_by(OperationRequest.created_at.desc()).all()


@app.post("/api/requests", response_model=RequestOut)
def create_request(payload: RequestCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> OperationRequest:
    ensure_request_mutable(user)
    request = OperationRequest(**payload.model_dump(), created_by_id=user.id)
    db.add(request)
    db.commit()
    db.refresh(request)
    db.add(AuditLog(request_id=request.id, actor=user.name, action="Request created", details=payload.description))
    db.commit()
    return request


@app.put("/api/requests/{request_id}", response_model=RequestOut)
def update_request(request_id: int, payload: RequestUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> OperationRequest:
    request = db.get(OperationRequest, request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    ensure_request_mutable(user, request)
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(request, key, value)
    request.updated_at = utc_now()
    db.add(AuditLog(request_id=request.id, actor=user.name, action="Request updated", details=json.dumps(payload.model_dump(exclude_unset=True, mode="json"))))
    db.commit()
    db.refresh(request)
    return request


@app.delete("/api/requests/{request_id}")
def delete_request(request_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict[str, str]:
    request = db.get(OperationRequest, request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    db.add(AuditLog(request_id=None, actor=user.name, action="Request deleted", details=f"OPS-{request.id:05d}: {request.title}"))
    db.delete(request)
    db.commit()
    return {"status": "deleted"}


@app.get("/api/requests/{request_id}")
def get_request(request_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    request = db.get(OperationRequest, request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    ensure_request_visible(user, request)
    steps = db.query(WorkflowStep).filter(WorkflowStep.request_id == request_id).order_by(WorkflowStep.created_at).all()
    approvals = db.query(Approval).filter(Approval.request_id == request_id).all()
    return {
        "request": RequestOut.model_validate(request).model_dump(mode="json"),
        "steps": [
            {
                "id": s.id,
                "agentName": s.agent_name,
                "status": s.status,
                "message": s.message,
                "confidence": s.confidence,
                "citations": json.loads(s.citations_json or "[]"),
                "reasoning": s.reasoning,
                "riskFactors": json.loads(s.risk_factors_json or "[]"),
                "createdAt": s.created_at.isoformat(),
            }
            for s in steps
        ],
        "approvals": [
            {
                "id": a.id,
                "status": a.status,
                "recommendation": a.recommendation,
                "managerSummary": a.manager_summary,
                "decisionNotes": a.decision_notes,
            }
            for a in approvals
        ],
    }


@app.post("/api/requests/{request_id}/execute", response_model=RequestOut)
def run_request(request_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> OperationRequest:
    request = db.get(OperationRequest, request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    ensure_request_mutable(user, request)
    try:
        return execute_workflow(db, request)
    except OpenAIConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/requests/{request_id}/execute/stream")
def run_request_stream(request_id: int, user: User = Depends(get_current_user)) -> StreamingResponse:
    def event_stream():
        queue: Queue[dict | None] = Queue()

        def worker() -> None:
            db = SessionLocal()
            try:
                request = db.get(OperationRequest, request_id)
                if not request:
                    queue.put({"type": "error", "detail": "Request not found"})
                    return
                if not can_mutate_request(user, request):
                    queue.put({"type": "error", "detail": "Insufficient role for this request"})
                    return
                execute_workflow(db, request, on_event=queue.put)
            except OpenAIConfigurationError as exc:
                queue.put({"type": "error", "detail": str(exc)})
            except Exception as exc:
                logger.exception("SSE workflow execution failed for request %s", request_id)
                queue.put({"type": "error", "detail": f"Workflow execution failed: {exc}"})
            finally:
                db.close()
                queue.put(None)

        Thread(target=worker, daemon=True).start()
        while True:
            event = queue.get()
            if event is None:
                break
            yield f"data: {json.dumps(event, default=str)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.websocket("/ws/requests/{request_id}/workflow")
async def workflow_websocket(websocket: WebSocket, request_id: int) -> None:
    token = websocket.query_params.get("token")
    email = decode_token(token or "")
    if not email:
        await websocket.close(code=1008)
        return
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == email, User.is_active.is_(True)).first()
        if not user:
            await websocket.close(code=1008)
            return
        await websocket.accept()
        await websocket.send_json({"type": "connection.ready", "requestId": request_id})
        while True:
            message = await websocket.receive_json()
            if message.get("type") != "workflow.start":
                continue
            request = db.get(OperationRequest, request_id)
            if not request:
                await websocket.send_json({"type": "error", "detail": "Request not found"})
                continue
            if not can_mutate_request(user, request):
                await websocket.send_json({"type": "error", "detail": "Insufficient role for this request"})
                continue
            queue: Queue[dict | None] = Queue()

            def worker() -> None:
                worker_db = SessionLocal()
                try:
                    worker_request = worker_db.get(OperationRequest, request_id)
                    if not worker_request:
                        queue.put({"type": "error", "detail": "Request not found"})
                        return

                    execute_workflow(worker_db, worker_request, on_event=queue.put)
                except OpenAIConfigurationError as exc:
                    queue.put({"type": "error", "detail": str(exc)})
                except Exception as exc:
                    logger.exception("WebSocket workflow execution failed for request %s", request_id)
                    queue.put({"type": "error", "detail": f"Workflow execution failed: {exc}"})
                finally:
                    worker_db.close()
                    queue.put(None)

            Thread(target=worker, daemon=True).start()
            while True:
                event = await asyncio.to_thread(queue.get)
                if event is None:
                    break
                await websocket.send_json(event)
                if event.get("type") in {"workflow.completed", "error"}:
                    break
    except WebSocketDisconnect:
        return
    finally:
        db.close()


@app.get("/api/requests/{request_id}/playback")
def playback(request_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    request = db.get(OperationRequest, request_id)
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    ensure_request_visible(user, request)
    steps = db.query(WorkflowStep).filter(WorkflowStep.request_id == request_id).order_by(WorkflowStep.created_at).all()
    return [
        {
            "time": step.created_at.isoformat(),
            "agent": step.agent_name,
            "message": step.message,
            "confidence": step.confidence,
            "evidence": json.loads(step.citations_json or "[]"),
        }
        for step in steps
    ]


@app.post("/api/approvals/{approval_id}/decision")
def decide_approval(approval_id: int, payload: ApprovalDecision, db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict:
    approval = db.get(Approval, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval not found")
    approval.status = payload.decision
    approval.decision_notes = payload.notes
    approval.decided_by = user.name
    approval.decided_at = utc_now()
    request = db.get(OperationRequest, approval.request_id)
    if request:
        request.status = RequestStatus.completed.value if payload.decision == "Approved" else RequestStatus.exception.value
        request.decision = payload.decision
        request.updated_at = utc_now()
    db.add(AuditLog(request_id=approval.request_id, actor=user.name, action=f"Approval {payload.decision}", details=payload.notes))
    db.commit()
    return {"status": "ok"}


@app.get("/api/notifications")
def notifications(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    rows = (
        db.query(Notification)
        .filter((Notification.audience == user.role) | (Notification.audience == user.department) | (Notification.audience == "All"))
        .order_by(Notification.created_at.desc())
        .limit(30)
        .all()
    )
    return [
        {
            "id": item.id,
            "requestId": item.request_id,
            "audience": item.audience,
            "subject": item.subject,
            "body": item.body,
            "isRead": item.is_read,
            "createdAt": item.created_at.isoformat(),
        }
        for item in rows
    ]


@app.post("/api/notifications/{notification_id}/read")
def mark_notification_read(notification_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, str]:
    item = db.get(Notification, notification_id)
    if not item:
        raise HTTPException(status_code=404, detail="Notification not found")
    if item.audience not in {user.role, user.department, "All"}:
        raise HTTPException(status_code=403, detail="Notification is not visible to this user")
    item.is_read = True
    db.commit()
    return {"status": "ok"}


@app.get("/api/agents")
def agents(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Operations Manager"))) -> list[dict]:
    return [
        {
            "id": a.id,
            "name": a.name,
            "responsibility": a.responsibility,
            "status": a.status,
            "currentTask": a.current_task,
            "lastDecision": a.last_decision,
            "confidence": a.confidence,
            "executionTimeMs": a.execution_time_ms,
            "processedCount": a.processed_count,
        }
        for a in db.query(Agent).all()
    ]


@app.get("/api/agents/runtime")
def agent_runtime(_: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict[str, object]:
    return describe_agent_runtime()


@app.post("/api/documents/upload")
async def upload_document(request_id: int | None = None, file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    if request_id:
        request = db.get(OperationRequest, request_id)
        if not request:
            raise HTTPException(status_code=404, detail="Request not found")
        ensure_request_mutable(user, request)
    raw = await file.read()
    try:
        text = extract_text_from_upload(file.filename or "uploaded.txt", file.content_type, raw)
    except OpenAIConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    doc = Document(
        request_id=request_id,
        filename=file.filename or "uploaded.txt",
        document_type=file.content_type or "document",
        extracted_text=text,
        summary=summarize_document(text),
        entities_json=json.dumps(extract_entities(text)),
    )
    db.add(doc)
    db.commit()
    return {"id": doc.id, "summary": doc.summary, "entities": json.loads(doc.entities_json)}


@app.get("/api/documents")
def list_documents(request_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    query = db.query(Document)
    if request_id is not None:
        request = db.get(OperationRequest, request_id)
        if not request:
            raise HTTPException(status_code=404, detail="Request not found")
        ensure_request_visible(user, request)
        query = query.filter(Document.request_id == request_id)
    return [
        {
            "id": doc.id,
            "requestId": doc.request_id,
            "filename": doc.filename,
            "documentType": doc.document_type,
            "summary": doc.summary,
            "entities": json.loads(doc.entities_json or "{}"),
            "uploadedAt": doc.uploaded_at.isoformat(),
        }
        for doc in query.order_by(Document.uploaded_at.desc()).all()
    ]


@app.get("/api/documents/{document_id}")
def get_document(document_id: int, db: Session = Depends(get_db), user: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict:
    document = db.get(Document, document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    if document.request_id:
        request = db.get(OperationRequest, document.request_id)
        if request:
            ensure_request_visible(user, request)
    return {
        "id": document.id,
        "requestId": document.request_id,
        "filename": document.filename,
        "documentType": document.document_type,
        "summary": document.summary,
        "entities": json.loads(document.entities_json or "{}"),
        "extractedText": document.extracted_text,
        "uploadedAt": document.uploaded_at.isoformat(),
    }


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, str]:
    document = db.get(Document, document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    if document.request_id:
        request = db.get(OperationRequest, document.request_id)
        if request:
            ensure_request_mutable(user, request)
    elif user.role not in MANAGER_ROLES:
        raise HTTPException(status_code=403, detail="Insufficient role for this document")
    db.add(AuditLog(request_id=document.request_id, actor=user.name, action="Document deleted", details=document.filename))
    db.delete(document)
    db.commit()
    return {"status": "deleted"}


@app.post("/api/knowledge/upload")
def knowledge_upload(payload: KnowledgeCreate, db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Operations Manager", "Operations Executive"))) -> dict:
    try:
        item = upsert_knowledge(db, payload.title, payload.category, payload.content, payload.source)
    except OpenAIConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"id": item.id, "title": item.title}


@app.get("/api/knowledge")
def knowledge_list(db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    return [
        {"id": k.id, "title": k.title, "category": k.category, "source": k.source, "createdAt": k.created_at.isoformat()}
        for k in db.query(KnowledgeItem).order_by(KnowledgeItem.created_at.desc()).all()
    ]


@app.get("/api/knowledge/search")
def knowledge_search(q: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)) -> list[dict]:
    try:
        return search_knowledge(db, q)
    except OpenAIConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/knowledge/{item_id}")
def knowledge_get(item_id: int, db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict:
    item = db.get(KnowledgeItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Knowledge item not found")
    return {"id": item.id, "title": item.title, "category": item.category, "source": item.source, "content": item.content, "createdAt": item.created_at.isoformat()}


@app.put("/api/knowledge/{item_id}")
def knowledge_update(item_id: int, payload: KnowledgeUpdate, db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Operations Manager", "Operations Executive"))) -> dict:
    item = db.get(KnowledgeItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Knowledge item not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(item, key, value)
    if payload.content is not None:
        from app.services.rag import embed_text

        try:
            item.embedding_json = json.dumps(embed_text(item.content))
        except OpenAIConfigurationError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    db.commit()
    db.refresh(item)
    return {"id": item.id, "title": item.title, "category": item.category, "source": item.source, "content": item.content, "createdAt": item.created_at.isoformat()}


@app.delete("/api/knowledge/{item_id}")
def knowledge_delete(item_id: int, db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Operations Manager"))) -> dict[str, str]:
    item = db.get(KnowledgeItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Knowledge item not found")
    db.delete(item)
    db.commit()
    return {"status": "deleted"}


@app.get("/api/audit")
def audit(db: Session = Depends(get_db), _: User = Depends(require_roles("Administrator", "Operations Manager"))) -> list[dict]:
    logs = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(100).all()
    return [
        {"id": log.id, "requestId": log.request_id, "actor": log.actor, "action": log.action, "details": log.details, "createdAt": log.created_at.isoformat()}
        for log in logs
    ]


@app.get("/api/analytics")
def analytics(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    request_query = scoped_requests_query(db, user)
    categories = request_query.with_entities(OperationRequest.request_type, func.count(OperationRequest.id)).group_by(OperationRequest.request_type).all()
    risks = [
        {"name": "Low", "value": scoped_requests_query(db, user).filter(OperationRequest.risk_score < 35).count()},
        {"name": "Medium", "value": scoped_requests_query(db, user).filter(OperationRequest.risk_score.between(35, 59)).count()},
        {"name": "High", "value": scoped_requests_query(db, user).filter(OperationRequest.risk_score >= 60).count()},
    ]
    weekday_rows = (
        scoped_requests_query(db, user)
        .with_entities(func.strftime("%w", OperationRequest.created_at), OperationRequest.status, func.count(OperationRequest.id))
        .group_by(func.strftime("%w", OperationRequest.created_at), OperationRequest.status)
        .all()
    )
    day_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    trend = {day: {"day": day, "met": 0, "missed": 0} for day in day_names}
    for day_index, status, count in weekday_rows:
        bucket = trend[day_names[int(day_index)]]
        if status == RequestStatus.completed.value:
            bucket["met"] += count
        else:
            bucket["missed"] += count
    recent_logs = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(8).all()
    return {
        "categories": [{"name": name, "value": count} for name, count in categories],
        "riskDistribution": risks,
        "slaTrend": list(trend.values()),
        "recentActivities": [
            {"actor": log.actor, "action": log.action, "details": log.details, "createdAt": log.created_at.isoformat()}
            for log in recent_logs
        ],
    }
