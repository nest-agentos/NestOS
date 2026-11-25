# Dream host integration

`scanSources` isolates source failures and returns a cursor only after the same
principal, server and project identity, authorization revision, and project revision are confirmed before and
after a read. The caller supplies the authorized source adapter and must recheck
authority when stored evidence or derived content is consumed. The application
runtime and the Digital Twin workbench use this boundary.

The total scan limit is divided into fixed per-source quotas. A failed read keeps
its quota reserved because its actual work may be unknown. The adapter must
enforce its quota against actual underlying scanning and return an accurate count;
checking a returned receipt alone cannot enforce that requirement. Error and
diagnostic records do not include exception messages or source contents.

The application remote-source adapter binds the configured project, connection,
and required read capability to the project's live Cells authorization inspection.
Unknown, stale, denied or insufficient grants fail closed. A project-file adapter uses
the existing Twin reader for one explicitly selected file, including its protected
path and one-megabyte content limit. Its quota counts one whole file read, including
an unchanged file; it does not imply a bounded directory scan. The cursor combines
native identity and content hash, and unchanged content produces no model input.
The recorded `scanned` count covers the Dream source batch only; the existing Twin
scanner and the final version check can read the file again. Aggregate storage and
remote-protocol read costs have not yet been measured.

An explicitly selected local project file uses the same Twin reader and scanner.
The host checks the local project's access before configuration, dispatch,
execution recovery and evidence reads. Its source binding includes the project
identity and path; a changed binding invalidates the existing watermark. Local
selection requires the existing read-write project authorization and no remote
mounts. The default local project can be selected in the same form.

Evidence views recheck each selected source against the current authorization
port, hide evidence for denied or changed grants, and retain source-level failure
status. Callers must also fence the selected configuration against concurrent
changes before exposing the view; the application transport exposes only the
authorized host operations, not the underlying stores.

The application has a project-scoped SeqFile evidence store with idempotent run
receipts and transactional cursor comparisons. Its single-file adapter triggers
the existing published Twin scanner using a stable event ID, verifies the committed
job and durable Kernel call, and writes findings, receipt and watermark together.
Recovery reuses the event receipt; an unknown or failed execution is not replayed.
The current adapter supports one file of at most 32,768 UTF-16 code units per
execution and accepts fact candidates with supporting quotations. Published
scanners may additionally return `dreamFindings` with explicitly labelled
`inference` or `suggestion` entries and an exact supporting quote; malformed or
unsupported entries fail closed. Inferences and suggestions are not presented
as source-stated facts and do not execute automatically. Source bodies are not
stored in the Dream receipt.

The verification read accesses one selected plan, source and run directly. It also
scans the workspace's job and memory records to find the matching run: the existing
Twin reader examines up to 10,100 rows and then fails if the limit is exceeded;
memories have a separate 500-record capacity. It records actual row counts and
does not open unrelated sessions. This is not a production performance acceptance.
`openDreamSystemWorkspace` provides an owner-authorized filesystem view rooted in
the project's private system-data namespace; the integration test uses that view.
The metadata-only execution registry routes a scanner session to its owning
workspace after rechecking its frozen configuration, owner and source grant.
The application host owns and disposes the view. Scanner tool calls are denied
by default; supporting authorized read-only tools requires a separate capability
boundary.

The host configuration store keeps selected project files and frozen scanner
plan revisions under the owner project. Changes use revision comparison and stable
operation receipts. Configured scans check the revision before dispatch and in the
same transaction that commits their results. Source and owner grants are checked
again during execution and at model exchange. The history index keeps up to 20
requested entries per page using exact keys. Its `scanned` count is the number of
index entries requested, not a claim about backend physical I/O. Listing Dreams
reads all immediate owner-directory entries and then at most 100 configurations;
the response reports the directory count and whether the result was truncated.

The internal adoption adapter accepts an explicit user-authored task under an
existing Kanban coordination item. It checks the current source and target grants,
uses the Kanban command journal for lost replies, and verifies the created item's
Dream reference. The task starts in backlog with manual launch paused; creation is
not execution or acceptance. From the Digital Twin workbench, Dream can also
adopt a suggestion as a draft decision on an authorized board. A draft waits for
Kanban confirmation and an explicit start. Source task or decision links are
evidence, so the new decision can execute in its own task group. It supports selected files, directory changes, Sessions, Kanban
tasks and decisions, and verified adoption artifacts, with manual scans,
configuration pause, history, and memory review. Two active findings of the same
kind may be explicitly merged with their source revisions fenced in the commit;
both source records remain available and retrieval deduplicates only authorized
members. A later correction detaches the changed revision from that grouping.
Broader merge management and real-target acceptance remain unfinished. A user may bind
selected authorized sources from one or more runs of the same Dream to a Session
in the owner project. A binding may be explicitly replaced or removed.
Retrieval additionally requires the Agent's `dream` memory read scope, applies
the remaining retrieval limit, and rechecks the Session's project, configuration
revision, binding and each selected source grant before returning facts or inferences.
Suggestions never enter the conversation memory. The current picker pages only
the owner project's top-level Session folder.

