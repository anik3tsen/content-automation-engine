# Rollout and measurement

## The rollout path

Rollout is set in [config/pipeline.json](../config/pipeline.json):

```json
"rollout": { "mode": "assisted", "aiDrafting": true }
```

The path is **shadow → assisted → default**. The manual path stays open in every mode: set
`aiDrafting` to `false`.

Two details matter:

- `mode` is stamped on each job when it is submitted (`job.mode`). A change applies to new jobs only.
- `aiDrafting` is read from the engine's config, which is loaded when `Engine.create` runs. After a restart, the new value applies to every open job too.

In every mode, the gates (G1 to G4), the rule checks, pre-publish QA and the live check run the same way.

### Shadow

People write the copy. The AI drafts in the background, and its drafts are kept for comparison.

- The draft and rule-checks stages run as usual ([draft.ts](../src/stages/draft.ts) checks `aiDrafting` only). Blocked variants are drafted again, and `counters.ruleBlocks` counts them.
- At G2, [gates.ts](../src/core/gates.ts) requires written copy (`fields`) for every placement. A selection with only a `variantId` is refused with "write the copy (shadow mode)".
- The approved placement gets `finalSource: 'human'`.
- `editRatio` compares the human copy with the first AI variant that has no blocking violation. 0 means the person wrote the same text as the AI. 1 means nothing in common. When no AI variant passed the rules, there is no reference and `editRatio` stays undefined.
- The UI ([public/app.js](../public/app.js)) hides the variants at G2 and says: "Shadow mode: the AI drafts are hidden and kept for comparison. Write the copy as usual."

Shadow mode answers one question: would the AI drafts have been close to what people wrote anyway? The
report stage answers it with `shadowSimilarity`: the average of `1 - editRatio` over hand-written
placements that had an AI reference. It is `null` when no placement had one. It reaches `metrics.jsonl`
and the per-job report. A placement that a reviewer writes by hand in assisted mode, with a passing AI
variant available, is counted in `shadowSimilarity` too.

### Assisted

People start from the AI drafts.

- The G2 screen shows the variants, with any violations and the trace (prompt version, model id and version, input hash).
- The reviewer selects a variant and can edit it. The approved placement gets `finalSource: 'ai-selected'` when the text is unchanged (`editRatio` 0), or `'ai-edited'` when it was changed.
- The reviewer can also write the copy without a variant. That placement gets `finalSource: 'human'`.
- A placement where every variant still fails after `drafting.maxAutoRetries` reaches G2 with the failures shown. The reviewer writes that copy.
- "Changes required" at G2 sends the notes back to drafting and adds one to `reviewRounds`.
- A send-back from G4 (to G2 or G3) adds one to `sendBacks`. It does not change `reviewRounds`.

### Default

`default` is a label only. No branch in the code checks for it, so the engine behaves as in `assisted`.
The difference is in how the team works: the AI path is the standard route for every request. Because
`mode` is stamped on each job and copied into its report, you can still compare the periods before and
after the switch.

### The manual path and kill switch

Set `"aiDrafting": false` and restart the server.

- The draft stage is skipped with the note "AI drafting is off: people write the copy (manual path)". No secondary-locale AI draft is written either.
- The rule-checks stage has nothing to check.
- G2 requires written copy, as in shadow mode. The UI says "Manual path: AI drafting is off."
- Every gate, rule and QA check still runs on the copy people write.

Use it as a kill switch when the model misbehaves or the model provider is down. Jobs waiting at G2
keep their existing drafts in the job file, but G2 then requires written copy for them too.

## Go or no-go: assisted to default

A suggested gate before you move from assisted to default. Agree on the review period and the number of
requests before you start.

| Criterion | Pass when | Metric from the report stage |
|---|---|---|
| Quality equal to human-only work | Assisted jobs are no worse than human-only jobs | `errorsAtPublish`, `reviewRounds` and `sendBacks`, split by `mode` (shadow or manual-path jobs as the baseline). Brand compliance comes from the blind audit, a process step. |
| Zero fact errors | No wrong fact reaches a customer | `errorsAtPublish` is 0 on every job. Also check that no job has an entry in `incidents` (in the job file, not in the report). |
| 60% or more of drafts need light edits only | Light edits only, in the first round, on at least 60% of AI-based placements | `firstPassAcceptance` ≥ 0.6. Pool across jobs: weight each job by `aiAssistedPlacements`. |

How these metrics work:

- `firstPassAcceptance` is the share of AI-based approved placements with `editRatio` at or below `qa.lightEditThreshold` (0.2 in the shipped config). It counts the first round only: when a job had a "changes required" round at G2 (`reviewRounds` > 0), it is 0. It is `null` when no approved placement is AI-based, as in shadow mode and the manual path. A G4 send-back does not change it; watch `sendBacks` for that.
- `editRatio` is the edit distance between the AI text and the approved text, divided by the length of the longer one ([src/rules/text.ts](../src/rules/text.ts)).
- `errorsAtPublish` is the number of blocking failures in the live check ([postpublish-check.ts](../src/stages/postpublish-check.ts)): a content-store entry whose status or published version does not match what was approved, or an ad export or creative hand-off whose `verify()` returns false.
- Fact rules (`material_claim`, `price_and_offer`, `missing_fact`, `unresolved_slot`) block approval at G2 and G3, and block publishing in pre-publish QA. `ruleBlocksCaught` counts the AI variants they stopped before review. A high number is not a failure. It shows the rules at work.
- A wrong fact found after publishing is recorded through `Engine.revert` as an entry in `job.incidents`.

## KPIs

Quality comes first.

| # | KPI | Computed by the code? | Where |
|---|---|---|---|
| 1 | Errors at publish | Yes | `errorsAtPublish` in [report.ts](../src/stages/report.ts), from `job.postCheck.blocking` set by [postpublish-check.ts](../src/stages/postpublish-check.ts). Incidents after publishing are in `job.incidents`. |
| 2 | Brand compliance | No. Process step. | A blind audit of published copy by editors. The code supports it with the human sample in pre-publish QA (`qa.humanSampleSize`, and every secondary-locale item until `audit.secondaryFullAuditUntil`). |
| 3 | First-pass acceptance | Yes | `firstPassAcceptance` in [report.ts](../src/stages/report.ts): light edits only (`qa.lightEditThreshold`), first round only. It is 0 after a "changes required" round. `editRatio` is set at G2 in [gates.ts](../src/core/gates.ts). In shadow mode, `shadowSimilarity` is the comparison instead. |
| 4 | Turnaround | Yes | `turnaroundHours` in [report.ts](../src/stages/report.ts): from request submitted to the G4 decision. For a scheduled job this ends at the decision, not at the go-live time. `stageMinutes` gives the time in each stage. For a gate, this is the time it waited for a person. |
| 5 | Effort per copy set | No. Process step. | A time sample: people log the time they actually spend on a sample of requests. `stageMinutes` measures elapsed time, not effort. |
| 6 | Adoption | No. Process step. | Compare requests through the form with all copy requests the team received. The code knows only the form side: the job store (`GET /api/jobs`) lists every request, including rejected ones. `aiAssistedPlacements` and `humanWrittenPlacements` show how much of the approved copy started from AI. |
| 7 | Commercial result | No. Process step. | An A/B test in the ad platform or your analytics tool. Each output carries a `versionHash`, and each AI variant carries a trace, so a test result can be tied back to the exact copy. |

## Where the numbers go

**metrics.jsonl.** The report stage runs after the live check. It builds a `JobReport` and passes it to
the `MetricsSink`. The local sink keeps one JSON line per job in `data/runtime/metrics.jsonl`. Each line has:

`jobId`, `mode`, `turnaroundHours`, `stageMinutes`, `reviewRounds`, `sendBacks`, `firstPassAcceptance`,
`shadowSimilarity`, `ruleBlocksCaught`, `errorsAtPublish`, `aiAssistedPlacements`,
`humanWrittenPlacements`, `outputs`.

When reading the file:

- Only jobs that reach the report stage appear. Jobs rejected at intake or G1, or still in progress, do not.
- Each job appears once. When `retryDeferred` recovers an output after the job was reported, the live check and the report run again, and the new report replaces the job's earlier line. The sink writes under a lock, so two reports at the same moment cannot overwrite each other.

**The per-job markdown report.** The report stage also writes `data/runtime/reports/<jobId>.md`. It has
a table with errors at publish, rule blocks caught, review rounds at G2, send-backs from G4, first-pass
acceptance, turnaround, the AI-assisted and human-written counts, and shadow similarity. It also lists the
minutes per stage and the status of each output.

Set `CAE_RUNTIME_DIR` to write these files somewhere else. To send the reports to a dashboard, replace the
`MetricsSink` (see [connectors.md](connectors.md#metricssink)).
