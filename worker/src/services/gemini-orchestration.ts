import { ThinkingLevel, type ThinkingConfig } from "@google/genai";
import { env } from "../env";

export type ReasoningLevel = "low" | "medium" | "high";

function isGemini3Model(model: string): boolean {
  return model.startsWith("gemini-3");
}

export function getReasoningLevel(params: {
  difficulty?: string;
  inputChars?: number;
}): ReasoningLevel {
  const d = (params.difficulty || "").toLowerCase();
  const chars = params.inputChars ?? 0;

  if (d === "expert" || d === "hard" || chars > 7000) return "high";
  if (d === "medium" || chars > 2500) return "medium";
  return "low";
}

export function pickGeminiModel(level: ReasoningLevel): string {
  if (level === "high") return env.GEMINI_MODEL_COMPLEX;
  if (level === "medium") return env.GEMINI_MODEL_BALANCED;
  return env.GEMINI_MODEL_FAST;
}

export function buildGeminiThinkingConfig(model: string, level: ReasoningLevel): ThinkingConfig {
  if (isGemini3Model(model)) {
    const map: Record<ReasoningLevel, ThinkingLevel> = {
      low: ThinkingLevel.LOW,
      medium: ThinkingLevel.MEDIUM,
      high: ThinkingLevel.HIGH,
    };
    return { thinkingLevel: map[level] };
  }

  const budgetMap: Record<ReasoningLevel, number> = {
    low: env.GEMINI_THINKING_BUDGET_LOW,
    medium: env.GEMINI_THINKING_BUDGET_MEDIUM,
    high: env.GEMINI_THINKING_BUDGET_HIGH,
  };

  return { thinkingBudget: budgetMap[level] };
}
