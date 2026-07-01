from app.database import Base, SessionLocal, engine
from app.config import get_settings
import json

from app.models import Agent, Approval, AuditLog, Document, KnowledgeItem, Notification, OperationRequest, RequestStatus, User, WorkflowStep, utc_now
from app.security import hash_password
from app.services.orchestrator import execute_workflow
from app.services.rag import upsert_knowledge

Base.metadata.create_all(bind=engine)

AGENTS = [
    ("Intake Agent", "Understands user intent, extracts metadata, and parses documents."),
    ("Classification Agent", "Categorizes operations, departments, priorities, and SLA."),
    ("Knowledge Agent", "Retrieves SOPs, operational policies, business rules, and citations."),
    ("Policy Validation Agent", "Validates compliance and explains policy reasoning."),
    ("Decision Agent", "Approves, rejects, or requests information with confidence scores."),
    ("Exception Agent", "Detects missing information, violations, and corrective actions."),
    ("Ticket Agent", "Generates enterprise work items and ownership suggestions."),
    ("Communication Agent", "Drafts customer emails, notifications, and summaries."),
    ("Audit Agent", "Creates audit logs, decision history, and evidence tracking."),
    ("Manager Agent", "Produces executive summaries and approval recommendations."),
]

POLICIES = [
    (
        "SOP 7.2 Nominee Update Mandatory Documents",
        "Banking SOP",
        "Nominee update requests require signed nominee declaration, government photo ID, PAN or equivalent tax identifier, and customer account match validation before fulfillment.",
    ),
    (
        "Policy KYC-14 Address Correction",
        "KYC Policy",
        "Address correction requires proof of address issued within 90 days and must be escalated when customer profile has incomplete KYC.",
    ),
    (
        "SOP 3.4 Account Closure",
        "Banking SOP",
        "Account closure requires zero lien validation, balance settlement confirmation, enhanced manager approval, and customer communication archive.",
    ),
    (
        "Vendor Onboarding Control V5",
        "Procurement Policy",
        "Vendor onboarding requires tax registration, bank verification, sanctions screening, and risk owner approval for high-value categories.",
    ),
]

REQUESTS = [
    (
        "Nominee update for Rajesh Kumar",
        "Customer nominee update",
        "Rajesh Kumar",
        "AC-847392",
        "rajesh.kumar@example.com",
        "Customer requests nominee update. Aadhaar and signed declaration attached, PAN card missing.",
    ),
    (
        "Address correction for Priya Sharma",
        "Address correction",
        "Priya Sharma",
        "AC-119204",
        "priya.sharma@example.com",
        "Customer submitted address correction with electricity bill dated within 60 days.",
    ),
    (
        "Vendor onboarding for Northstar Facilities",
        "Vendor onboarding",
        "Northstar Facilities",
        "VN-554210",
        "ops@northstar.example.com",
        "New facilities vendor onboarding, GST certificate uploaded, bank verification pending.",
    ),
]

