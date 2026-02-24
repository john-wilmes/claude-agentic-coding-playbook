# Investigation Scorecard: {ID}

**Date**: {YYYY-MM-DD}
**Investigator**: {name or handle}
**Investigation question**: {one-line summary}

---

## Root Cause Accuracy (0–4)

Rate whether the agent's FINDINGS.md correctly identifies the root cause.

| Score | Meaning |
|-------|---------|
| 4 | **Exact** — correct file, line range, and mechanism |
| 3 | **Mechanism** — correct mechanism, location approximate or missing |
| 2 | **Subsystem** — correct subsystem, mechanism not identified |
| 1 | **Symptom** — described the symptom correctly, wrong root cause |
| 0 | **Miss** — wrong subsystem, or findings contain no meaningful analysis |

**Score**: ___/4

**Justification** (cite specific text from FINDINGS.md):

> {quote or paraphrase}

---

## Completeness (1–5)

Were all symptoms explained? Any important aspects left unaddressed?

**Score**: ___/5

**What was missing** (if score < 4):

---

## Efficiency (1–5)

Did the investigation converge appropriately, or was there wasted work?

| Score | Meaning |
|-------|---------|
| 5 | Converged in expected rounds, no obvious wasted agent dispatches |
| 3 | One extra round, or one agent dispatch produced nothing useful |
| 1 | Multiple wasted rounds, investigation wandered significantly |

**Score**: ___/5

**Inefficiency notes** (if score < 4):

---

## Surprises

Did the agent find anything you did not expect?
- [ ] Yes — describe: ___
- [ ] No

Did the agent miss anything you expected it to find?
- [ ] Yes — describe: ___
- [ ] No

---

## Biggest waste

Which agent task produced the least value this investigation?

**Agent type**: ___
**Round**: ___
**Why it was wasteful**:

---

## Missing skill

What should the agent have done that it didn't?
(Use this to inform dispatch function tuning.)

---

## Overall quality

**Composite**: (accuracy × 0.5) + (completeness/5 × 0.3) + (efficiency/5 × 0.2) = ___

**Would you trust this investigation's findings enough to act on them?**
- [ ] Yes, with high confidence
- [ ] Yes, but I'd verify the key finding first
- [ ] No, needs another round
- [ ] No, findings are unreliable

---

*Add this to eval-log.tsv: `{ID}\t{date}\t{accuracy}/4\t{completeness}/5\t{efficiency}/5\t{rounds}\t{evidence_count}\t{notes}`*
