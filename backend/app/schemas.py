from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    role: str
    department: str
    is_active: bool


class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Literal["Administrator", "Operations Manager", "Operations Executive", "Viewer"]
    department: str = Field(default="Operations", min_length=2, max_length=120)
    is_active: bool = True


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    email: EmailStr | None = None
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: Literal["Administrator", "Operations Manager", "Operations Executive", "Viewer"] | None = None
    department: str | None = Field(default=None, min_length=2, max_length=120)
    is_active: bool | None = None


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    email: EmailStr | None = None
    department: str | None = Field(default=None, min_length=2, max_length=120)
    password: str | None = Field(default=None, min_length=8, max_length=128)


class RequestCreate(BaseModel):
    title: str = Field(min_length=3, max_length=255)
    request_type: str = Field(min_length=3, max_length=120)
    customer_name: str = Field(min_length=2, max_length=120)
    account_number: str = Field(min_length=3, max_length=80)
    email: EmailStr
    description: str = Field(min_length=8, max_length=8000)


class RequestUpdate(BaseModel):
    title: str | None = None
    request_type: str | None = None
    customer_name: str | None = None
    account_number: str | None = None
    email: EmailStr | None = None
    description: str | None = None
    department: str | None = None
    priority: str | None = None
    sla_hours: int | None = Field(default=None, ge=1, le=720)
    status: str | None = None


class RequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    request_type: str
    customer_name: str
    account_number: str
    email: str
    description: str
    department: str
    priority: str
    sla_hours: int
    status: str
    risk_score: int
    confidence: float
    decision: str
    created_at: datetime
    updated_at: datetime


class KnowledgeCreate(BaseModel):
    title: str = Field(min_length=3, max_length=255)
    category: str = Field(min_length=2, max_length=120)
    content: str = Field(min_length=10, max_length=50000)
    source: str = Field(default="Uploaded Policy", max_length=255)


class KnowledgeUpdate(BaseModel):
    title: str | None = None
    category: str | None = None
    content: str | None = None
    source: str | None = None


class KnowledgeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    category: str
    source: str
    content: str
    created_at: datetime


class ApprovalDecision(BaseModel):
    decision: Literal["Approved", "Rejected", "Request More Information"]
    notes: str = Field(default="", max_length=4000)


class WorkflowStepOut(BaseModel):
    id: int
    request_id: int
    agent_name: str
    status: str
    message: str
    confidence: float
    citations: list[dict[str, Any]]
    reasoning: str
    risk_factors: list[str]
    created_at: datetime


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=12)


class ChatResponse(BaseModel):
    answer: str
    citations: list[dict[str, Any]] = Field(default_factory=list)