DEMO_REQUESTS = [
    {
        "title": "Nominee update for Rajesh Kumar",
        "request_type": "Nominee Update",
        "customer_name": "Rajesh Kumar",
        "account_number": "AC-847392",
        "email": "rajesh.kumar@example.com",
        "description": "Customer requests nominee update. Aadhaar and nominee declaration are present; PAN card is missing.",
        "status": RequestStatus.waiting_approval.value,
        "risk_score": 48,
        "confidence": 0.73,
        "decision": "Request More Information",
        "priority": "High",
        "sla_hours": 8,
        "completed_agents": 6,
        "approval": True,
    },
    {
        "title": "Vendor onboarding for Northstar Facilities",
        "request_type": "Vendor Onboarding",
        "customer_name": "Northstar Facilities",
        "account_number": "VN-554210",
        "email": "ops@northstar.example.com",
        "description": "GST certificate verified; bank verification and sanctions screening are in progress.",
        "status": RequestStatus.running.value,
        "risk_score": 61,
        "confidence": 0.64,
        "decision": "Pending",
        "priority": "Critical",
        "sla_hours": 16,
        "completed_agents": 3,
        "approval": False,
    },
    {
        "title": "Password reset for Meera Nair",
        "request_type": "Password Reset",
        "customer_name": "Meera Nair",
        "account_number": "USR-442010",
        "email": "meera.nair@example.com",
        "description": "Employee identity verified using MFA and manager attestation.",
        "status": RequestStatus.completed.value,
        "risk_score": 12,
        "confidence": 0.94,
        "decision": "Approve",
        "priority": "Low",
        "sla_hours": 2,
        "completed_agents": 10,
        "approval": False,
    },
    {
        "title": "Account closure for Suresh Patel",
        "request_type": "Account Closure",
        "customer_name": "Suresh Patel",
        "account_number": "AC-773910",
        "email": "suresh.patel@example.com",
        "description": "Closure requested for high-value account; lien validation is pending.",
        "status": RequestStatus.exception.value,
        "risk_score": 78,
        "confidence": 0.58,
        "decision": "Request More Information",
        "priority": "Critical",
        "sla_hours": 24,
        "completed_agents": 5,
        "approval": True,
    },
    {
        "title": "Address change for Priya Sharma",
        "request_type": "Address Change",
        "customer_name": "Priya Sharma",
        "account_number": "AC-119204",
        "email": "priya.sharma@example.com",
        "description": "Electricity bill dated within 60 days supplied for address correction.",
        "status": RequestStatus.pending.value,
        "risk_score": 20,
        "confidence": 0.0,
        "decision": "Pending",
        "priority": "Medium",
        "sla_hours": 12,
        "completed_agents": 0,
        "approval": False,
    },
]

DEMO_AGENT_MESSAGES = [
    ("Intake Agent", "Detected operational intent, extracted customer identifiers, and normalized request metadata."),
    ("Classification Agent", "Assigned department, priority, and SLA based on operation category and sensitivity."),
    ("Knowledge Agent", "Retrieved applicable SOPs, control policies, and business rules with citations."),
    ("Policy Validation Agent", "Validated mandatory documents and compliance requirements against retrieved policy evidence."),
    ("Decision Agent", "Prepared decision recommendation with confidence and exception rationale."),
    ("Exception Agent", "Checked missing information, policy violations, and corrective action path."),
    ("Ticket Agent", "Generated enterprise work item, owner recommendation, and resolution estimate."),
    ("Communication Agent", "Drafted customer and internal communications for the current workflow outcome."),
    ("Audit Agent", "Recorded evidence, decisions, citations, and chronological workflow activity."),
    ("Manager Agent", "Prepared executive summary, risk explanation, and approval recommendation."),
]


def seed() -> None:
    settings = get_settings()
    db = SessionLocal()
    try:
        if not db.query(User).first():
            users = [
                User(name="Asha Rao", email="admin@opsflow.ai", role="Administrator", department="AI Operations", hashed_password=hash_password("password123")),
                User(name="Vikram Mehta", email="manager@opsflow.ai", role="Operations Manager", department="Banking Operations", hashed_password=hash_password("password123")),
                User(name="Neha Iyer", email="ops@opsflow.ai", role="Operations Executive", department="Shared Services", hashed_password=hash_password("password123")),
                User(name="Read Only Viewer", email="viewer@opsflow.ai", role="Viewer", department="Enterprise PMO", hashed_password=hash_password("password123")),
            ]
            db.add_all(users)
        if not db.query(Agent).first():
            db.add_all([Agent(name=name, responsibility=responsibility) for name, responsibility in AGENTS])
        if not db.query(OperationRequest).first():
            for title, request_type, customer_name, account_number, email, description in REQUESTS:
                db.add(OperationRequest(title=title, request_type=request_type, customer_name=customer_name, account_number=account_number, email=email, description=description))
        db.commit()
        if not db.query(AuditLog).first():
            db.add(AuditLog(actor="System", action="Seed data initialized", details="Seeded users, agents, policies, and requests created."))
        from app.models import KnowledgeItem

        existing_titles = {item.title for item in db.query(KnowledgeItem).all()}
        for title, category, content in POLICIES:
            if title not in existing_titles:
                upsert_knowledge(db, title, category, content, "Enterprise Knowledge Base", require_embedding=False)
        if settings.openai_api_key:
            for request in db.query(OperationRequest).filter(OperationRequest.status == RequestStatus.pending.value).all():
                execute_workflow(db, request)
        db.commit()
    finally:
        db.close()


