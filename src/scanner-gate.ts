import { CandidateMetrics, QualificationResult, getSavedStrategyConfig, evaluateCandidate } from "./settings-v2";

export async function qualifyTokenForUser(pool: any, telegramId: number, token: CandidateMetrics): Promise<QualificationResult> {
  const config = await getSavedStrategyConfig(pool, telegramId);
  return evaluateCandidate(config, token);
}

export function formatQualification(result: QualificationResult): string {
  if (result.status === "PASS") return "PASS";
  const lines = [result.status];
  if (result.reasons.length) lines.push("Failed: " + result.reasons.join(", "));
  if (result.unknown.length) lines.push("Unknown: " + result.unknown.join(", "));
  return lines.join("\n");
}
