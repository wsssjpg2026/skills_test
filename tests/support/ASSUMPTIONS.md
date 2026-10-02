# Test-suite assumptions (kernel/engine/scenarios track)

Everything here is a point where `/tmp/spec-impl-notes/architecture.md` (the normative
source) is silent or ambiguous, and the tests encode the LEAST assumption that still
pins observable behavior. IDs are referenced in code comments as `A-XXX`. Anything the
implementation does differently will fail these tests at merge — that is deliberate:
each item needs a coordinator decision (adopt the assumption, or change the test).

## ADJUDICATED (coordinator rulings in /tmp/spec-impl-notes/adjudications.md — tests now pin these)

## A-ADMIN-CREDS (ADJUDICATED)
The test-auth seam is env `ORCH_ADMIN_PASSWORD`: `bootKernel`/`spawnKernel` expose a
`bootstrapAdminPassword` option mapping to it; env wins over any config-file value;
`auth.bootstrapAdmin: false` disables bootstrapping. Tests never parse the log for the
random seed password (the boolean config form is the only one used).

## A-WEBHOOK / A5 trigger binding (ADJUDICATED)
The webhook token belongs to the FLOW (logical id), not the version: `GET /flows/{flowId}`
returns `{id, name, webhookToken, currentVersion}`; the token is generated at flow
creation and survives version bumps; `POST /flows/{flowId}/webhook-token` rotates it
(old token becomes invalid). Flow specs may declare `triggers?: [{kind:'webhook'} |
{kind:'mes', op}]` — a matching inbound MES event enqueues a task with `input = payload`.

## A-TIMEOUT-NORETRY (ADJUDICATED)
Default `retry.maxAttempts = 1`. A TIMEOUT (like a technical FAILURE) enters the retry
path; with retries exhausted it becomes `SUSPENDED(retry_exhausted)` — never an immediate
silent fail. `onError:'fail'` opts out (fail fast). engine-core and engine-timeout-retry
pin both dispositions.

## A-HISTORY-BUCKETS (ADJUDICATED)
Downsample buckets are epoch-aligned (`bucketStart = floor(ts / intervalMs) * intervalMs`),
`fn` computed over samples within each bucket, empty buckets omitted, `order=asc` default.

## A-PLUGIN-IDS
`channel.driver` = plugin id (§2.1) but the ids of the shipped simulators are never
written down. Tests assume manifests exist in repo `plugins/` (§6.1) with ids
`mock-driver` and `sim-robot` (matching `@orch/mock-driver` / `@orch/sim-robot` package
names minus scope). `plugins.dir` defaults to `<repoRoot>/plugins`.

## A-PORT-0
`bootKernel` assumes `server.port: 0` = ephemeral and the returned kernel handle
exposes the actually-bound port (`kernel.port`). `spawnKernel` avoids the question by
allocating a free port itself and pinning it in the written config (only requires
"kernel listens on the configured port").

## A-WEBHOOK
§2.1 `POST /triggers/webhook/{token}` — "token bound at flow level", but §2.4's
FlowDefinition has no trigger/webhook field. Tests accept the token from either
`FlowVersion.webhookToken` (response field) or `spec.triggers.webhook.token`
(also mirrored as an optional field in our type stub). Wrong token → 401.

## A-WEBHOOK
ADJUDICATED — see the ruled block at the top.

## A-WS-PATH
WS endpoints are documented as `GET /ws/tags` (§2.2) — assumed NOT under `/api/v1`.
Tests connect to `ws://127.0.0.1:<port>/ws/tags`.

## A-WS-BADAUTH
For hello with an invalid token the doc only says "first frame must authenticate".
Tests assert: no `welcome` ever arrives; an `error` frame and/or socket close occurs.
No specific error code is asserted.

## A-HEALTH-STATUS
`/health/*` returns `{status, ...}` without stating the healthy literal. Tests assert
`status === 'ok'` and `storage.ok === true` for a healthy embedded kernel.

## A-ALARM-CLOSED
§3.6: RTN+ACK / RTN-while-acked → "Normal (close)". Tests assume a closed instance no
longer appears in `GET /alarms` (state=Normal means no row), and that alarm lifecycle
events (`alarm.raised/...`) are NOT in the per-task event history (the mirror's
consumer surface is unspecified — not asserted).

## A-ALARM-EVENTS-SURFACE
The doc's closed event set includes `alarm.*` mirrors of §3.6 but never says where they
are observable (they are TaskEvents, yet alarms are not tasks). Not asserted anywhere;
flagged for the coordinator.

## A-HISTORY-BUCKETS
ADJUDICATED — see the ruled block at the top.

