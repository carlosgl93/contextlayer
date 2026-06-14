---
date: 2026-06-13
seq: "002"
type: feat
title: "feat: U5 cost model — multi-provider baseline"
origin: docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md (U5)
status: research-appendix
fused_into: docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md
---

# feat: U5 cost model — multi-provider baseline

> **Status (2026-06-13):** Actionable items (cost telemetry, dedup-in-U5, multi-provider cost preview in U2 phase 1, optimization levers) have been ported into the parent plan (`docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md` — see U2, U5, Appendix). This doc is retained as a research artifact: the math, scenario tables, sanity check, and post-launch optimization levers live here for future calibration.
>
> The 16GB Google Takeout problem section was dropped on 2026-06-13: a Gemini-only Takeout export is 10-100MB (well under the U2 50MB cap). The 16GB figure was a founder-export-misconfiguration (full Google account across 66 products), not a real product concern.

## Summary

**Cost-to-serve model** for U5 (MiniMax M3 extraction) across 5 user archetypes, anchored to a 2-3 provider baseline. Esto modela cuanto le cuesta a ContextLayer procesar la data de un usuario B2C, no pricing de B2C (B2C es free; B2B paga). Los rangos numericos son para (a) calibrar el cost preview en U2 fase 1 (transparencia para el usuario), y (b) informar el floor de pricing B2B en Track 3. Numeros son rangos, no promesas — recalibrar contra la primera importacion real del fundador antes de cerrar el modelo.

---

## Problem Frame

U5 is the only unit in the import pipeline that costs real money per user intake. U1–U4, U6–U8 are CPU + Firestore writes, both near-zero. The LLM call dominates the per-import bill and grows linearly with conversation count and raw text size. Two questions to answer before U5 ships:

1. **Per-user cost:** what does one import cost across realistic user archetypes, so the founder can size the business and decide whether to meter / cap / cover the cost.
2. **Google export size:** the founder's full Google Takeout is 16GB. U2 caps uploads at 50MB. Without a clear export-instructions UX, users will hand us multi-GB files that we cannot ingest.

The plan's deferred item (`Gemini import — Google Takeout includes toda la cuenta; complejidad de filtrado inviable para V1`) becomes a hard blocker rather than a nice-to-have once we acknowledge the UX.

### Multi-provider baseline assumption

The first version of this plan modeled single-provider scenarios (Claude OR ChatGPT OR Gemini). That undersells the realistic case. By 2026, the average user has tried multiple AI tools over the years — started with one (often ChatGPT or Gemini), moved to another (often Claude), accumulated a back catalog in each. The founder's own intake will be three providers: GPT, Claude, Gemini. A "1 provider" user is the exception, not the rule.

This changes the cost math: the typical first import is **2-3 providers in a single intake session**, not 1. Scenarios below reflect this — Scenario 2 (typical) is 2 providers, Scenario 3 (founder baseline) is 3. A single-provider user would land in Scenario 1.

---

## Cost Model

### Pricing assumptions (directional, from plan "Sources & Research")

- **Input:** $0.30–$0.70 per 1M tokens (range from plan; calibrate after first real call)
- **Output:** assume ~$1.50 per 1M tokens (typical 3-5x input markup; not stated in plan, **needs verification**)
- **Model:** `MiniMax-M3`, 1M token context window, baseURL `https://api.minimax.io/v1`

### Token estimation

