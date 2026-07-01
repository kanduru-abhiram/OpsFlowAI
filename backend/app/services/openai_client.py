import base64
import json
import time
from collections.abc import Callable, Iterator
from typing import Any, TypeVar

from openai import OpenAI, OpenAIError
from pydantic import BaseModel

from app.config import get_settings

T = TypeVar("T", bound=BaseModel)


class OpenAIConfigurationError(RuntimeError):
    pass


class OpenAIService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.client = OpenAI(api_key=self.settings.openai_api_key) if self.settings.openai_api_key else None

    def require_client(self) -> OpenAI:
        if not self.client:
            raise OpenAIConfigurationError("OPENAI_API_KEY is required for AI orchestration, embeddings, and image extraction.")
        return self.client

    def enabled(self) -> bool:
        return self.client is not None

    def _retry(self, operation: Callable[[], Any], attempts: int = 3) -> Any:
        last_error: Exception | None = None
        for attempt in range(attempts):
            try:
                return operation()
            except (OpenAIError, TimeoutError) as exc:
                last_error = exc
                if attempt == attempts - 1:
                    break
                time.sleep(0.7 * (2**attempt))
        raise RuntimeError(f"OpenAI request failed after {attempts} attempts: {last_error}") from last_error

    def embed(self, text: str) -> list[float]:
        client = self.require_client()

        def operation() -> list[float]:
            response = client.embeddings.create(model=self.settings.openai_embedding_model, input=text[:12000])
            return list(response.data[0].embedding)

        return self._retry(operation)

    def structured_response(self, *, instructions: str, payload: dict[str, Any], schema_name: str, json_schema: dict[str, Any], max_tokens: int = 1600) -> dict[str, Any]:
        client = self.require_client()

        def operation() -> dict[str, Any]:
            response = client.responses.create(
                model=self.settings.openai_model,
                instructions=instructions,
                input=json.dumps(payload, ensure_ascii=False),
                text={
                    "format": {
                        "type": "json_schema",
                        "name": schema_name,
                        "schema": json_schema,
                        "strict": True,
                    }
                },
                max_output_tokens=max_tokens,
            )
            return json.loads(response.output_text)

        return self._retry(operation)

    def stream_text(self, *, instructions: str, payload: dict[str, Any]) -> Iterator[str]:
        client = self.require_client()
        stream = client.responses.create(
            model=self.settings.openai_model,
            instructions=instructions,
            input=json.dumps(payload, ensure_ascii=False),
            stream=True,
        )
        for event in stream:
            if event.type == "response.output_text.delta":
                yield event.delta

    def text_response(self, *, instructions: str, payload: dict[str, Any], max_tokens: int = 900) -> str:
        client = self.require_client()

        def operation() -> str:
            response = client.responses.create(
                model=self.settings.openai_model,
                instructions=instructions,
                input=json.dumps(payload, ensure_ascii=False),
                max_output_tokens=max_tokens,
            )
            return response.output_text.strip()

        return self._retry(operation)

    def extract_image_text(self, *, filename: str, content_type: str, raw: bytes) -> str:
        client = self.require_client()
        b64 = base64.b64encode(raw).decode("ascii")
        data_url = f"data:{content_type};base64,{b64}"

        def operation() -> str:
            response = client.responses.create(
                model=self.settings.openai_vision_model,
                instructions=(
                    "Extract all readable text and key entities from this operations document image. "
                    "Return plain text only, preserving account numbers, names, dates, tables, and IDs."
                ),
                input=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": f"Parse uploaded image document: {filename}"},
                            {"type": "input_image", "image_url": data_url},
                        ],
                    }
                ],
                max_output_tokens=1400,
            )
            return response.output_text.strip()

        return self._retry(operation)