## A-HISTORY-DISABLED-TAG
Querying history for a tag with `historyEnabled:false` — unspecified. Tests assert the
response is `503 HISTORY_UNAVAILABLE` or `{samples: []}` (both accepted; envelope shape
still enforced on non-2xx).

## A-ECHO-PROVIDER (ADJUDICATED)
§10 #10 note + ruling: `service:'echo'` (test-only loopback) responds with the
interpolated payload verbatim: `nodes.<id>.response = <payload>`.

## A-VAR-SPACE (ADJUDICATED)
Template variable space everywhere: `input.*`, `vars.*` (task vars),
`nodes.<id>.response.*`, `nodes.<id>.result.*`.

## A-TEMPLATE-TYPE
"whole-string single template preserves the referenced value's type" (§2.4). Tests
assert numeric type preservation behaviorally via `gt` conditions on echoed values.

## A-ERROR-KINDS
Which runtime failures are `kind:'business'` vs `kind:'technical'` is layered (spec)
but not enumerated. Tests assume: per-node timeout and device/comm failures are
technical (retryable path); robot command rejection/completion-failure surfaced on the
`failed` port is business (no retry unless configured).

## A-COMMAND-RECOVERY
§3.4 in-flight command recovery: "re-issue if idempotent, query command.status if
capability present, otherwise suspend with recovery_verify". robot-command nodes have
no `idempotent` field in §2.4, so recovery tests cover: `commandStatus:'queryable'`
(§5.2 sim-robot config) → query & complete; `commandStatus` absent → capability off →
suspend with reason `recovery_verify`. Assumed absent key = capability off.

## A-SEED-SCHEMA
§5.3 names the scenario files but not their JSON shapes. `scenarios/pick-place/*.json`
define the de-facto schema (see fixtures.ts `Scenario` interface). If the scenario
loader in @orch/testing expects a different shape, fixtures move — assertions unchanged.

## A-SIMMES-EXPORT
`startSimMes` assumes `@orch/sim-mes` exports `createMesServer(config & {port})`
returning `{port, received, sent, close}`. Export name/shape needs pinning at merge
(or tests use the @orch/testing-wrapped starter instead).

## A-MOCK-SET-KEYS
§5.2 mock-driver `set` maps are assumed keyed by tag NAME, scoped unambiguously because
tests use a single device per mock channel. `quality` entries name devices via
`devices:[name]` — also assumed to be device NAMES (doc example uses "d1", a name).

## A-MOCK-WRITES
Engine tests write to mock-driver tags through device-command nodes / tag-write actions
(saga markers). Assumes mock-driver declares the `write` capability and applies writes to
its in-memory state (readable back via /tags/values). The doc does not spell out
mock-driver capabilities.

## A-TIMEOUT-NORETRY
ADJUDICATED — see the ruled block at the top.

## A-BYTEORDER-MOCK
`POST /devices/{id}/diagnostics/byteorder` (§2.1) tested against mock-driver:
assumed write+readback is honest (readBack === testValue, ok === true). The 25600
mismatch case is a Modbus-specific behavior (ticket #5), not asserted here.

## A-USER-ROLES-REF
`POST /users {username,password,roles}` — assumed `roles` accepts role IDs as returned
by `POST /roles`. (Names also plausible.)

## A-AUDIT-SHAPE
Audit record fields beyond the §2.1 query params (`actor`, `action`, `resourceType`,
`from`, `to`) are unspecified; tests only assert those three fields exist and that
filters narrow the result set.

## A-STOP-SEMANTICS
"Stopped = controlled wind-down after current step" (§4.2) is ambiguous about whether
the in-flight step runs to completion. Tests only assert: terminal status `stopped`,
`task.stopped` event, compensations run (when registered), and no compensation on
abort. Step-level outcome during stop is not pinned.

## A-COMP-FAIL
`compensation.failed` is triggered in tests via a tag-write compensation to a
nonexistent TagPath, assuming deploy-time validation does NOT resolve TagPath
references in node writes (runtime resolution). If flow validation rejects unknown
tag paths at deploy, that test needs a different failure injection.

## A-QUEUE-FIFO
Task start ordering across queued tasks is unspecified; tests never assert inter-task
ordering except where the resource mutex explicitly guarantees FIFO waiters.

## A-VERSION-RACE
Concurrent `POST /flows/{id}/versions` — doc says CONFLICT 409 on "version race".
Tests fire two concurrent publishes and accept outcomes: both 2xx with distinct
monotonic versions, or one 2xx + one 409. Asserted: final version list is strictly
monotonic, unique, and grows by 1 or 2.
