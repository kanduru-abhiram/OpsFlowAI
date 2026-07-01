import os

os.environ["OPENAI_API_KEY"] = ""

from fastapi.testclient import TestClient

import app.main as main_module
from agents import AgentOutputSchema
from app.database import SessionLocal
from app.main import app
from app.models import Notification, OperationRequest, RequestStatus, User
from app.services.orchestrator import AgentStepOutput
from seed import seed


client = TestClient(app)


def auth_headers(email: str = "manager@opsflow.ai", password: str = "password123") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def auth_token(email: str = "manager@opsflow.ai", password: str = "password123") -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return response.json()["access_token"]


def setup_module() -> None:
    seed()


def test_login_rejects_bad_credentials() -> None:
    response = client.post("/api/auth/login", json={"email": "manager@opsflow.ai", "password": "wrong-password"})
    assert response.status_code == 401


def test_request_validation_rejects_short_payload() -> None:
    response = client.post(
        "/api/requests",
        headers=auth_headers(),
        json={"title": "x", "request_type": "y", "customer_name": "z", "account_number": "1", "email": "bad", "description": "tiny"},
    )
    assert response.status_code == 422


def test_request_crud_and_rbac_delete() -> None:
    payload = {
        "title": "Production readiness test request",
        "request_type": "Customer profile update",
        "customer_name": "Ready User",
        "account_number": "AC-900100",
        "email": "ready.user@example.com",
        "description": "Validate customer profile update with complete supporting evidence.",
    }
    created = client.post("/api/requests", headers=auth_headers(), json=payload)
    assert created.status_code == 200
    request_id = created.json()["id"]

    viewer_delete = client.delete(f"/api/requests/{request_id}", headers=auth_headers("viewer@opsflow.ai"))
    assert viewer_delete.status_code == 403

    updated = client.put(f"/api/requests/{request_id}", headers=auth_headers(), json={"sla_hours": 12})
    assert updated.status_code == 200
    assert updated.json()["sla_hours"] == 12

    deleted = client.delete(f"/api/requests/{request_id}", headers=auth_headers())
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "deleted"


def test_notification_visibility_and_mark_read_authorization() -> None:
    db = SessionLocal()
    try:
        manager_note = Notification(audience="Operations Manager", subject="Manager only", body="Approval required")
        viewer_note = Notification(audience="Viewer", subject="Viewer only", body="Read-only notification")
        db.add_all([manager_note, viewer_note])
        db.commit()
        db.refresh(manager_note)
        db.refresh(viewer_note)

        viewer_notifications = client.get("/api/notifications", headers=auth_headers("viewer@opsflow.ai"))
        assert viewer_notifications.status_code == 200
        subjects = {item["subject"] for item in viewer_notifications.json()}
        assert "Viewer only" in subjects
        assert "Manager only" not in subjects

        forbidden = client.post(f"/api/notifications/{manager_note.id}/read", headers=auth_headers("viewer@opsflow.ai"))
        assert forbidden.status_code == 403

        allowed = client.post(f"/api/notifications/{viewer_note.id}/read", headers=auth_headers("viewer@opsflow.ai"))
        assert allowed.status_code == 200
    finally:
        db.query(Notification).filter(Notification.subject.in_(["Manager only", "Viewer only"])).delete(synchronize_session=False)
        db.commit()
        db.close()


def test_admin_user_management_and_non_admin_forbidden() -> None:
    unique_email = "rbac.user@example.com"
    forbidden = client.get("/api/users", headers=auth_headers("manager@opsflow.ai"))
    assert forbidden.status_code == 403

    created = client.post(
        "/api/users",
        headers=auth_headers("admin@opsflow.ai"),
        json={
            "name": "RBAC Test User",
            "email": unique_email,
            "password": "securepass123",
            "role": "Viewer",
            "department": "Enterprise PMO",
            "is_active": True,
        },
    )
    assert created.status_code == 200
    user_id = created.json()["id"]

    updated = client.put(
        f"/api/users/{user_id}",
        headers=auth_headers("admin@opsflow.ai"),
        json={"role": "Operations Executive", "department": "Shared Services"},
    )
    assert updated.status_code == 200
    assert updated.json()["role"] == "Operations Executive"

    deleted = client.delete(f"/api/users/{user_id}", headers=auth_headers("admin@opsflow.ai"))
    assert deleted.status_code == 200


def test_chat_greeting_and_knowledge_fallback() -> None:
    greeting = client.post("/api/chat", headers=auth_headers(), json={"message": "good morning", "history": []})
    assert greeting.status_code == 200
    assert "Good day" in greeting.json()["answer"]

    technical = client.post("/api/chat", headers=auth_headers(), json={"message": "What documents are required for nominee update?", "history": []})
    assert technical.status_code == 200
    assert technical.json()["answer"]