The configuration may also select adopted Kanban items by stable source ID,
board and item. A selection change checks the original Dream adoption and its
current source and target authorization. A source ID stays bound to its original
board and item even after removal. The configured source adapter rechecks
the binding and configuration revision. A host-owned managed-artifact reader
allows Twin to read an authorized configured adoption without creating a project
file. Batch execution binds the existing published scanner, verifies the durable
task and commits findings and the artifact cursor in the same transaction. The
scanner settings are taken from the file source that produced the suggestion;
that source must remain configured and authorized.

An explicitly selected confirmed decision can be read by board and record ID
when the decision carries the selected project's `nestos-remote-project`
reference and that project remains authorized. The scanner receives only the
title, status, revision and update time. Each source read requests one decision
through Kanban's authorized point-read API; it does not enumerate board lists.
The current indexed SeqFile implementation reads the board manifest and selected
record row, and may additionally read the selected record's body asset. The
manifest contains board summary indexes of variable size. Legacy board storage
can embed full state in that manifest, so it may include unrelated bodies. The
reported `scanned` value is one requested decision, not the number of physical
storage reads or bytes. Authorization and Twin execution may repeat the point
read; aggregate I/O has not been measured.

An explicitly selected execution task can also be scanned by board and item ID
when the item carries the selected project's `nestos-remote-project` reference.
The authorized `item` point-read returns only the selected task body to the host;
Dream forwards its title, status, revision and update time. The same manifest,
selected-row, optional body-asset and legacy-layout limitations described for
decisions apply. Task projections may use other task summaries from the board
manifest, but Dream does not request or forward their bodies. The `scanned`
count is the number of requested tasks per source read, not aggregate I/O.
The configuration picker queries one authorized board page with an explicit
project reference; its `returned` count is the page size, not physical scans.
The Kanban query can read board summary indexes and filter more records than it
returns, including the legacy manifest limitations above.

A selected local Session can use a head window of 1–20 rounds. It reads the
Session manifest before and after following at most that many history-parent
links; no recent-Session list is queried. Only public user and assistant text is
forwarded, capped at 32,768 UTF-8 bytes. The cursor is derived from the selected
window's content and stable Session identity. Each `readRound` loads its entire
selected round, including fields that are filtered out before scanning; the
underlying physical read size is not bounded by the output cap. An explicitly
selected remote harness Session requires the provenance-filtered Cells digest
and a native history revision. Metadata-only checks fence the selected Session;
an unchanged revision skips history reads. A changed revision reads one newest
page using `expectedRevision`, then rechecks metadata. Only classified user
text and visible assistant text from at most 20 turns are forwarded; unclassified
content, missing revision or missing I/O accounting fail closed. No Session list
or older page is requested. The Codex adapter reads at most 8 MiB of the selected
log plus at most 8 MiB of preceding context per page, and reports both actual
byte counts. It fails if the context limit cannot establish the turn boundary.
Those counts exclude native Session metadata RPCs and repeated checks during
execution. The Claude adapter reports up to 8 MiB of history and up to 1 MiB
of preceding turn context, and rejects a trailing incomplete record when
producing a digest. Its history revision includes file identity, size and
nanosecond modification/change times. Other providers without this accounting are rejected rather than
assumed bounded. This requires the updated Cells server and cells-driver; the
older protocol does not provide the needed revision and read-cost evidence.
The selected Harness digest and its captured snapshot are limited to 256 KiB of
UTF-8 text, including the serialized message metadata. Dream verifies each
32K-character scanner chunk and retains every task receipt before settlement;
the configured run and model context budgets still apply. A larger digest is
rejected without advancing its source cursor. The byte limit does not bound the
underlying history and context scan sizes described above.
The explicit source picker loads profiles and one page of up to 50 Session
summaries on demand. `returned` describes that page, not the native catalog's
physical scan, which depends on the provider and is not measured here.

