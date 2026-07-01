from app.services.risk import calculate_risk


def test_missing_document_increases_risk() -> None:
    score, factors = calculate_risk("PAN card missing for nominee update", "Customer nominee update", [])
    assert score >= 55
    assert any("missing" in factor.lower() for factor in factors)