def test_profile_settings_update_and_self_deactivation_rules() -> None:
    cleanup = SessionLocal()
    try:
        existing = cleanup.query(User).filter(User.email == "profile.settings@example.com").first()
        if existing:
            cleanup.query(OperationRequest).filter(OperationRequest.created_by_id == existing.id).update({"created_by_id": None})
            cleanup.delete(existing)
            cleanup.commit()
    finally:
        cleanup.close()

    created = client.post(
        "/api/users",
        headers=auth_headers("admin@opsflow.ai"),
        json={
            "name": "Profile Settings User",
            "email": "profile.settings@example.com",
            "password": "securepass123",
            "role": "Viewer",
            "department": "Enterprise PMO",
            "is_active": True,
        },
    )
    assert created.status_code == 200

    viewer_headers = auth_headers("profile.settings@example.com", "securepass123")
    updated = client.put("/api/profile", headers=viewer_headers, json={"name": "Updated Profile User", "department": "Audit Office"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Updated Profile User"
    assert updated.json()["department"] == "Audit Office"
    assert updated.json()["role"] == "Viewer"

    admin_delete = client.delete("/api/profile", headers=auth_headers("admin@opsflow.ai"))
    assert admin_delete.status_code == 400

    deactivated = client.delete("/api/profile", headers=viewer_headers)
    assert deactivated.status_code == 200

    inactive_login = client.post("/api/auth/login", json={"email": "profile.settings@example.com", "password": "securepass123"})
    assert inactive_login.status_code == 401
    user_id = created.json()["id"]
    cleanup_delete = client.delete(f"/api/users/{user_id}", headers=auth_headers("admin@opsflow.ai"))
    assert cleanup_delete.status_code == 200


def test_viewer_cannot_create_request_and_executive_sees_only_own_requests() -> None:
    viewer_create = client.post(
        "/api/requests",
        headers=auth_headers("viewer@opsflow.ai"),
        json={
            "title": "Viewer forbidden request",
            "request_type": "Access request",
            "customer_name": "Viewer User",
            "account_number": "AC-VIEW-1",
            "email": "viewer.user@example.com",
            "description": "A viewer should not be able to create operational requests.",
        },
    )
    assert viewer_create.status_code == 403

    manager_payload = {
        "title": "Manager visible only to broad roles",
        "request_type": "Vendor onboarding",
        "customer_name": "Manager User",
        "account_number": "AC-MGR-1",
        "email": "manager.user@example.com",
        "description": "Manager-owned request for RBAC visibility checks.",
    }
    executive_payload = {
        "title": "Executive owned request",
        "request_type": "Address correction",
        "customer_name": "Executive User",
        "account_number": "AC-OPS-1",
        "email": "executive.user@example.com",
        "description": "Executive-owned request for RBAC visibility checks.",
    }
    manager_created = client.post("/api/requests", headers=auth_headers("manager@opsflow.ai"), json=manager_payload)
    executive_created = client.post("/api/requests", headers=auth_headers("ops@opsflow.ai"), json=executive_payload)
    assert manager_created.status_code == 200
    assert executive_created.status_code == 200
    manager_id = manager_created.json()["id"]
    executive_id = executive_created.json()["id"]

    try:
        executive_list = client.get("/api/requests", headers=auth_headers("ops@opsflow.ai"))
        assert executive_list.status_code == 200
        ids = {item["id"] for item in executive_list.json()}
        assert executive_id in ids
        assert manager_id not in ids

        forbidden_update = client.put(f"/api/requests/{manager_id}", headers=auth_headers("ops@opsflow.ai"), json={"priority": "High"})
        assert forbidden_update.status_code == 403
    finally:
        client.delete(f"/api/requests/{manager_id}", headers=auth_headers("manager@opsflow.ai"))
        client.delete(f"/api/requests/{executive_id}", headers=auth_headers("manager@opsflow.ai"))


def test_workflow_projection_and_demo_reset() -> None:
    reset = client.post("/api/demo/reset", headers=auth_headers("manager@opsflow.ai"))
    assert reset.status_code == 200
    workflows = client.get("/api/workflows", headers=auth_headers("manager@opsflow.ai"))
    assert workflows.status_code == 200
    payload = workflows.json()
    assert len(payload) >= 5
    assert len(payload[0]["stages"]) == 10
    assert {"name", "agentName", "state", "executionTimeMs", "confidence"}.issubset(payload[0]["stages"][0].keys())


def test_workflow_websocket_streams_status_and_completion(monkeypatch) -> None:
    def fake_execute_workflow(db, request: OperationRequest, on_event=None):
        request.status = RequestStatus.completed.value
        db.commit()
        if on_event:
            on_event({"type": "workflow.status", "status": RequestStatus.running.value, "requestId": request.id})
            on_event({"type": "workflow.completed", "status": RequestStatus.completed.value, "requestId": request.id, "decision": "Approve", "riskScore": 12})
        return request

    monkeypatch.setattr(main_module, "execute_workflow", fake_execute_workflow)
    payload = {
        "title": "WebSocket workflow test request",
        "request_type": "Address correction",
        "customer_name": "Socket User",
        "account_number": "AC-WS-100",
        "email": "socket.user@example.com",
        "description": "Validate that workflow WebSocket streams status events to the browser.",
    }
    created = client.post("/api/requests", headers=auth_headers(), json=payload)
    assert created.status_code == 200
    request_id = created.json()["id"]

    try:
        with client.websocket_connect(f"/ws/requests/{request_id}/workflow?token={auth_token()}") as websocket:
            ready = websocket.receive_json()
            assert ready["type"] == "connection.ready"

            websocket.send_json({"type": "workflow.start"})
            status = websocket.receive_json()
            completed = websocket.receive_json()

        assert status["type"] == "workflow.status"
        assert status["status"] == RequestStatus.running.value
        assert completed["type"] == "workflow.completed"
        assert completed["status"] == RequestStatus.completed.value
    finally:
        client.delete(f"/api/requests/{request_id}", headers=auth_headers())


def test_agent_output_schema_allows_context_passing() -> None:
    schema = AgentOutputSchema(AgentStepOutput, strict_json_schema=False)
    assert schema.is_strict_json_schema() is False
