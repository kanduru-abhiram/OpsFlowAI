from dataclasses import dataclass

from app.config import get_settings


@dataclass(frozen=True)
class AgentSpec:
    name: str
    instructions: str


AGENT_SPECS = [
    AgentSpec("Intake Agent", "Extract request intent, metadata, entities, and uploaded document summaries."),
    AgentSpec("Classification Agent", "Classify operation type, department, priority, and SLA."),
    AgentSpec("Knowledge Agent", "Retrieve SOPs, policies, and business rules with citations."),
    AgentSpec("Policy Validation Agent", "Validate mandatory requirements and explain compliance reasoning."),
    AgentSpec("Decision Agent", "Recommend approve, reject, or request more information with confidence."),
    AgentSpec("Exception Agent", "Identify missing evidence, policy violations, and corrective actions."),
    AgentSpec("Ticket Agent", "Create enterprise work item details and owner recommendations."),
    AgentSpec("Communication Agent", "Draft customer, internal, and manager communications."),
    AgentSpec("Audit Agent", "Produce audit timeline, evidence mapping, and decision history."),
    AgentSpec("Manager Agent", "Summarize business impact, risk, and approval recommendation."),
]


def agents_sdk_available() -> bool:
    if not get_settings().openai_api_key:
        return False
    try:
        import agents  # noqa: F401
    except Exception:
        return False
    return True


def describe_agent_runtime() -> dict[str, object]:
    return {
        "mode": "openai-agents-sdk" if agents_sdk_available() else "openai-api-key-required",
        "agents": [spec.__dict__ for spec in AGENT_SPECS],
        "supports": ["handoffs", "tool-ready orchestration", "policy citations", "human approvals", "audit tracing"],
    }
