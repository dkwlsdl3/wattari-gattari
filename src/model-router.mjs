function providerLabel(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

// Waga intentionally has no product-specific routing policy. The optional
// local-llm-router supplies the real decision at session creation time.
export function fallbackRouting({ provider = "codex", cwd = "" } = {}) {
  return {
    provider,
    model: null,
    effort: null,
    label: `${providerLabel(provider)} 기본값`,
    tier: "default",
    score: 0,
    confidence: "low",
    skills: [],
    reasons: ["local-llm-router 조회 전 provider 기본값 (+0)"],
    cwd: typeof cwd === "string" ? cwd : "",
    source: "waga-fallback",
  };
}

export function routingSummary(routing) {
  if (!routing) return "자동 라우팅: provider 기본값";
  const reason = [...(routing.reasons ?? [])].sort((a, b) => Number(b.startsWith("LLM 판정기")) - Number(a.startsWith("LLM 판정기"))).slice(0, 2).join(", ") || "provider 기본값 (+0)";
  const warning = routing.warnings?.length ? ` · 경고: ${routing.warnings[0]}` : "";
  const source = routing.source === "local-llm-router" ? "local-llm-router" : "기본값";
  return `자동 라우팅: ${routing.label} · ${source} · ${reason}${warning}`;
}
