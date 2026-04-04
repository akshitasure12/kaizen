# Kaizen Judge Agent

This document defines the runtime judge agent used by Kaizen to score code outcomes for issues and bounties.

## Runtime source of truth

- Backend policy module: backend/src/services/judge-agent.ts
- Worker policy module: worker/src/services/judge-agent.ts
- Backend judge execution: backend/src/services/judge.ts
- Worker judge execution: worker/src/services/judge.ts

The judge agent is defined in code, not in .github meta customization files.

## Judge contract

The judge must:

1. Use only provided evidence (submission text, diff, tool logs, scorecard).
2. Grade conservatively when evidence is missing.
3. Prioritize correctness and requirement coverage over verbosity or style.
4. Return strict JSON matching the schema contract.
5. Keep reasoning auditable and actionable.

Current output schema:

- passed_tests: string[]
- failed_tests: string[]
- bonus_achieved: string[]
- bonus_missed: string[]
- code_quality_score: integer 1-10
- reasoning: string
- suggestions: string[]

## Scoring rubric

The judge rubric is encoded in the prompt policy and should remain stable across backend and worker:

1. Requirement and test alignment (40%)
2. Correctness and logic (30%)
3. Reliability and safety (20%)
4. Maintainability and clarity (10%)

## Why this design

The structure follows practical evaluator guidance:

- Use clear, detailed rubrics and calibrate against human review over time.
- Prefer structured outputs to reduce parser errors and schema drift.
- Treat LLM judges as strong but fallible: mitigate position/verbosity bias and guard against reward hacking.
- Keep judge reasoning grounded with citations/evidence discipline, and allow uncertainty instead of forced certainty.

## Best-practice calibration loop

1. Collect production failures and edge cases into a judge eval set.
2. Run judge-vs-human agreement checks on a fixed slice weekly.
3. Track disagreement by category: reasoning, math, security, tests, docs-only diffs.
4. Add adversarial slices:
   - Same answer reordered
   - Same answer made longer without new information
   - Conflicting tool evidence vs stated claims
5. Patch policy, not just thresholds:
   - Tighten evidence requirements
   - Clarify failure behavior for missing proof
   - Add examples for common false positives/negatives

## Pairwise evaluation note

Kaizen currently uses single-answer grading in runtime judge flows.

If pairwise judging is introduced, use balanced-position calibration:

1. Score (A, B)
2. Score (B, A)
3. Only declare a strong win when both agree, otherwise tie or manual review

## References

- OpenAI Evaluation Best Practices: https://developers.openai.com/api/docs/guides/evaluation-best-practices
- OpenAI Graders Guide: https://developers.openai.com/api/docs/guides/graders
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic Reduce Hallucinations: https://platform.claude.com/docs/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
- MT-Bench LLM-as-a-Judge (biases and mitigations): https://arxiv.org/abs/2306.05685
- LLM Evaluator Fairness / order bias: https://arxiv.org/abs/2305.17926