Change sources select one project directory, explicit excluded subtrees and at
most 128 returned entries per snapshot. Dream reads only ordinary documents,
skips protected nodes, hidden paths and excluded subtrees, and never writes to
the source. It reads the tree twice, verifies file versions and compares the
resulting content snapshot; the content digest and project binding form the
cursor. An incomplete or oversized snapshot fails without advancing it. Each
pass allows at most 32 directories and 32 KiB of document content and serialized
snapshot; nested project mounts are rejected. Logs record the actual number of
entries returned and directories enumerated across both passes. The generic
Dream evidence `scanned` field counts one source snapshot, not physical entries.
VFS `getChildren` returns a whole directory before the entry limit is checked,
so this limit does not bound the physical size of a single directory response.
Execution and authorization rechecks can repeat the snapshot and its reads.

Schedules use Kanban's recurrence validation and time calculation and a durable
Kernel timer with one child round at a time. Delayed ticks coalesce to one round;
the child uses stable batch and scanner identities. The owner-scoped configuration
and schedule index are committed together. Task admission is recorded before the
task starts, and a replaced schedule waits for the old task to settle. The host
checks the registered parent, child and configuration revision before advancing a
schedule or scanning. The UI distinguishes saved configuration from pending
activation and displays the last round when available. Real remote, crash-matrix
and page-performance acceptance have not yet been completed.

An explicitly configured consolidation Flow runs after a source scan in the same
manual or scheduled batch. Its Session and submission identity are persisted;
source permissions are checked before and after execution and on Session use.
Pending proposal reads filter by current source permissions. The host can commit a
selected ready subset with an expected active version, recording a review receipt
and an Outbox entry in the same transaction. Batch runs group newly captured
evidence by project; an explicit joint setting fixes the selected participating
projects and checks their grants during model execution. Evidence receipts and
the proposal are settled in one transaction. Existing memory and proposals are
included only when their source scopes belong to the frozen participants; the
result retains the union of scopes actually used. The Dream page can configure
the Flow, optional focus, hot-load budget and joint mode, and review a selected
page of proposals. The rollback command targets a committed receipt, rechecks
current and target authorization, and writes a new version and Outbox event;
it leaves source watermarks unchanged. New rollback receipts record the target
commit in the same transaction; downstream contributions expose that reference
and the evidence from the target's proposal history. The UI can inspect both
committed versions and authorized captured evidence. Earlier rollback receipts
that recorded only a request fingerprint cannot reconstruct the target. The
Outbox independently persists daily contributions and reviewable decision
candidates; explicit adoption still creates a draft through the existing Kanban
receipt path. A cross-project session must explicitly bind every required source
through currently authorized scan receipts before loading the joint version;
unbound or partially bound sessions remain excluded. Committed and pending material whose
source authorization becomes unavailable is filtered on reads; a separate
background reconciler records a durable, idempotent recomputation request. It
rechecks the remaining sources, uses their captured snapshots, and keeps the
independent project's context and receipts separate from joint consolidation.
Authorization-change notifications wake it, and bounded catalog scans recover
missed notifications and older configurations. Recompute currently uses the
latest captured snapshot per source. It verifies a live grant and permits a
changed authorization revision only when principal, server and server-project
identity still match the captured binding; a revoked grant or changed identity
is rejected. Real remote authorization changes and large legacy capture
indexes need further acceptance.
Pending proposal pagination uses a scope generation and an offset; a changed
scope rejects the cursor rather than silently skipping entries. `scanned` counts
the index rows returned for that page, not the backend's physical work to reach
the offset. The cursor contains no proposal identity.

Authorized same-project Sessions can read the active version through the existing
Dream memory policy. Hot loading uses a project budget (default 1,500), a host
limit and the context plan limit; absent a trusted tokenizer, it conservatively
counts UTF-8 bytes of each final memory message and subtracts the assembled
session context and other selected memories. Authorized critical constraints
are loaded first, followed by topic pointers; each group is ordered by explicit
priority, update time and stable ID. Older entries default to constraints with
priority and update time zero. A truncation hint is included when it fits.
`dream_search` and `dream_read` recheck the persisted
agent Task's allowed tools and Dream read scope, then reauthorize the Session's
project and current active version. Cross-project reads require all referenced
scopes to be bound and authorized. Search returns at most 50 matches and does
not yet provide pagination. Real remote authorization and end-to-end injection
acceptance remain open.


The portable scan and evidence validation package lives in
[libraries/dream](../../libraries/dream/README.md). Its VFS entry receives the
authorized filesystem, evidence path and transactional configuration revision
reader from the host. NestOS continues using its existing project-scoped
`config.seq` and `evidence.seq` paths and record keys. The host retains the
Kanban adoption policy and receipts, project readers, scanner bindings,
session integration and scheduling.
