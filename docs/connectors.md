# Connectors

The pipeline never talks to an external system directly. It talks to the interfaces in
[src/connectors/types.ts](../src/connectors/types.ts). Each interface has a local stand-in in
[src/connectors/local/](../src/connectors/local/), so the app runs with no network and no credentials.
The registry in [src/connectors/index.ts](../src/connectors/index.ts) builds the full set with
`createLocalConnectors(clock, options)`.

The language model sits behind a separate interface, `LanguageModel`, in
[src/ai/provider.ts](../src/ai/provider.ts). See [Connect a real language model](#connect-a-real-language-model).

Local stand-ins write their files under `data/runtime/`. Set `CAE_RUNTIME_DIR` to move that folder
(see [src/core/paths.ts](../src/core/paths.ts)). The tests do this so each test gets its own folder.

## How failures are handled

`ServiceUnavailableError` is the error a connector throws when its system cannot be reached.

Today the engine catches it **only for the content store**:

- [src/stages/output.ts](../src/stages/output.ts) marks that output `deferred` and carries on with the other channels.
- Pre-publish QA ([src/stages/prepublish-qa.ts](../src/stages/prepublish-qa.ts)) and the live check ([src/stages/postpublish-check.ts](../src/stages/postpublish-check.ts)) record a warning.
- G4 in [src/core/gates.ts](../src/core/gates.ts) marks the output `deferred` instead of `published`.
- `Engine.retryDeferred` in [src/core/engine.ts](../src/core/engine.ts) stages deferred outputs later. After G4, a recovered entry goes live only if it passes the same preview checks as pre-publish QA. If it fails them, it stays `staged`.

Any other error, from any connector, stops the engine call. The engine saves the job after every stage and
gate, so stages that finished before the error stay saved. Work since the last save is lost. If the error
comes in the first stage after a gate decision, the decision is not saved and the person can decide again.
Audit events written before the error stay in the audit log. The server returns HTTP 500.

## The interfaces

### WorkspaceProvisioner

**Purpose.** Creates the workspace for a request: a folder, a task list and a deadline.

| Method | Called by |
|---|---|
| `create(job, deadline): Promise<{ folder, tasks }>` | [setup.ts](../src/stages/setup.ts) |

The setup stage computes `deadline` as `launchAt` minus `scheduling.stageLeadHours` and stores the result on
`job.workspace`.

**Local stand-in** ([outputs.ts](../src/connectors/local/outputs.ts)). Writes
`data/runtime/workspaces/<jobId>/workspace.json` with one task per gate, one G3 task per secondary locale,
and one "Deliver" task per channel.

**A real adapter** (for example, a project and tasks in your ticketing tool) must:

- return a `folder` reference and the task names it created;
- be safe to call twice for the same job id, for example after a timeout where the work was done but the answer was lost.

### ProductCatalog

**Purpose.** The single source for product facts: name, category, materials, composition, price, availability.

| Method | Called by |
|---|---|
| `getMany(ids): Promise<ProductRecord[]>` | [gather-facts.ts](../src/stages/gather-facts.ts) |

**Local stand-in.** Reads `data/sample/products.json` ([sample-data.ts](../src/connectors/local/sample-data.ts)).

**A real adapter** must:

- leave out unknown ids instead of throwing. The gather-facts stage lists the missing ids and fails the job with a clear note;
- return the price as `{ amount, currency }`. The price rule compares copy against `formatPrice()` in [slots.ts](../src/ai/slots.ts), which gives `USD 495`;
- return `materials` as plain words. The material rule matches them against the material lexicon;
- return current `available` and `brandId` values. The gather-facts stage fails the job if a product is unavailable or belongs to another brand.

### Rulebook

**Purpose.** Brand fact cards, tone rules, banned words, the material lexicon and phrases editors rejected before.

| Method | Used for |
|---|---|
| `brand(brandId)` | Brand name, approved claims and `facts`. Each key in `facts` becomes a `{{brand.<key>}}` slot. |
| `tone(profile, locale)` | Tone do and don't lists. `profile` is `brief.tone`. Read for the primary locale only. |
| `bannedWords(locale)` | Primary locale in gather-facts. Secondary locales at G3 and in pre-publish QA. |
| `materialLexicon()` | Words the material rule looks for. |
| `negativeExamples(locale)` | Rejected phrases. Read for the primary locale only. |

**Local stand-in.** Reads the JSON files in `data/sample/rulebook/`.

**A real adapter** (for example, pages in your knowledge base) must:

- return `undefined` from `brand` and `tone` when nothing exists. The gather-facts stage then fails the job;
- return `[]` for a locale with no list, not throw;
- return exact strings. Rules match whole words, case-insensitive (see [text.ts](../src/rules/text.ts)).

### ChannelLibrary

**Purpose.** Channel specs: fields, character limits, register, CTA policy, output target.

| Method | Called by |
|---|---|
| `all()` | Intake (to check channel ids) and `GET /api/meta` |
| `get(ids)` | Gather-facts |

**Local stand-in.** Reads [config/channels.json](../config/channels.json).

**A real adapter** must return specs in the order of the `ids` it was given and skip unknown ids.
`all()` must include every id a brief can use, or intake rejects the brief.

### KeywordSource

**Purpose.** Search and performance keywords for a brand.

| Method | Called by |
|---|---|
| `forBrand(brandId)` | Gather-facts |

Keywords go into the prompt only for channels with `keywordLed: true`. The `keyword_coverage` rule warns
when no headline uses one.

**Local stand-in.** Reads `data/sample/keywords.json`. Returns `[]` for an unknown brand.

### ContentStore

**Purpose.** Where web and app content is staged, previewed, scheduled and published. It keeps version history.

| Method | Contract |
|---|---|
| `stage(entry)` | Create or update the entry for `jobId` + `channel` + `locale`. Returns the `StoredEntry`. |
| `preview(ref)` | Render the staged entry. Returns `html`, `lang`, `dir` and every link on the page. |
| `publish(ref, scheduledFor?)` | Publish now, or schedule when `scheduledFor` is set. Records the version that went live. |
| `get(ref)` | Return the entry, or `undefined` if the ref is unknown. |
| `revert(ref, toVersion)` | Put the copy of an earlier version back live, as a new version. |
| `unpublish(ref)` | Take the entry off the live site. The content stays in the store. |

`StoredEntry` carries `version` (the current version), `versions` (every version with its `versionHash`,
`fields` and time), `publishedVersions` (every version that went live or was scheduled, oldest first),
`status` (`draft`, `scheduled` or `published`), `scheduledFor` and `publishedVersionHash`.

**Local stand-in** ([content-store.ts](../src/connectors/local/content-store.ts)). Keeps all entries in
`data/runtime/content-store/entries.json`. Every change (stage, publish, revert, unpublish) loads, changes
and saves the file under one lock (`KeyedMutex` in [src/core/mutex.ts](../src/core/mutex.ts)), so two
requests cannot overwrite each other. `setOutage(true)`, or `CONTENT_STORE_OUTAGE=1`, makes every call
throw `ServiceUnavailableError`. The server uses this for the failure drill.

**A real adapter** must guarantee the following. Each point comes from code that depends on it.

1. **Idempotent `stage()`.** Staging the same `jobId` + `channel` + `locale` with the same `versionHash`
   returns the existing entry and creates no new version. A different `versionHash` adds a new version
   (highest version + 1), appends it to `versions` and makes it the current copy. It does not change
   `status`, `publishedVersions` or `publishedVersionHash`: the live copy changes only on `publish` or
   `revert`. The engine stages again after a G4 send-back and in `retryDeferred`.
2. **Published version tracking.** `publish` sets `status` to `published` (or `scheduled` when
   `scheduledFor` is set), sets `publishedVersionHash` to the current `versionHash`, and appends the
   current `version` to `publishedVersions` unless it is already the last one. The live check compares
   `status` and `publishedVersionHash` with what was approved. A mismatch counts as an error at publish.
3. **History only grows.** `revert(ref, toVersion)` refuses an entry whose status is `draft`. Otherwise it
   copies the fields and hash of `toVersion` into a **new** version (highest version + 1), makes that
   version current and live, and appends it to `publishedVersions`. It never rewrites or deletes a version.
4. **What the engine asks for.** `Engine.revert` refuses a `draft` entry. It looks through
   `publishedVersions` for the latest version before the current one whose copy differs from the current
   copy, and reverts to it. If there is none, it calls `unpublish`. So copy that never went live, such as
   copy sent back at G4, is never restored.
5. **A version marker in the preview.** Pre-publish QA passes `version_match` only when `preview.html`
   contains `data-version="<versionHash>"`. It also checks that `preview.lang` equals the locale, that
   `preview.dir` matches the locale direction, and that every link in `preview.links` is `https` on a host
   in `qa.allowedLinkHosts`.
6. **`ServiceUnavailableError` when the system is down.** Throw it for network failures and outages. Throw
   a plain `Error` for real faults such as an unknown ref, so they are not mistaken for an outage.
7. **`unpublish` keeps the content.** It sets `status` to `draft` and clears `scheduledFor` and
   `publishedVersionHash`.
8. **Safe under concurrent calls.** Two requests can stage or publish at the same time. Use your content
   store's own concurrency control, or serialise changes as the local store does.

### AdExport

**Purpose.** Produces the bulk-upload file for the ad platform.

| Method | Called by |
|---|---|
| `write(jobId, rows): Promise<string>` | [output.ts](../src/stages/output.ts). The returned reference is stored as the output's `ref`. |
| `verify(ref): Promise<boolean>` | The live check ([postpublish-check.ts](../src/stages/postpublish-check.ts)) |

**Local stand-in.** `write` creates `data/runtime/exports/<jobId>-ads.csv` with the columns `channel`,
`locale`, one column per field, and `final_url`, and returns the file path. `verify` returns true when
that file exists.

**A real adapter** returns from `write` any reference it can check later, for example an upload id.
`verify(ref)` must return true only while that upload is still delivered. A `false` is a blocking failure
in the live check and counts as an error at publish.

### CreativeHandoff

**Purpose.** Sends approved copy to design and social production.

| Method | Called by |
|---|---|
| `send(jobId, items): Promise<string>` | [output.ts](../src/stages/output.ts). The returned reference is stored as the output's `ref`. |
| `verify(ref): Promise<boolean>` | The live check |

**Local stand-in.** `send` writes `data/runtime/handoff/<jobId>-creative.json` and returns the path.
`verify` returns true when that file exists.

**A real adapter** follows the same rule as `AdExport`: `verify` must confirm that the hand-off it
returned is still delivered, for example that the ticket in your ticketing tool still exists.

### FallbackStore

**Purpose.** Keeps a copy of all approved content outside the content store, so a content store outage
cannot block a launch.

| Method | Called by |
|---|---|
| `write(jobId, pack): Promise<string>` | [output.ts](../src/stages/output.ts), before anything else |

**Local stand-in.** Writes `data/runtime/fallback/<jobId>.json`.

**A real adapter** must not depend on the content store. The output stage does not catch errors from it,
so a failure here stops the output stage.

### Notifier

**Purpose.** Tells people when a gate opens, a stage fails, an output is deferred or recovered, QA blocks,
a native editor vetoes, the live check fails, or an incident is recorded.

| Method | Levels |
|---|---|
| `notify({ level, jobId, message })` | `info`, `warn`, `alert` |

**Local stand-in.** Appends to `data/runtime/notifications.jsonl`, with the time from the engine clock.
It also prints `warn` and `alert` messages unless `quiet` is set.

**A real adapter** should catch its own delivery errors. A throw from `notify` stops the engine call that sent it.

### MetricsSink

**Purpose.** Receives one `JobReport` per request for the KPI dashboard.

| Method | Called by |
|---|---|
| `record(report)` | [report.ts](../src/stages/report.ts) |

**Local stand-in.** Keeps one row per `jobId` in `data/runtime/metrics.jsonl`. A later report for the same
job replaces the earlier row. Writes run under a lock.

**A real adapter** must upsert by `jobId`. The report stage runs again when `retryDeferred` recovers an
output after the job was reported, and the later report is the one to keep.

## Replace one connector: the content store

This guide replaces the local content store with an adapter for your real content store. The same steps
work for any connector.

### Step 1. Write the adapter

Create `src/connectors/remote/content-store.ts`. The class implements `ContentStore`. It maps every
network failure and every 5xx or 429 response to `ServiceUnavailableError`. The version rules above must
hold on your side: the skeleton assumes your service, or a thin layer in front of it, implements them.

```ts
import {
  ServiceUnavailableError,
  type ContentEntryInput,
  type ContentStore,
  type RenderedPreview,
  type StoredEntry,
} from '../types';

export interface RemoteContentStoreOptions {
  /** Base URL of your content store's management endpoint. */
  baseUrl: string;
  /** Read from your secret store at startup. Never commit it. */
  credential: string;
  timeoutMs?: number;
}

export class RemoteContentStore implements ContentStore {
  constructor(private readonly options: RemoteContentStoreOptions) {}

  /** Upsert keyed on jobId + channel + locale. The same versionHash must not create a new version. */
  async stage(entry: ContentEntryInput): Promise<StoredEntry> {
    const key = `${entry.jobId}:${entry.channel}:${entry.locale}`;
    return this.call<StoredEntry>('PUT', `/entries/${encodeURIComponent(key)}`, entry);
  }

  async preview(ref: string): Promise<RenderedPreview> {
    const entry = await this.mustGet(ref);
    const page = await this.call<{ html: string; lang: string; dir: 'ltr' | 'rtl'; links: string[] }>(
      'GET',
      `/entries/${encodeURIComponent(ref)}/preview`,
    );
    return {
      ref,
      // Pre-publish QA looks for this marker. Better: render it in your preview template.
      html: `<div data-version="${entry.versionHash}">${page.html}</div>`,
      lang: page.lang,
      dir: page.dir,
      links: page.links,
    };
  }

  /** Must append the current version to publishedVersions and set publishedVersionHash. */
  async publish(ref: string, scheduledFor?: string): Promise<StoredEntry> {
    return this.call<StoredEntry>('POST', `/entries/${encodeURIComponent(ref)}/publish`, { scheduledFor });
  }

  async get(ref: string): Promise<StoredEntry | undefined> {
    return this.call<StoredEntry | undefined>('GET', `/entries/${encodeURIComponent(ref)}`, undefined, true);
  }

  /** Refuse draft entries. Write the copy of toVersion as a new version and make it live. */
  async revert(ref: string, toVersion: number): Promise<StoredEntry> {
    const entry = await this.mustGet(ref);
    if (entry.status === 'draft') throw new Error(`Entry ${ref} is not live`);
    if (!entry.versions.some((v) => v.version === toVersion)) throw new Error(`Entry ${ref} has no version ${toVersion}`);
    return this.call<StoredEntry>('POST', `/entries/${encodeURIComponent(ref)}/revert`, { toVersion });
  }

  /** Take the entry off the live site. Keep every version. */
  async unpublish(ref: string): Promise<StoredEntry> {
    return this.call<StoredEntry>('POST', `/entries/${encodeURIComponent(ref)}/unpublish`);
  }

  private async mustGet(ref: string): Promise<StoredEntry> {
    const entry = await this.get(ref);
    if (!entry) throw new Error(`Unknown entry ${ref}`);
    return entry;
  }

  private async call<T>(method: string, path: string, body?: unknown, allowNotFound = false): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.credential}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new ServiceUnavailableError('content store');
    }
    if (allowNotFound && response.status === 404) return undefined as T;
    if (response.status >= 500 || response.status === 429) throw new ServiceUnavailableError('content store');
    if (!response.ok) throw new Error(`content store returned ${response.status} for ${method} ${path}`);
    return (await response.json()) as T;
  }
}
```

The paths and payloads above are placeholders. Map them to your content store's own model, and map its
entry back to the `StoredEntry` shape, including `version`, `versions`, `publishedVersions` and
`publishedVersionHash`.

### Step 2. Register it

`createLocalConnectors` returns `LocalConnectors`, which types `contentStore` as the local class. Leave it
as it is, and add a new function next to it in [src/connectors/index.ts](../src/connectors/index.ts):

```ts
import type { ContentStore } from './types';

/** Local stand-ins for everything, except the connectors you pass in. */
export function createConnectors(
  clock: Clock,
  contentStore: ContentStore,
  options: { quiet?: boolean } = {},
): Connectors {
  return { ...createLocalConnectors(clock, options), contentStore };
}
```

### Step 3. Wire it into the server

In [src/server/index.ts](../src/server/index.ts), build the connectors with `createConnectors` and your
adapter. Read the credential from your secret store at startup.

The server also calls `contentStore.isDown()` in `GET /api/meta` and `contentStore.setOutage()` in
`POST /api/drill/content-store`. These exist only on the local class. Keep a reference to the local store
for drills, or remove the drill route and return `drill: { contentStoreDown: false }` from `/api/meta`.
The UI in [public/app.js](../public/app.js) reads `meta.drill.contentStoreDown`.

### Step 4. Test it

Write a contract test that runs the same checks against the local store and against your adapter
(pointed at a sandbox):

- `stage` twice with the same `versionHash` gives the same `version`.
- `stage` with a new `versionHash` gives a higher `version` and leaves `publishedVersionHash` unchanged.
- `publish` sets `publishedVersionHash` to the staged hash and adds the version to `publishedVersions`. With `scheduledFor`, the status is `scheduled`.
- `preview(ref).html` contains `data-version="<versionHash>"`.
- `revert` on a draft entry throws. On a live entry it creates a new version with the old copy, and `versions` only grows.
- `unpublish` sets `status` to `draft` and clears `publishedVersionHash`.
- With the system unreachable, every method throws `ServiceUnavailableError`.

Then run the workflow tests in [test/workflow.test.ts](../test/workflow.test.ts) and
[test/hardening.test.ts](../test/hardening.test.ts) with your connector. Pass it to `Engine.create` in
[test/helpers.ts](../test/helpers.ts).

## Connect a real language model

The model is not a connector. It is passed to the engine on its own:

```ts
const engine = await Engine.create({ connectors, model, clock });
```

`MockModel` in [src/ai/mock-model.ts](../src/ai/mock-model.ts) is the default in the server and the demo.
It is deterministic. It reads the `<context>` block at the end of the prompt and answers with templates.
It supports the `en` locale only.

To use your model provider, implement `LanguageModel`:

```ts
import type { CompletionRequest, LanguageModel } from '../ai/provider';

export interface HttpModelOptions {
  /** Your model endpoint. */
  endpoint: string;
  /** Read from your secret store at startup. Never commit it. */
  credential: string;
  /** The model name your provider expects. Stamped on every draft. */
  model: string;
  /** Your own version label, for example a release date. Stamped on every draft. */
  version: string;
  /** Locales the model writes well. Controls the optional secondary-locale draft. */
  locales: string[];
  timeoutMs?: number;
}

export class HttpModel implements LanguageModel {
  readonly id: string;
  readonly version: string;

  constructor(private readonly options: HttpModelOptions) {
    this.id = options.model;
    this.version = options.version;
  }

  supportsLocale(locale: string): boolean {
    return this.options.locales.includes(locale);
  }

  async complete(request: CompletionRequest): Promise<string> {
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.credential}`,
      },
      body: JSON.stringify({ model: this.options.model, system: request.system, prompt: request.prompt }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
    if (!response.ok) throw new Error(`model endpoint returned ${response.status}`);
    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text !== 'string') throw new Error('model endpoint returned no text');
    return body.text;
  }
}
```

Change the request and response shapes to match your provider. Then pass the model to the engine in
[src/server/index.ts](../src/server/index.ts) and, if you want, in [src/cli/demo.ts](../src/cli/demo.ts):

```ts
const model = new HttpModel({
  endpoint: modelEndpoint,     // from your configuration
  credential: modelCredential, // from your secret store
  model: 'your-model-name',
  version: '2026-10-01',
  locales: ['en'],
});
const engine = await Engine.create({ connectors, model, clock: systemClock });
```

Notes:

- `id` and `version` are stamped on every variant (`variant.trace`) and on every `variants drafted` audit event, with the prompt version and an input hash.
- `supportsLocale` controls the optional AI draft for a secondary locale. The draft stage writes one only when that locale has `aiAssist: true` in [config/pipeline.json](../config/pipeline.json) and `supportsLocale` returns true. See [Add a secondary locale](extending.md#add-a-secondary-locale).
- Throwing from `complete` is safe. For the primary locale, the draft stage turns the error into a blocked variant with the rule `output_format`. The placement is drafted again up to `drafting.maxAutoRetries`, and then the reviewer writes the copy at G2. For a secondary-locale draft, that channel simply gets no AI draft.
- Keep the tests on `MockModel`. They depend on its fixed output.

### The contract for model output

The draft stage ([src/stages/draft.ts](../src/stages/draft.ts)) parses the model's answer like this:

1. It trims the text and strips one surrounding code fence, if there is one.
2. It parses the text as JSON. The JSON must have a `variants` array.
3. Each variant must be an object. Each key is a field name of the channel, for example `headline`, `line`, `cta`. Each value is turned into a string.

```json
{ "variants": [ { "headline": "{{brand.name}} arrives", "line": "Pure {{product.material}} {{product.category}}.", "cta": "Discover" } ] }
```

If the answer breaks any of these points, the placement gets one blocked variant with the rule
`output_format`, and the retry loop starts. For a secondary-locale draft, only the first variant is used.

**Fact slots only.** The model must not type facts. It writes a slot, and the system fills it from
approved data after generation ([src/ai/slots.ts](../src/ai/slots.ts)). The slots are:

- `{{brand.name}}`, plus `{{brand.<key>}}` for each key in the brand fact card's `facts`;
- `{{product.name}}`, `{{product.category}}`, `{{product.composition}}`, `{{product.price}}` from the first product;
- `{{product.material}}`, which joins the materials of all products with "and".

A slot can take one filter: `|cap`, `|title` or `|lower`.

**`[MISSING: x]`.** When the model needs a fact that has no slot, it must write `[MISSING: name of the fact]`
and not guess. A slot name that does not exist is also replaced with `[MISSING: name]`. The `missing_fact`
rule blocks any field that contains it, so a person must supply the fact.

Other rules then check the filled text. A material word typed as a literal and not in the product record
is blocked by `material_claim`. A slot left unfilled is blocked by `unresolved_slot`. A price that does
not match the record is blocked by `price_and_offer`. The full list is in
[src/rules/copy-rules.ts](../src/rules/copy-rules.ts). Field names that are not fields of the channel are
dropped when a person approves the copy at G2 or G3.