- **Char-to-token ratio:** ~4 chars/token (English-text heuristic; holds for Claude export style)
- **System prompt + schema per batch:** ~800 tokens fixed overhead
- **Output per batch:** ~500-2000 tokens depending on signal density
- **Batch size:** 20 conversations default (`MINIMAX_BATCH_SIZE`)
- **Avg conversation size:** 9KB rawText (calibrated from founder's 208-conversation export: 1.9MB total / 208)

### Sanity check on founder's data (Claude provider only)

208 conversations × 9KB ≈ 1.9MB rawText ≈ 475K tokens. Fits in a single 1M-context call. The 20/batch default means 11 calls; the 1M context means 1 call is technically possible. The batch default is a cost-control knob, not a hard limit — see U5 calibration notes in the parent plan.

**Note:** the founder's *first real intake* will be 3 providers (Claude + ChatGPT + Gemini), not 1. Cost roughly triples from this baseline. The Scenario 3 row in the table below reflects the founder's actual end state.

---

## Scenarios

Five user archetypes spanning light to extreme, with **multi-provider as the default assumption** (see Problem Frame). Numbers are **per single import session** (one user, all providers they want to import in one go), not monthly.

| # | Archetype | Convos (per provider → total) | Providers | RawText | Tokens (in) | Batches | Input cost | Output cost | **Total** |
|---|-----------|-------------------------------|-----------|---------|-------------|---------|------------|-------------|-----------|
| 1 | Light (started on one AI, recently added a second) | 30+50 = 80 | 2 | 0.7 MB | ~180K | 4 | $0.05-0.13 | ~$0.01 | **$0.07-0.14** |
| 2 | Typical (2 providers, casual-to-moderate use over 1-2 years) | 100+150 = 250 | 2 | 2.3 MB | ~570K | 13 | $0.17-0.40 | ~$0.03 | **$0.20-0.43** |
| 3 | Founder baseline (3 providers, multi-year — Claude + ChatGPT + Gemini) | 200+200+200 = 600 | 3 | 5.4 MB | ~1.35M | 30 | $0.41-0.95 | ~$0.07 | **$0.47-1.01** |
| 4 | Power user (3 providers, heavy multi-year use) | 500+800+300 = 1,600 | 3 | 14.4 MB | ~3.6M | 80 | $1.08-2.52 | ~$0.18 | **$1.26-2.70** |
| 5 | Hoarder (3+ providers, decade+ of usage) | 2K+3K+1K = 6,000 | 3+ | 54 MB | ~13.5M | 300 | $4.05-9.45 | ~$0.68 | **$4.73-10.13** |

### Key observations

- **Sub-dollar for 60% of users (Scenarios 1-2).** Scenarios 1-2 cover light and typical users. Founder baseline (Scenario 3) ranges $0.47-1.01 — straddles the $1 threshold, with the upper bound driven by the worst-case input price ($0.70/M).
- **Multi-provider baseline shifts the curve.** First version of this plan modeled single-provider; that placed 90% of users under $2. The realistic 2-3-provider baseline places ~40% over $1.
- **Provider adds are linear, not synergistic.** Each provider is its own U5 pass; no shared work, no cost amortization across providers. A 3-provider intake ≈ 3x the per-provider cost.
- **Scenario 4-5 cross meaningful thresholds.** Power users ($1.27-2.70) and hoarders ($4.73-10.13) are real cost events. Worth deciding before launch whether we absorb, meter, or cap.
- **Output is small but not free.** ~6-15% of total cost in these scenarios. Worth measuring; if output pricing is higher than assumed, the picture shifts further.
- **The user's stated baseline (Claude + ChatGPT + Gemini, multi-year) is Scenario 3, not Scenario 2.** Anything in the product launch story that prices around "pennies per import" needs to qualify "per provider, casual user."

### Optimization levers (in priority order)

1. **Skip already-imported conversations per provider.** Dedupe on `(provider, providerId)`. A user who re-imports the same 3-provider dataset does not pay 3x again. **This is critical now** — without it, every re-import is a multi-dollar cost event, not a no-op. Should land with U5.
2. **Increase batch size for power users.** 1M context means 50-100 convos/batch is technically fine. Halves the overhead-driven cost for Scenario 3+.
3. **Cascade for outliers.** Scenario 4-5 users (1.5K+ convos) get a two-pass run: first pass summarizes at 10% size, second pass extracts from summaries. Cost ~30-50% of single-pass. Trades signal precision for cost.
4. **Pre-filter to "interesting" conversations.** Heuristic: skip convos <500 chars, skip all-tool-use assistant responses. Removes maybe 20-30% of token volume at zero quality cost.
5. **Per-provider batch sizing.** When the user has 3 providers, each provider's pass is sized independently. Small providers get smaller batches (less overhead); big providers get bigger batches (more amortization).

Levers 1 and 5 should land with U5. Levers 2-4 are post-launch and gated on actual cost telemetry.

---

---

## Open Questions (research-only; implementation questions ported to parent plan)

1. **Calibration after first real call.** Plan says "loggear tokens usados por call para calibrar costo". This is the first checkpoint. Re-run scenarios 1-3 against real numbers after the founder's first U5 import, adjust the model.
2. **Output token count from a real extraction.** Unknown. 500-2000 tokens per batch is a guess based on schema size + signal density. Real numbers after first call.

**Ported to parent plan (not tracked here):** output token pricing (verify with MiniMax), U2 multi-file shape, dedup-in-U5 vs U6, per-provider batch sizing. See `docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md` U2 and U5 sections.

---

## Verification

- After U5 ships against the founder's data: log actual input/output token counts for a 3-provider import (~600 convos). Compare to Scenario 3's predicted 1.35M input / 30K output. Adjust model.
- Cost scenarios are revisited after every 50 real imports or quarterly, whichever comes first.
- Phase 1 cost preview shape and multi-file aggregation tests live in the parent plan U2 verification, not here.

---

## Deferred to Follow-Up Work

- Per-user cost metering and billing (Track 3+ — not a PoC concern).
- Cascade summarization for Scenario 4-5 outliers (only if real users hit those tiers).
- Server-side streaming ZIP parse for >50MB exports (not justified by the long tail — the 16GB Takeout founder-misuse case was the only driver and that scenario is now out of scope).
- Adaptive batch size by user tier (premise: most users stay in Scenarios 1-3; revisit if Scenario 4+ adoption grows).

---

## Sources

- Parent plan U5: `docs/plans/2026-06-13-001-feat-importacion-pipeline-plan.md` (U5 + Sources & Research section)
- Founder's actual data: `data-1ce0e1e5-88a7-40f9-9c82-e36ebac60a13-1781361730-7eca1830-batch-0000.zip` (208 conversations, 1.9MB rawText, spot-checked at `2026-06-13` per U3 commit `0c55dc2`)
- MiniMax M3 pricing range: parent plan "Sources & Research" (input only)
- Multi-provider baseline assumption: founder's own intake (Claude + ChatGPT + Gemini) and `multi-provider-baseline` memory note (`/Users/consultor/.claude/projects/-Users-consultor-cgl-contextlayer/memory/multi-provider-baseline.md`)
