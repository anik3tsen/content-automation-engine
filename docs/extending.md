# Extending the engine

Each recipe lists the files to touch and the test to write. Run `npm run check` (type check and tests)
after each change. CI also runs `npm run demo -- --scenario all --quiet`.

Settings are read once, when `Engine.create` runs. Restart the server after you change a file in `config/`
or `prompts/`.

## Add a channel

**Files to touch**

- [config/channels.json](../config/channels.json): add one entry.
- [src/ai/mock-model.ts](../src/ai/mock-model.ts): optional, add templates for the new channel id to `FIRST` (and `REVISION` if you want).
- [data/sample/brief.json](../data/sample/brief.json): optional, add the id to `channels` to see it in the demo.

**The entry**

```json
{
  "id": "push_notification",
  "label": "Push notification",
  "register": "short, warm",
  "output": "content-store",
  "variants": 3,
  "ctaPolicy": "none",
  "allowedCtas": [],
  "keywordLed": false,
  "fields": [
    { "name": "title", "maxChars": 40, "required": true, "limitSource": "assumed" },
    { "name": "body", "maxChars": 100, "required": true, "limitSource": "assumed" }
  ]
}
```

- `output` is one of `content-store`, `ad-export` or `creative-handoff`. A new output target needs code changes in [src/core/types.ts](../src/core/types.ts) (`OutputTarget`), [src/stages/output.ts](../src/stages/output.ts) and [src/stages/postpublish-check.ts](../src/stages/postpublish-check.ts).
- `ctaPolicy` is `required`, `soft` or `none`. With `required`, the `cta` field must be one of `allowedCtas` in the primary locale.
- `keywordLed: true` puts the brand keywords in the prompt. The `keyword_coverage` rule then warns when no field whose name starts with `headline` uses a keyword.
- `limitSource` says where the limit comes from. Use `platform` when the platform publishes the limit. Use `assumed` when you must still confirm it against your own content model. The value appears in the `character_limit` rule message, so a reviewer knows how firm the limit is.
- A field named `cta` is special. `MockModel` fills it from the allowed CTAs, and the `cta_policy` rule checks it.
- At G2 and G3, only the fields listed here are kept. Any other field name in the approved copy is dropped.

**What happens without mock templates.** `MockModel` answers `[MISSING: <field>]` for every field of an
unknown channel. The `missing_fact` rule blocks every variant, drafting retries up to
`drafting.maxAutoRetries`, and then the reviewer writes the copy at G2. A real model does not need templates.

**Test to write**

- In [test/rules.test.ts](../test/rules.test.ts), build a `ChannelSpec` like the one above. Assert that a field at `maxChars` passes and a field at `maxChars + 1` gives `character_limit`.
- In [test/workflow.test.ts](../test/workflow.test.ts), submit a brief with the new channel id and assert that the job reaches G2. Intake rejects an unknown id (`unknown channel`) and a channel listed twice (`channels has duplicates`).

## Add a copy rule

**Files to touch**

- [src/rules/copy-rules.ts](../src/rules/copy-rules.ts): add an object to `COPY_RULES`.
- [test/rules.test.ts](../test/rules.test.ts): add a test.

**The rule**

```ts
{
  id: 'no_double_spaces',
  description: 'No double spaces inside a field.',
  check: ({ fields }) =>
    each(fields, (name, value) =>
      / {2,}/.test(value)
        ? { rule: 'no_double_spaces', field: name, message: 'contains a double space', severity: 'block' }
        : undefined,
    ),
},
```

`each` is a helper inside `copy-rules.ts`. For word and phrase matching, use `containsTerm` and
`findTerms` from [src/rules/text.ts](../src/rules/text.ts). For length, use `charCount`, which counts
characters the way a reader sees them.

**Where the rule runs.** `checkCopy` runs every rule in four places:

- the rule-checks stage, on every AI variant ([rule-checks.ts](../src/stages/rule-checks.ts));
- G2, on the copy the reviewer approves ([gates.ts](../src/core/gates.ts));
- G3, on the secondary-locale copy, with `primary: false`;
- pre-publish QA, on all approved copy ([prepublish-qa.ts](../src/stages/prepublish-qa.ts)).

A `block` violation stops approval at G2 and G3 and counts as blocking in QA. A `warn` violation is shown
only. Block messages from the rule-checks stage go back to the model as feedback on the next attempt, so
write a message the model can act on. Use the `primary` flag to skip a rule that only makes sense in the
primary language.

**Test to write**

