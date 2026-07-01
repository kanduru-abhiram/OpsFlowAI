def calculate_risk(description: str, request_type: str, citations: list[dict]) -> tuple[int, list[str]]:
    text = f"{description} {request_type}".lower()
    score = 18
    factors: list[str] = []
    if any(term in text for term in ["missing", "not attached", "unavailable", "pending"]):
        score += 25
        factors.append("Mandatory document appears to be missing")
    if any(term in text for term in ["nominee", "address", "account closure", "high value"]):
        score += 18
        factors.append("Sensitive banking operation")
    if any(term in text for term in ["pan", "aadhaar", "government id", "kyc"]):
        score += 12
        factors.append("KYC evidence required")
    if citations:
        score -= 6
        factors.append("Relevant SOP evidence found")
    if "closure" in text:
        score += 20
        factors.append("Account closure requires enhanced approval")
    return max(0, min(100, score)), factors or ["Standard operational risk"]
