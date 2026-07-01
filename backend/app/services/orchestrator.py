import json
from collections.abc import Callable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any

from agents import Agent as OpenAIAgent
from agents import AgentOutputSchema, ModelSettings, RunConfig, Runner, set_default_openai_key
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Agent, Approval, AuditLog, Document, Notification, OperationRequest, RequestStatus, WorkflowStep, utc_now
from app.services.openai_client import OpenAIConfigurationError, OpenAIService
from app.services.rag import search_knowledge


class AgentStepOutput(BaseModel):
    message: str = Field(description="A concise status update written as the agent speaking in first person.")
    confidence: float = Field(ge=0, le=1, description="Agent confidence from 0 to 1.")
    reasoning: str = Field(description="Explainable reasoning based only on request data, documents, and cited policy evidence.")
    evidence: list[str] = Field(description="Specific evidence snippets or document facts used by the agent.")
    risk_factors: list[str] = Field(description="Risk factors identified by this agent.")
    next_context: dict[str, Any] = Field(description="Structured context that should be passed to downstream agents.")


class RiskOutput(BaseModel):
    risk_score: int = Field(ge=0, le=100)
    risk_factors: list[str]
    recommended_decision: str
    confidence: float = Field(ge=0, le=1)
    priority: str
    sla_hours: int
    department: str
    manager_summary: str
    approval_required: bool


@dataclass(frozen=True)
class AgentDefinition:
    name: str
    instructions: str


@dataclass
class WorkflowResult:
    request: OperationRequest
    events: list[dict[str, Any]] = field(default_factory=list)


AGENTS: list[AgentDefinition] = [
    AgentDefinition("Intake Agent", "Understand the request intent, extract metadata, parse document findings, and identify missing information."),
    AgentDefinition("Classification Agent", "Classify the operation, department, priority hints, SLA considerations, and business category."),
    AgentDefinition("Knowledge Agent", "Use the retrieved SOP and policy citations to explain which rules apply and why."),
    AgentDefinition("Policy Validation Agent", "Validate mandatory requirements, compliance checks, and evidence sufficiency against cited rules."),
    AgentDefinition("Decision Agent", "Recommend approve, reject, or request more information using confidence, citations, and policy fit."),
    AgentDefinition("Exception Agent", "Detect policy exceptions, missing evidence, violations, and corrective actions."),
    AgentDefinition("Ticket Agent", "Generate enterprise work item details, owner recommendation, priority, and resolution estimate."),
    AgentDefinition("Communication Agent", "Draft customer, internal, and manager communications grounded in the decision and evidence."),
    AgentDefinition("Audit Agent", "Create an audit-ready decision history, evidence map, and agent activity explanation."),
    AgentDefinition("Manager Agent", "Produce executive summary, risk explanation, approval recommendation, and business impact summary."),
]


BASE_AGENT_INSTRUCTIONS = """
You are part of OpsFlow AI, an enterprise operations control-center. You must return structured JSON only.
Use only the request data, uploaded document extractions, previous agent context, and retrieved policy citations supplied in the input.
Never invent policy names, missing documents, confidence scores, or evidence.
If evidence is insufficient, say what is missing and lower confidence.
"""


