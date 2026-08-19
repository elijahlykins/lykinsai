# Online-Mind2Web — run `luna-smoke`

_Generated 2026-08-19T17:19:21.351Z._

> **These numbers are internally comparable across the four arms below and are NOT
> comparable to the published Online-Mind2Web leaderboard.** Different task subset,
> different judge configuration, different action space. The planner
> (`claude-opus-5`) and grounder (`holo3-1-35b-a3b`) are held fixed,
> so any difference between arms is attributable to the middle model or the grounding
> mode — which is the only question this eval is built to answer.

## Success rate

No judge verdicts found — run `scripts/eval/judge-mind2web.mjs --score` first.
Everything below is derived from the runs themselves and needs no judge.

## Run status

`waiting_for_user` and `crashed` are infrastructure outcomes, not agent failures.
Folding them into `failed` makes a harness problem look like a capability problem.

| arm | completed | crashed | failed | total |
|---|---|---|---|---|
| `luna-refs` | 2 | 1 | 2 | 5 |

## Per-stage latency (ms)

`decide` is the middle model — the stage this eval exists to compare. `ground` is
genuinely n=0 in the refs arms; an empty cell there means the stage does not run, not
that data is missing.

**`luna-refs`**

| stage | n | p50 | p95 | p99 | total s |
|---|---|---|---|---|---|
| plan | 5 | 6046 | 7292 | 7292 | 30.8 |
| settle | 14 | 327 | 11515 | 11515 | 42.6 |
| snapshot | 19 | 7 | 193 | 193 | 0.6 |
| screenshot | 3 | 33 | 34 | 34 | 0.1 |
| decide | 78 | 2810 | 6082 | 7703 | 248.2 |
| actuate | 74 | 1 | 15446 | 15811 | 125.8 |
| settle_after | 74 | 331 | 11537 | 38972 | 245.6 |
| observe_after | 46 | 8 | 178 | 674 | 1.7 |
| verify | 74 | 0 | 0 | 2443 | 4.7 |
| _task wall clock_ | 5 | 83800 | 225303 | 225303 | 585.7 |
| _harness overhead_ | 4 | 353 | 1097 | 1097 | 2.4 |

Settle hit its 8000 ms cap on 20/88 (22.7%) of settles. Those are the constant, not a measurement.

## Tokens and cost

| arm | calls | input tokens | output tokens | per task | per _successful_ task |
|---|---|---|---|---|---|
| `luna-refs` | 68 | 517,627 | 12,686 | 106,063 tok | — |

Tokens rather than dollars: per-token prices move, and the token counts are what we
actually measured. Multiply by the rate on the day.

## Harness interventions

The guard blocked an action in 1 of 5 runs.
**A run the guard steered is not a clean measurement of the agent** — these are
flagged rather than silently included.

| rule | blocks |
|---|---|
| outbound | 1 |

| arm | runs with a block |
|---|---|
| `luna-refs` | 1 |

## Method notes

- **Judge.** Verdicts come from the upstream WebJudge, run unmodified except for a
  pinned-key-points lookup, so the same task is scored against identical criteria in
  every arm. Measured judge-vs-human agreement is in `npm run eval:m2w:calibrate`;
  it is ~82%, not the ~85% usually quoted, and the errors are not symmetric. Read that
  before treating any absolute success rate as exact. Judge bias shifts all four arms
  together, so the paired comparisons remain the trustworthy part.
- **Blinding.** The judge never sees an arm id, model name, or grounding mode, and both
  aiming modes render into one action vocabulary. Verified per submission at judge time.
- **Ordering.** Arms were interleaved per task, not run one after another, so live-site
  drift lands as noise across all arms instead of as bias against the last one.
- **Retry rule, declared in advance.** A `crashed` or `harness_timeout` run is retried
  once; failing twice counts as a **failure**, not a drop. Dropping them would quietly
  favour whichever arm crashed most.
- **Memory off.** No durable per-site notes, so no task inherits another.
- **Sessions.** Every task ran in a fresh ephemeral partition; no logged-in state.

