# HTTP API

The server in [src/server/index.ts](../src/server/index.ts) is a JSON API over the engine. It also serves the gate UI from [public/](../public/).

Start it with `npm start`. It listens on `127.0.0.1` port 4317. Set the `HOST` and `PORT` environment variables to change them. It uses the local connectors, the mock language model and the system clock.

## Conventions

- Request and response bodies are JSON. Responses have `content-type: application/json; charset=utf-8` and `cache-control: no-store`.
- `{id}` in a path is a job id, for example `job-5dd999a9`. It must match `[\w-]+`.
- Many bodies contain an `actor`: `{ "name": string, "role": RoleId }`. `RoleId` is one of `requester`, `content_project_lead`, `content_manager`, `native_editor`, `admin`. In the UI, a person picks the role in the browser. The server checks that the role fits the action, but it does not authenticate anyone. It trusts the value in the body.
- Types are defined in [src/core/types.ts](../src/core/types.ts).

## Errors

| Status | When | Body |
|---|---|---|
| 400 | The body is not valid JSON. Or a required part is missing: `brief` or `actor` on `POST /api/jobs`, `actor` on `retry-deferred` and `revert`. The actor needs both `name` and `role`. | `{ "error": string }` |
| 404 | No request has that id (`NotFoundError`). Or no route matches the method and path, or a static file is not found. | `{ "error": string }` |
| 422 | The engine or the server throws `GateError`. This covers refused decisions and failed checks. | `{ "error": string, "details": string[] }` |
| 500 | Any other error, for example the content store is down during a revert. | `{ "error": string }` |

`GateError` and `NotFoundError` are defined in [src/core/gates.ts](../src/core/gates.ts). When a `GateError` has details, `error` is the message followed by a colon and the details joined with "; ". `details` is the same list as an array. It is empty when there are no details.

Example 422 from G2, when the edited homepage headline is too long:

```json
{
  "error": "The copy cannot be approved yet: homepage:en headline: headline has 52 characters; the limit is 40 (assumed limit)",
  "details": [
    "homepage:en headline: headline has 52 characters; the limit is 40 (assumed limit)"
  ]
}
```

Example 404:

```json
{ "error": "No request with id job-00000000" }
```