def reset_demo_data() -> None:
    db = SessionLocal()
    try:
        db.query(Notification).delete()
        db.query(Approval).delete()
        db.query(WorkflowStep).delete()
        db.query(Document).delete()
        db.query(AuditLog).delete()
        db.query(OperationRequest).delete()
        db.commit()

        creator = db.query(User).filter(User.email == "ops@opsflow.ai").first()
        manager = db.query(User).filter(User.email == "manager@opsflow.ai").first()
        created_requests: list[OperationRequest] = []
        for index, item in enumerate(DEMO_REQUESTS):
            request = OperationRequest(
                title=item["title"],
                request_type=item["request_type"],
                customer_name=item["customer_name"],
                account_number=item["account_number"],
                email=item["email"],
                description=item["description"],
                status=item["status"],
                risk_score=item["risk_score"],
                confidence=item["confidence"],
                decision=item["decision"],
                priority=item["priority"],
                sla_hours=item["sla_hours"],
                created_by_id=creator.id if creator else None,
            )
            db.add(request)
            db.flush()
            created_requests.append(request)
            db.add(
                Document(
                    request_id=request.id,
                    filename=f"demo-evidence-{request.id}.txt",
                    document_type="Demo Evidence",
                    extracted_text=item["description"],
                    summary=f"Demo evidence for {item['request_type']}",
                    entities_json=json.dumps({"customer": item["customer_name"], "reference": item["account_number"]}),
                )
            )
            citations = [{"title": POLICIES[index % len(POLICIES)][0], "source": "Enterprise Knowledge Base", "category": POLICIES[index % len(POLICIES)][1], "score": 0.91}]
            for step_index, (agent_name, message) in enumerate(DEMO_AGENT_MESSAGES[: item["completed_agents"]]):
                confidence = max(0.55, min(0.98, item["confidence"] or 0.82) - (step_index * 0.01))
                db.add(
                    WorkflowStep(
                        request_id=request.id,
                        agent_name=agent_name,
                        status="Completed",
                        message=message,
                        confidence=round(confidence, 2),
                        citations_json=json.dumps(citations),
                        reasoning=f"{agent_name} used request evidence, uploaded demo documents, and {citations[0]['title']} to progress {item['request_type']}.",
                        risk_factors_json=json.dumps(["Missing mandatory document"] if request.risk_score >= 45 else ["Low operational risk"]),
                    )
                )
            if item["approval"]:
                db.add(
                    Approval(
                        request_id=request.id,
                        status="Pending",
                        recommendation=item["decision"],
                        manager_summary=f"{item['request_type']} requires manager review due to risk {item['risk_score']} and confidence {round(item['confidence'] * 100)}%.",
                    )
                )
                db.add(
                    Notification(
                        request_id=request.id,
                        audience=manager.role if manager else "Operations Manager",
                        subject=f"Approval needed for OPS-{request.id:05d}",
                        body=f"{item['title']} is waiting for human approval.",
                    )
                )
            db.add(AuditLog(request_id=request.id, actor="Demo Mode", action="Demo workflow history generated", details=f"{item['title']} seeded at {item['status']}"))

        for agent in db.query(Agent).all():
            agent.status = "Active" if agent.name in {"Intake Agent", "Knowledge Agent", "Policy Validation Agent"} else "Idle"
            agent.current_task = "Processing demo operations queue" if agent.status == "Active" else "Monitoring queue"
            agent.processed_count = len(created_requests)
            agent.execution_time_ms = 900 + (len(agent.name) * 37)
            agent.confidence = 0.86
            agent.last_decision = "Demo workload processed with citations and audit history"

        db.add(AuditLog(actor="Demo Mode", action="Demo data reset", details=f"Generated {len(created_requests)} realistic operational workflows."))
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    seed()