```ts
test('double spaces are blocked', () => {
  assert.deepEqual(rulesHit({ ...ok, line: 'Knitwear  in pure cashmere.' }), ['no_double_spaces']);
});
```

Keep the existing test `clean copy passes every rule` green. It proves that the new rule does not fire on clean copy.

## Add a secondary locale

**Files to touch**

- [config/pipeline.json](../config/pipeline.json): add an entry to `locales.secondary`.
- `data/sample/rulebook/banned-words.json`: add a list for the locale code.
- `data/sample/rulebook/tone.json` and `negative-examples.json`: optional, add a section for native editors.

**The entry**

```json
{ "code": "fr", "label": "French", "direction": "ltr", "aiAssist": false }
```

What the code does with it:

- Intake accepts the code in `brief.locales`. The primary locale must come first, and no locale can appear twice.
- Gather-facts creates one `job.secondary` item per secondary locale, with the `secondaryChecklist` items unchecked.
- G3 opens in parallel with drafting. The native editor approves each locale with the copy and a full checklist, or vetoes it. G3 closes when every secondary locale is approved.
- G3 and pre-publish QA check the copy against `bannedWords(<code>)` and the rules that apply to all locales.
- Pre-publish QA checks that the preview renders `lang="<code>"` with the configured `direction`.
- Until the end of the day in `audit.secondaryFullAuditUntil`, every secondary-locale item is in the human sample at G4. After that, one item is.

**`aiAssist`.** When `aiAssist` is `true` and the model's `supportsLocale(<code>)` returns true, the draft
stage writes one optional AI draft per channel for that locale. It stores the draft in `work.assist` and
the trace in `work.assistTrace`. The draft is written from the locked master brief and facts, never from
the primary-locale drafts. It runs only when `aiDrafting` is on. The G3 screen then offers "Start from the
AI draft", which fills the editor's fields. The editor still writes, checks and approves the copy. The
shipped `MockModel` supports `en` only, so it never writes a secondary-locale draft.

What the code does not read: `tone` and `negativeExamples` for a secondary locale. Those entries are
reference material for the native editor today.

**Test to write**

In [test/workflow.test.ts](../test/workflow.test.ts), submit a brief with `locales: ['en', 'ar', 'fr']`.
Approve G3 for `ar` and assert that G3 is still `waiting`. Approve it for `fr` and assert that G3 is `done`.
Add a case where the `fr` copy contains a banned `fr` word and assert that G3 throws `GateError`. If you
turn on `aiAssist`, follow the pattern in [test/hardening.test.ts](../test/hardening.test.ts): use a model
whose `supportsLocale` returns true and assert that `assist` is set.

## Version a prompt

**Files to touch**

- `prompts/draft.v2.md`: a new file. Copy [prompts/draft.v1.md](../prompts/draft.v1.md) and edit it.
- [config/pipeline.json](../config/pipeline.json): set `drafting.promptTemplate` to `"prompts/draft.v2.md"`.

**Rules for the file**

- Keep the front matter at the top and change the version:

  ```
  ---
  id: draft
  version: draft.v2
  ---
  ```

