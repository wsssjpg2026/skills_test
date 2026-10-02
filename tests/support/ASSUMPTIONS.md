# Test-suite assumptions (kernel/engine/scenarios track)

Everything here is a point where `/tmp/spec-impl-notes/architecture.md` (the normative
source) is silent or ambiguous, and the tests encode the LEAST assumption that still
pins observable behavior. IDs are referenced in code comments as `A-XXX`. Anything the
implementation does differently will fail these tests at merge — that is deliberate:
each item needs a coordinator decision (adopt the assumption, or change the test).

## A-ADMIN-CREDS (blocking at merge)
§2.1: "First boot seeds `admin` (random password printed to log once)". Tests need
deterministic credentials. Resolution order in `boot.ts#resolveAdminCredentials`:
1. `auth.bootstrapAdmin: {username, password}` object form in config (preferred).
2. `ORCH_TEST_ADMIN_PASSWORD` env var.
3. Parse kernel stdout with regex `/admin[^\n]{0,80}?password[^\w:]*["':\s]+([^\s"',}]+)/i`.
The doc only specifies the boolean form. **Decision needed**: does the kernel accept an
object form (or env override) for tests, and what exactly does the seed log line look like?

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
Downsample assertions assume buckets are epoch-aligned: bucketTs =
floor(epochMs(ts)/intervalMs)*intervalMs, and each returned sample carries its bucket
(or first-sample-in-bucket) ts such that a client can group raw samples by that rule.
If the implementation aligns buckets to `from` instead, `history-api.test.ts` fails.

## A-HISTORY-DISABLED-TAG
Querying history for a tag with `historyEnabled:false` — unspecified. Tests assert the
response is `503 HISTORY_UNAVAILABLE` or `{samples: []}` (both accepted; envelope shape
still enforced on non-2xx).

## A-ECHO-PROVIDER
§10 #10 note: service-call ships with an in-kernel loopback provider `service:'echo'`.
Tests assume the echo response payload equals the request payloadTemplate verbatim
(after `{{ }}` interpolation), exposed as `nodes.<id>.response`.

## A-VAR-SPACE
`Condition.var` examples only show `nodes.<id>.response.x`. Tests additionally assume
task `input` is addressable as `input.<field>` in both templates and var conditions.

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
A per-node TIMEOUT with NO retry configured: the doc pins "retry exhausted ⇒ SUSPENDED
(retry_exhausted)" but not whether "no retry" means "exhausted on first attempt" (suspend)
or "no policy → onError/fail". engine-core's waitFor-timeout test accepts either terminal
`suspended{retry_exhausted}` or `failed` and asserts the step outcome TIMEOUT either way;
engine-timeout-retry pins the WITH-retry case firmly (suspend + exactly maxAttempts
executions). Coordinator: pick the no-retry disposition.

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
