from app.services.rag import cosine


def test_cosine_similarity_prefers_aligned_vectors() -> None:
    query = [1.0, 1.0, 0.0]
    related = [0.9, 0.8, 0.0]
    unrelated = [0.0, 0.0, 1.0]
    assert cosine(query, related) > cosine(query, unrelated)