RISK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["risk_score", "risk_factors", "recommended_decision", "confidence", "priority", "sla_hours", "department", "manager_summary", "approval_required"],
    "properties": {
        "risk_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "risk_factors": {"type": "array", "items": {"type": "string"}},
        "recommended_decision": {"type": "string", "enum": ["Approve", "Reject", "Request More Information"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "priority": {"type": "string", "enum": ["Low", "Medium", "High", "Critical"]},
        "sla_hours": {"type": "integer", "minimum": 1, "maximum": 720},
        "department": {"type": "string"},
        "manager_summary": {"type": "string"},
        "approval_required": {"type": "boolean"},
    },
}


def _require_openai() -> None:
    settings = get_settings()
    if not settings.openai_api_key:
        raise OpenAIConfigurationError("OPENAI_API_KEY is required to execute OpenAI multi-agent workflows.")
    set_default_openai_key(settings.openai_api_key)


def _documents(db: Session, request_id: int) -> list[dict[str, Any]]:
    return [
        {
            "filename": document.filename,
            "document_type": document.document_type,
            "summary": document.summary,
            "entities": json.loads(document.entities_json or "{}"),
            "extracted_text": document.extracted_text[:4000],
        }
        for document in db.query(Document).filter(Document.request_id == request_id).all()
    ]


def _request_payload(request: OperationRequest) -> dict[str, Any]:
    return {
        "id": request.id,
        "title": request.title,
        "request_type": request.request_type,
        "customer_name": request.customer_name,
        "account_number": request.account_number,
        "email": request.email,
        "description": request.description,
        "department": request.department,
        "priority": request.priority,
        "sla_hours": request.sla_hours,
        "status": request.status,
        "risk_score": request.risk_score,
        "confidence": request.confidence,
        "decision": request.decision,
    }


def _step(db: Session, request: OperationRequest, agent_name: str, output: AgentStepOutput, citations: list[dict], status: str = "Completed") -> WorkflowStep:
    item = WorkflowStep(
        request_id=request.id,
        agent_name=agent_name,
        status=status,
        message=output.message,
        confidence=round(output.confidence, 3),
        citations_json=json.dumps(citations),
        reasoning=output.reasoning,
        risk_factors_json=json.dumps(output.risk_factors),
    )
    db.add(item)
    agent = db.query(Agent).filter(Agent.name == agent_name).first()
    if agent:
        start = perf_counter()
        agent.status = "Active"
        agent.current_task = output.message[:240]
        agent.last_decision = output.reasoning[:500]
        agent.confidence = round(output.confidence, 3)
        agent.execution_time_ms = int((perf_counter() - start) * 1000) + 120
        agent.processed_count += 1
    db.flush()
    return item


def _run_agent(definition: AgentDefinition, payload: dict[str, Any]) -> AgentStepOutput:
    settings = get_settings()
    agent = OpenAIAgent(
        name=definition.name,
        instructions=f"{BASE_AGENT_INSTRUCTIONS}\nRole: {definition.instructions}",
        model=settings.openai_model,
        model_settings=ModelSettings(temperature=0.2),
        output_type=AgentOutputSchema(AgentStepOutput, strict_json_schema=False),
    )
    result = Runner.run_sync(
        agent,
        json.dumps(payload, ensure_ascii=False),
        run_config=RunConfig(workflow_name="OpsFlow AI Multi-Agent Operations Workflow"),
        max_turns=4,
    )
    return result.final_output_as(AgentStepOutput)


def _score_risk(payload: dict[str, Any]) -> RiskOutput:
    response = OpenAIService().structured_response(
        instructions=(
            "You are OpsFlow AI Risk Engine. Score operational risk from 0-100 using retrieved policy citations, "
            "document evidence, missing requirements, operation sensitivity, confidence from agents, and business impact. "
            "Return strict JSON only."
        ),
        payload=payload,
        schema_name="opsflow_risk_score",
        json_schema=RISK_SCHEMA,
        max_tokens=1200,
    )
    return RiskOutput.model_validate(response)


def execute_workflow(db: Session, request: OperationRequest, on_event: Callable[[dict[str, Any]], None] | None = None) -> OperationRequest:
    result = execute_workflow_with_events(db, request, on_event=on_event)
    return result.request


def execute_workflow_with_events(db: Session, request: OperationRequest, on_event: Callable[[dict[str, Any]], None] | None = None) -> WorkflowResult:
    _require_openai()
    settings = get_settings()
    events: list[dict[str, Any]] = []

    def emit(event: dict[str, Any]) -> None:
        events.append(event)
        if on_event:
            on_event(event)

    request.status = RequestStatus.running.value
    request.updated_at = utc_now()
    db.query(WorkflowStep).filter(WorkflowStep.request_id == request.id).delete()
    db.query(Approval).filter(Approval.request_id == request.id, Approval.status == "Pending").delete()
    db.flush()
    emit({"type": "workflow.status", "status": request.status, "requestId": request.id})

    citations = [
        {"id": c["id"], "title": c["title"], "source": c["source"], "category": c["category"], "score": c["score"], "content": c["content"][:1200]}
        for c in search_knowledge(db, f"{request.request_type}\n{request.description}", limit=5)
    ]
    documents = _documents(db, request.id)
    shared_context: dict[str, Any] = {
        "request": _request_payload(request),
        "documents": documents,
        "policy_citations": citations,
        "agent_outputs": [],
    }

    agent_outputs: list[dict[str, Any]] = []
    confidences: list[float] = []
    all_risk_factors: list[str] = []
    for definition in AGENTS:
        emit(
            {
                "type": "agent.started",
                "requestId": request.id,
                "agentName": definition.name,
                "message": f"{definition.name} is analyzing request context and policy evidence.",
            }
        )
        agent_payload = {**shared_context, "current_agent": definition.name}
        output = _run_agent(definition, agent_payload)
        agent_outputs.append({"agent": definition.name, **output.model_dump()})
        confidences.append(output.confidence)
        all_risk_factors.extend(output.risk_factors)
        shared_context["agent_outputs"] = agent_outputs
        shared_context["latest_context"] = output.next_context
        step = _step(db, request, definition.name, output, citations)
        db.commit()
        emit(
            {
                "type": "agent.step",
                "requestId": request.id,
                "stepId": step.id,
                "agentName": definition.name,
                "message": output.message,
                "confidence": output.confidence,
                "citations": citations,
                "reasoning": output.reasoning,
                "riskFactors": output.risk_factors,
            }
        )

    risk = _score_risk(
        {
            **shared_context,
            "aggregate_agent_confidence": sum(confidences) / max(len(confidences), 1),
            "agent_risk_factors": sorted(set(all_risk_factors)),
            "confidence_threshold": settings.confidence_threshold,
        }
    )
    needs_approval = risk.approval_required or risk.confidence < settings.confidence_threshold
    request.risk_score = risk.risk_score
    request.confidence = round(risk.confidence, 3)
    request.priority = risk.priority
    request.sla_hours = risk.sla_hours
    request.department = risk.department
    request.decision = risk.recommended_decision
    request.status = RequestStatus.waiting_approval.value if needs_approval else RequestStatus.completed.value
    request.updated_at = utc_now()

    if needs_approval:
        approval = Approval(
            request_id=request.id,
            recommendation=risk.recommended_decision,
            manager_summary=risk.manager_summary,
        )
        db.add(approval)
        db.add(
            Notification(
                request_id=request.id,
                audience="Operations Manager",
                subject=f"Approval needed for OPS-{request.id:05d}",
                body=risk.manager_summary,
            )
        )

    db.add(
        AuditLog(
            request_id=request.id,
            actor="OpenAI Audit Agent",
            action="OpenAI multi-agent workflow completed",
            details=f"Decision={request.decision}; Confidence={request.confidence}; Risk={request.risk_score}",
            evidence=json.dumps({"citations": citations, "agent_outputs": agent_outputs, "risk": risk.model_dump()}),
        )
    )
    db.commit()
    db.refresh(request)
    emit({"type": "workflow.completed", "requestId": request.id, "status": request.status, "decision": request.decision, "riskScore": request.risk_score})
    return WorkflowResult(request=request, events=events)
