import json
import math

from sqlalchemy.orm import Session

from app.models import KnowledgeItem
from app.services.openai_client import OpenAIService


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / ((math.sqrt(sum(x * x for x in a)) or 1.0) * (math.sqrt(sum(y * y for y in b)) or 1.0))


def embed_text(text: str) -> list[float]:
    return OpenAIService().embed(text)


def _embedding_for_storage(content: str, require_embedding: bool) -> str:
    if not require_embedding:
        return "[]"
    return json.dumps(embed_text(content))


def upsert_knowledge(db: Session, title: str, category: str, content: str, source: str, *, require_embedding: bool = True) -> KnowledgeItem:
    item = KnowledgeItem(title=title, category=category, content=content, source=source, embedding_json=_embedding_for_storage(content, require_embedding))
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def ensure_embedding(db: Session, item: KnowledgeItem) -> list[float]:
    embedding = json.loads(item.embedding_json or "[]")
    if embedding and len(embedding) > 128:
        return embedding
    embedding = embed_text(item.content)
    item.embedding_json = json.dumps(embedding)
    db.commit()
    return embedding


def search_knowledge(db: Session, query: str, limit: int = 5) -> list[dict]:
    query_embedding = embed_text(query)
    results = []
    for item in db.query(KnowledgeItem).all():
        item_embedding = ensure_embedding(db, item)
        score = cosine(query_embedding, item_embedding)
        results.append(
            {
                "id": item.id,
                "title": item.title,
                "category": item.category,
                "source": item.source,
                "content": item.content,
                "score": round(score, 4),
            }
        )
    return sorted(results, key=lambda row: row["score"], reverse=True)[:limit]
