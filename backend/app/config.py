from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    app_name: str = "OpsFlow AI"
    environment: str = "development"
    database_url: str = "sqlite:///./opsflow.db"
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 480
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4.1-mini"
    openai_embedding_model: str = "text-embedding-3-small"
    openai_vision_model: str = "gpt-4.1-mini"
    confidence_threshold: float = Field(default=0.78, ge=0, le=1)

    @field_validator("cors_origins")
    @classmethod
    def validate_cors_origins(cls, value: str) -> str:
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if not origins:
            raise ValueError("At least one CORS origin is required")
        return ",".join(origins)

    @model_validator(mode="after")
    def validate_production_security(self) -> "Settings":
        if self.environment.lower() == "production" and self.jwt_secret == "change-me-in-production":
            raise ValueError("JWT_SECRET must be set to a strong value in production")
        return self

@lru_cache
def get_settings() -> Settings:
    return Settings()