- The loader in [src/ai/prompt.ts](../src/ai/prompt.ts) accepts LF and CRLF line endings. [.gitattributes](../.gitattributes) makes git store text files with LF.
- Use only the placeholders that `buildDraftPrompt` fills, written as `<<name>>`. An unknown placeholder becomes an empty string.
- Keep the `<context>` block with `<<contextJson>>`. `MockModel` reads it with `extractContext`, which throws if the block is missing.
- Keep the output shape: JSON with a `variants` array. See [the model output contract](connectors.md#the-contract-for-model-output).
- Do not edit `draft.v1.md` once it has been used. Add a new file instead.

**Why the version is stamped.** Every AI variant carries `trace.promptVersion`, `trace.modelId`,
`trace.modelVersion` and `trace.inputHash`. The hash covers the full prompt text and the version. The same
values go into the `variants drafted` audit event, and the G2 screen shows them. A secondary-locale AI
draft carries the same fields in `assistTrace`. So you can tell which prompt wrote each line, reproduce a
draft, and compare two prompt versions on the same measures. `JobReport` does not carry the prompt
version today. To split `metrics.jsonl` by prompt version, add the field in
[src/stages/report.ts](../src/stages/report.ts), or join on the audit trail by job id.

**Test to write**

In [test/ai.test.ts](../test/ai.test.ts), load `prompts/draft.v2.md` with `loadPromptTemplate`. Assert that
`built.version` is `draft.v2`, that the seven blocks are present, and that `extractContext` reads the
context back. Then run the whole suite: [test/helpers.ts](../test/helpers.ts) loads `config/pipeline.json`,
so the workflow tests use the new prompt.

## Change gate roles

**Files to touch**

- [config/pipeline.json](../config/pipeline.json): set `gates.<gate>.role`. Use `roles` for display names.
- [src/core/types.ts](../src/core/types.ts): only for a new role, add it to `RoleId`.
- [src/cli/fixtures.ts](../src/cli/fixtures.ts): update `PEOPLE` if the demo and tests must use another person.

[gates.ts](../src/core/gates.ts) checks every decision in this order:

1. The gate exists, and the action belongs to that gate (`ACTIONS`): G1 `approve` or `reject`, G2 `approve` or `changes_required`, G3 `approve` or `veto`, G4 `publish`, `schedule` or `send_back`.
2. The decision names an actor with a name and a role.
3. The request is active and the gate is open.
4. `actor.role` equals the gate's role.

A G4 send-back can target G2 or G3 only. Each gate has exactly one role. To allow more than one role per
gate, change the type of `role` in [src/core/config.ts](../src/core/config.ts) and the role check.

`Engine.revert` in [src/core/engine.ts](../src/core/engine.ts) does not use the gate config. It allows
`content_manager` and `admin`. Change that list too if your roles differ.

Roles are not authentication. The server takes the actor, including the role, from the request body.
See [Add authentication in front of the server](#add-authentication-in-front-of-the-server).

**Test to write**

In [test/workflow.test.ts](../test/workflow.test.ts), extend `only the named role can decide`: assert that
the old role now gets a `GateError` that names the new role, and that the new role can decide.

## Swap the job store for a database

**Files to touch**

- A new file, for example `src/core/db-job-store.ts`.
- [src/server/index.ts](../src/server/index.ts): pass `store` to `Engine.create`.

`JobStore` in [src/core/job-store.ts](../src/core/job-store.ts) is a class with three methods: `save`, `get`
and `list`. `EngineOptions.store` has the type `JobStore`. Because the class has a private member,
TypeScript accepts only a subclass. Extend it:

```ts
import { JobStore } from './job-store';
import type { Job } from './types';

/** Your database client. One row per job, with the job as a JSON document. */
export interface JobTable {
  upsert(id: string, createdAt: string, body: string): Promise<void>;
  find(id: string): Promise<string | undefined>;
  allNewestFirst(): Promise<string[]>;
}

export class DbJobStore extends JobStore {
  constructor(private readonly table: JobTable) {
    super();
  }

  override async save(job: Job): Promise<void> {
    await this.table.upsert(job.id, job.createdAt, JSON.stringify(job));
  }

  override async get(id: string): Promise<Job | undefined> {
    const row = await this.table.find(id);
    return row ? (JSON.parse(row) as Job) : undefined;
  }

  override async list(): Promise<Job[]> {
    return (await this.table.allNewestFirst()).map((row) => JSON.parse(row) as Job);
  }
}
```

If you prefer, extract an interface from `JobStore` and use it in `EngineOptions` instead.

What the store must guarantee:

- `save` replaces the whole job. The engine saves the full job after every stage and gate, so `save` is called often. Keep it fast.
- `get` returns `undefined` for an unknown id. The engine then throws `NotFoundError`, and the server returns 404.
- `list` returns jobs newest first, by `createdAt`. `GET /api/jobs` shows them in that order.

**Concurrency.** The engine runs `decide`, `retryDeferred` and `revert` under a per-request lock
(`KeyedMutex` in [src/core/mutex.ts](../src/core/mutex.ts)). Two decisions on the same request run one after
the other. The lock lives in memory, so it covers one server process only. If you run more than one
process against a shared database, reject stale writes in `save`, for example by comparing `updatedAt`.

The audit trail is separate. `AuditLog` in [src/core/audit.ts](../src/core/audit.ts) appends one JSON line
per event and is passed as `auditLog` to `Engine.create`. Replace it the same way.

**Test to write**

Run the workflow tests against the new store: pass `store: new DbJobStore(...)` to `Engine.create` in
[test/helpers.ts](../test/helpers.ts), using a test database. Keep the test
`parallel decisions at G2 and G3 are both kept` in [test/hardening.test.ts](../test/hardening.test.ts) green.
Add a test that `list` returns the newest job first.

## Add a stage

**Files to touch**

- [src/core/types.ts](../src/core/types.ts): add the id to `StageId`.
- [src/core/workflow.ts](../src/core/workflow.ts): add a `StageDef` to `STAGES`, and update the `after` list of the stage that must now wait for it.
- `src/stages/<name>.ts`: write the runner.
- [src/stages/index.ts](../src/stages/index.ts): register the runner in `RUNNERS`.

**The runner**

```ts
import type { StageRunner } from '../core/workflow';

/** Rule: stop a request whose content deadline has already passed. */
export const leadTimeCheck: StageRunner = async (job, { clock }) => {
  const deadline = job.workspace?.deadline;
  if (!deadline) return { outcome: 'skipped', note: 'no deadline on the workspace' };
  if (new Date(deadline) <= clock.now()) {
    return { outcome: 'failed', jobStatus: 'rejected', note: `content was due ${deadline}` };
  }
  return { outcome: 'done', note: `content due ${deadline}` };
};
```

**The definition**

```ts
{ id: 'lead_time_check', label: '2b Lead time', kind: 'rule', after: ['setup'], description: 'Stop requests that are already late.' },
```

Then set `after: ['lead_time_check']` on `gather_facts`, and add `lead_time_check: leadTimeCheck` to `RUNNERS`.

How the engine runs it:

- A stage runs when every stage in `after` is `done` or `skipped`. The job is saved after each stage.
- A runner returns `done`, `skipped`, `retry` (with the stages to reset) or `failed` (with the job status).
- `kind` is `rule`, `ai` or `human`. It sets the actor kind in the audit trail. The UI receives `STAGES` through `GET /api/meta`.
- A stage with no runner throws `No runner for <id>`. Human gates have no runner, and adding a gate needs more changes: `GateId`, `GATES`, the `gates` config, `ACTIONS` in [gates.ts](../src/core/gates.ts), `GateDecision` and `applyDecision`.
- If the new stage sits between `output` and `g4_publish`, also update the reset lists in the G4 send-back ([gates.ts](../src/core/gates.ts)) and in `retryDeferred` ([engine.ts](../src/core/engine.ts)).
- Jobs saved before the change have no state for the new stage. Run `npm run reset` in development, or migrate saved jobs.

**Test to write**

In [test/workflow.test.ts](../test/workflow.test.ts), submit the sample brief and assert that
`job.stages.lead_time_check.status` is `done`. Add a case with a launch date close enough that the deadline
has passed, and assert that the job is `rejected`.

## Add authentication in front of the server

What the server in [src/server/index.ts](../src/server/index.ts) does today:

- It listens on `127.0.0.1` by default, so only the same machine can reach it. Set the `HOST` environment variable to change that, and `PORT` to change the port (4317 by default).
- It has no sign-in. The person picks a role in the browser, and the actor, including the role, travels in the request body. Roles are not authentication: anyone who can reach the server can act as any role.
- It answers 404 for an unknown request id (`GET /api/jobs/:id/audit` returns an empty list instead), 400 for a body that is not valid JSON, and 400 when `POST /api/jobs`, `/retry-deferred` or `/revert` has no actor name and role. A decision with no actor is refused by the gate with 422. Other refused decisions also give 422.

Do not set `HOST` to a public address until you add the steps below.

**Files to touch**

- A new file, for example `src/server/auth.ts`.
- [src/server/index.ts](../src/server/index.ts).

**Steps**

1. Put the server behind your single sign-on, or check a session token in the request handler.
2. Map the verified identity to an `Actor` (name and `RoleId`) on the server side.
3. Replace the actor in every request body with that server-side actor. Never trust a role sent by the browser.
4. Protect the read routes too. `GET /api/jobs/:id`, `/master` and `/audit` return briefs, copy and the audit trail.
5. Remove or protect `POST /api/drill/content-store` outside development.

```ts
import type { IncomingMessage } from 'node:http';
import type { Actor } from '../core/types';

/** Your session check. Returns the person and their role, or undefined. */
export interface SessionVerifier {
  verify(token: string): Promise<Actor | undefined>;
}

export async function authenticate(req: IncomingMessage, verifier: SessionVerifier): Promise<Actor | undefined> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return token ? verifier.verify(token) : undefined;
}
```

In the request handler, call `authenticate` before routing. Return HTTP 401 when it gives `undefined`.
Pass the actor to the handlers and use it in place of the body actor, for example
`engine.decide(id, { ...decision, actor })`. The existing 400 check for a missing body actor then no
longer applies.

**Test to write**

The server module starts listening when it is imported, so test the pieces:

- Unit-test `authenticate`: no header, a bad token and a good token.
- Add a test that a decision sent with `role: 'content_manager'` in the body, by a person whose session role is `requester`, is refused by the gate.