A brief that fails the intake rules is not an HTTP error. `POST /api/jobs` returns 200 with a job whose `status` is `rejected`. The reasons are in `stages.intake.note`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/meta` | Config, stages, channels, drill state |
| GET | `/api/sample-brief` | The sample brief |
| GET | `/api/jobs` | List jobs |
| POST | `/api/jobs` | Submit a brief |
| GET | `/api/jobs/{id}` | Get one job |
| GET | `/api/jobs/{id}/master` | What the native editor sees at G3 |
| GET | `/api/jobs/{id}/audit` | The audit trail |
| POST | `/api/jobs/{id}/decisions` | Decide at a gate |
| POST | `/api/jobs/{id}/retry-deferred` | Retry outputs deferred by a content store outage |
| POST | `/api/jobs/{id}/revert` | Revert or take down a live entry |
| POST | `/api/drill/content-store` | Switch the simulated content store outage on or off |
| GET | any path not under `/api/` | Static files from `public/`. `/` serves `index.html`. |

`decisions`, `retry-deferred` and `revert` run one at a time per job, under a lock. A second call for the same job waits until the first one ends, then works on the saved result.

### GET /api/meta

Request body: none.

Response 200:

```json
{
  "config": "PipelineConfig: the content of config/pipeline.json",
  "stages": "StageDef[]: id, label, kind, after, description for all 13 stages",
  "channels": "ChannelSpec[]: every channel in config/channels.json",
  "drill": { "contentStoreDown": false }
}
```

Errors: 500 if a config file cannot be read.

### GET /api/sample-brief

Request body: none.

Response 200: a `Brief` read from [data/sample/brief.json](../data/sample/brief.json). If `launchAt` is empty in the file, it is set to 72 hours from now.

### GET /api/jobs

Request body: none.

Response 200: an array, newest first.

```json
[
  {
    "id": "job-5dd999a9",
    "title": "Brand launch: debut knitwear collection",
    "status": "active",
    "createdAt": "2026-10-01T08:00:00.000Z",
    "waiting": ["G2 Approve primary", "G3 Approve secondary"]
  }
]
```

`waiting` lists the labels from `STAGES` of the gates that are open.

### POST /api/jobs

Submit a brief. The engine runs every automated stage up to the first gate before it answers.

Request body:

```json
{
  "brief": {
    "title": "Brand launch: debut knitwear collection",
    "requester": "requester@example.com",
    "brandId": "brand-sample",
    "productIds": ["prod-001", "prod-002"],
    "objective": "Introduce the brand's debut knitwear collection to existing customers",
    "audience": "Customers who bought knitwear in the last 12 months",
    "offer": "",
    "keyMessage": "Small-batch knitwear in pure cashmere, made in Italy",
    "tone": "brand-voice",
    "cta": "Discover",
    "channels": ["homepage", "crm_email", "social", "search_ad", "display_banner"],
    "locales": ["en", "ar"],
    "launchAt": "2026-10-20T09:00:00.000Z",
    "landingUrl": "https://www.example.com/brands/sample-brand"
  },
  "actor": { "name": "Requester", "role": "requester" }
}
```

Any role is accepted here. The actor name goes into the audit trail. The server checks only that `brief` is an object. The intake rules check its fields.

Response 200: the full `Job`. With a valid brief, `stages.g1_accept_brief.status` is `waiting`. With an invalid brief, `status` is `rejected`. If a product, brand fact card or tone profile is missing, `status` is `failed`.

Errors:

| Status | Message |
|---|---|
| 400 | `Request body is not valid JSON` |
| 400 | `Request body needs a brief` |
| 400 | `Request body needs actor.name and actor.role` |

### GET /api/jobs/{id}

Request body: none.

Response 200: the full `Job`.

Errors: 404 `No request with id {id}`.

### GET /api/jobs/{id}/master

The view for the native editor at G3: the locked master brief and the facts, but not the primary-locale drafts.

Request body: none.

Response 200:

```json
{
  "brief": "Brief",
  "master": { "lockedAt": "2026-10-01T09:00:00.000Z", "lockedBy": "Content project lead", "hash": "16 hex characters" },
  "facts": { "brand.name": "Sample Brand", "brand.origin": "Italy", "product.material": "cashmere" },
  "approvedClaims": ["Made in Italy", "Small-batch production"],
  "channels": "ChannelSpec[] for the channels on this request"
}
```

`facts` holds every fact slot and its value, from `slotValues` in [src/ai/slots.ts](../src/ai/slots.ts). The example shows only part of it. `master` is absent until G1 approves. The optional AI draft for a secondary locale is not part of this view. It is in `secondary[].assist` on the job.

Errors:

| Status | Message | Cause |
|---|---|---|
| 404 | `No request with id {id}` | Unknown job. |
| 422 | `No facts yet` | Stage 3 has not run. |

### GET /api/jobs/{id}/audit

Request body: none.

Response 200: an array of `AuditEvent`, oldest first. An unknown id returns an empty array.

```json
[
  {
    "at": "2026-10-01T08:00:00.000Z",
    "jobId": "job-5dd999a9",
    "stage": "g1_accept_brief",
    "actorKind": "system",
    "actor": "engine",
    "event": "gate opened",
    "details": { "role": "content_project_lead" }
  }
]
```

### POST /api/jobs/{id}/decisions

Decide at a gate. The body is one `GateDecision` from [src/core/types.ts](../src/core/types.ts). After a valid decision, the engine runs every stage that becomes ready and stops at the next open gate.

Request body: a `GateDecision`. See [Decision bodies](#decision-bodies).

Response 200: the full `Job`.

Errors: 400 `Request body is not valid JSON`, 404 `No request with id {id}`, and 422 for a `GateError`. The 422 messages, in the order the gate controls check them:

| Message | Cause |
|---|---|
| `Unknown gate "{gate}"` | `gate` is not one of the four gate ids. |
| `{gate label} has no action "{action}"` | The gate does not accept this action. |
| `Say who is deciding: actor name and role` | `actor.name` or `actor.role` is missing. |
| `This request is {status}` | The job is not `active`. |
| `{gate label} is not open (it is {status})` | The gate status is not `waiting`. |
| `{gate label} needs the role "{role label}"` | `actor.role` is not the gate role. |
| `Say why the brief is rejected` | G1 reject without notes. |
| `Write the changes you need` | G2 changes required without notes. |
| `The copy cannot be approved yet` | G2 approve. `details` lists a missing selection, an unknown variant, missing text in shadow mode or on the manual path, or a blocking rule. |
| `No {locale} work on this request` | G3 with a locale that is not on the request. |
| `The {locale} copy cannot be approved yet` | G3 approve. `details` lists blocking rules and unchecked checklist items. |
| `Say what must change` | G3 veto or G4 send back without notes. |
| `Send back to G2 or G3 only` | G4 send back with a `to` that is not `g2_approve_primary` or `g3_approve_secondary`. |
| `Pre-publish QA has not run` | G4 publish or schedule before QA. |
| `Pre-publish QA has {n} blocking issue(s). Send the copy back to fix them` | G4 publish or schedule while QA has blocking failures. |
| `Check the sample before you publish` | G4 publish or schedule with `sampleChecked` not `true`. |
| `Give a future date and time to schedule` | G4 schedule without a future `scheduledFor`. |

The gate controls do not check every field of a decision. A G2 approval without a `selections` object is refused with a 422 that lists each placement with no copy.

### POST /api/jobs/{id}/retry-deferred

Stage again every content store output that is `deferred` because the content store was down. Outputs that fail again stay deferred.

Request body:

```json
{ "actor": { "name": "Content manager", "role": "content_manager" } }
```

Any role is accepted. The actor name goes into the audit trail.

Response 200: the full `Job`.

- Before G4: a recovered output becomes `staged`, and pre-publish QA runs again.
- After G4: a recovered entry first goes through the preview checks of pre-publish QA. The results are added to `job.qa.checks`. If a blocking check fails, the entry stays `staged` and an alert is sent. If not, it is published or scheduled to match the G4 decision. When at least one output was recovered or held, the live check and the report run again.

Errors: 400 `Request body is not valid JSON` or `Request body needs actor.name and actor.role`, 404 `No request with id {id}`.

### POST /api/jobs/{id}/revert

Incident response after publishing. It works only on a content store entry that is live or scheduled. The engine finds the latest earlier version that went live with different copy, and puts that copy back as a new version of the entry. If no earlier version went live, it takes the entry down and the output status becomes `staged`. The job gets an `Incident` that lists every other output of the request, so a person can check them for the same problem. An alert is sent.

Request body:

```json
{
  "actor": { "name": "Content manager", "role": "content_manager" },
  "channel": "homepage",
  "locale": "en",
  "reason": "Wrong material claim reported"
}
```

Response 200: the full `Job`, with the new entry in `incidents`. `revertedTo` is the version whose copy was put back. It is absent when the entry was taken down. The job status does not change.

Errors:

| Status | Message | Cause |
|---|---|---|
| 400 | `Request body is not valid JSON` | Bad JSON. |
| 400 | `Request body needs actor.name and actor.role` | No actor. |
| 404 | `No request with id {id}` | Unknown job. |
| 422 | `Only a content manager can revert live content` | `actor.role` is not `content_manager` or `admin`. |
| 422 | `Give the reason for the revert` | Empty or missing `reason`. |
| 422 | `No content-store output for {channel} ({locale})` | The output is an ad export or creative hand-off, or it was never staged. |
| 422 | `Entry not found in the content store` | The reference points to no entry. |
| 422 | `This entry is not live or scheduled, so there is nothing to revert` | The entry is a draft, for example after an earlier take-down. |
| 500 | `content store is unavailable` | The content store is down. |

### POST /api/drill/content-store

Failure drill. Switch the simulated outage of the local content store on or off. While it is on, every content store call throws `ServiceUnavailableError`. The setting is held in memory and is lost when the server stops. Setting the environment variable `CONTENT_STORE_OUTAGE=1` starts the server with the outage on.

Request body:

```json
{ "down": true }
```

Response 200:

```json
{ "contentStoreDown": true }
```

Errors: 400 `Request body is not valid JSON`.

## Decision bodies

Every decision has `gate`, `action` and `actor`. The actor needs `name` and `role`. The other fields depend on the action.

| Gate | Action | Other fields |
|---|---|---|
| `g1_accept_brief` | `approve` | none |
| `g1_accept_brief` | `reject` | `notes` (required) |
| `g2_approve_primary` | `approve` | `selections`: an object keyed `channel:locale`, one key per channel on the request. Each value has `variantId`, `fields`, or both. |
| `g2_approve_primary` | `changes_required` | `notes` (required) |
| `g3_approve_secondary` | `approve` | `locale`, `fields` (copy per channel, then per field), `checklist` (every item from `secondaryChecklist` set to `true`) |
| `g3_approve_secondary` | `veto` | `locale`, `notes` (required) |
| `g4_publish` | `publish` | `sampleChecked` (must be `true`) |
| `g4_publish` | `schedule` | `sampleChecked` (must be `true`), `scheduledFor` (an ISO date in the future) |
| `g4_publish` | `send_back` | `to` (`g2_approve_primary` or `g3_approve_secondary`), `notes` (required) |

### G1: accept the brief

```json
{
  "gate": "g1_accept_brief",
  "action": "approve",
  "actor": { "name": "Content project lead", "role": "content_project_lead" }
}
```

### G2: approve the primary copy

Variant ids have the form `{channel}-a{attempt}-v{n}`. Take them from `job.drafts`. In this example, four channels use a variant as written. The homepage selection also sends `fields`, so the edited text is used. `fields` replace the variant text completely, so send every field of the channel. Field names that the channel does not have are dropped.

```json
{
  "gate": "g2_approve_primary",
  "action": "approve",
  "actor": { "name": "Content manager", "role": "content_manager" },
  "selections": {
    "homepage:en": {
      "variantId": "homepage-a1-v1",
      "fields": {
        "headline": "Sample Brand, new on site",
        "line": "Italian knitwear in pure cashmere, made in small batches.",
        "cta": "Discover"
      }
    },
    "crm_email:en": { "variantId": "crm_email-a1-v1" },
    "social:en": { "variantId": "social-a1-v1" },
    "search_ad:en": { "variantId": "search_ad-a1-v1" },
    "display_banner:en": { "variantId": "display_banner-a1-v1" }
  }
}
```

In shadow mode, or when AI drafting is off, every selection must have `fields`.

### G3: approve the secondary-locale copy

The native editor writes the copy from the master brief. The values below are placeholders. In real use they are copy in the secondary language. Field names that a channel does not have are dropped, and every value is trimmed.

```json
{
  "gate": "g3_approve_secondary",
  "action": "approve",
  "actor": { "name": "Native editor", "role": "native_editor" },
  "locale": "ar",
  "fields": {
    "homepage": { "headline": "[ar] headline", "line": "[ar] line", "cta": "[ar] cta" },
    "crm_email": { "subject": "[ar] subject", "preheader": "[ar] preheader", "cta": "[ar] cta" },
    "social": { "caption": "[ar] caption" },
    "search_ad": { "headline_1": "[ar] headline_1", "headline_2": "[ar] headline_2", "description": "[ar] description" },
    "display_banner": { "headline": "[ar] headline", "cta": "[ar] cta" }
  },
  "checklist": {
    "Register and forms of address are right for the audience": true,
    "No cultural or religious sensitivity is broken": true,
    "Key dates and occasions are respected": true,
    "The meaning matches the locked master brief": true,
    "The copy fits every character limit": true
  }
}
```

### G4: publish

```json
{
  "gate": "g4_publish",
  "action": "publish",
  "actor": { "name": "Content manager", "role": "content_manager" },
  "sampleChecked": true
}
```

To schedule, set `"action": "schedule"` and add `"scheduledFor": "2026-10-20T09:00:00.000Z"`. To send the copy back, use:

```json
{
  "gate": "g4_publish",
  "action": "send_back",
  "actor": { "name": "Content manager", "role": "content_manager" },
  "to": "g2_approve_primary",
  "notes": "The CRM subject line repeats the headline"
}
```
