# Product requirements document: Matt's Second Brain

Status: draft v0.1, 8 October 2026. Owner: Matt. Architecture proposal: [concept and stack](concept.md).

This document specifies a proposed product. Requirements, benchmark envelopes, and estimates below have not yet been implemented or validated.

## 1. Problem and desired outcome

Knowledge accumulates across notes, documents, web pages, experiments, and assistant conversations. Finding a related document does not establish whether a particular statement is supported, still applicable, or contradicted elsewhere.

Build a private second brain that captures and imports knowledge, connects it in a graph, retrieves it through a web app and MCP, and exposes provenance, evidence assessment, and freshness with every claim.

The successful experience is: “I can find what I learned, see why I believe it, recognize what needs checking, and reuse the same knowledge from my other tools.”

## 2. Users and jobs

Primary user: one owner who learns, builds projects, records decisions, and revisits technical/personal knowledge. Secondary consumers: authorized AI assistants and applications acting for the owner.

| Job      | User story                                                                                   |
| -------- | -------------------------------------------------------------------------------------------- |
| Capture  | As the owner, I can save a thought, observation, or source without designing its graph first |
| Import   | I can import a document or public page and inspect what was extracted                        |
| Retrieve | I can find relevant knowledge through exact terms or a natural-language query                |
| Trust    | I can inspect a claim's evidence, context, age, and review history                           |
| Connect  | I can explore how concepts, claims, sources, and project decisions relate                    |
| Maintain | I can resolve duplicates/conflicts and review knowledge likely to have changed               |
| Reuse    | My authorized MCP clients can read knowledge and propose new material                        |
| Control  | I can export, archive, or remove my knowledge and its derived artifacts                      |

## 3. Goals and boundaries

### MVP goals

- Deliver a complete capture/import → review → retrieval → graph → MCP workflow.
- Preserve exact source references for extracted factual claims.
- Separate personal knowledge, hypotheses, cited statements, and inferred conclusions.
- Make freshness and temporal scope explicit without deleting knowledge merely because it is old.
- Provide useful graph neighborhoods and a manageable review queue.
- Run privately on a single host and keep the owner's data exportable.

### Out of scope for the MVP

- Shared team workspaces and enterprise permission administration.
- Autonomous web research, automatic truth certification, or unreviewed destructive agent actions.
- Email/cloud-drive connectors, continuous folder synchronization, and browser extension.
- Scanned-PDF OCR guarantees, audio/video ingestion, and every office file format.
- Whole-corpus graph rendering, graph analytics, and automatically generated global community reports.
- Public SaaS operations, high availability, and billing.

Private remote MCP access is supported only after its authorization and TLS release gates pass. Local web/MCP use does not require publishing a public service.

## 4. Core workflows

### A. Import and build knowledge

Owner uploads a supported file or submits a public URL → receives an import ID → sees parsing/indexing progress → source text becomes searchable → candidate claims and relationships appear in the inbox → owner edits/accepts/rejects candidates → accepted knowledge joins normal retrieval and graph views.

Failures show the failed stage, preserved progress, and a retry option. A second identical submission returns the same job or existing revision instead of duplicating claims. Changed source content creates a new revision.

### B. Ask and inspect evidence

Owner asks a question → system retrieves accessible passages/claims → optionally generates an evidence-backed answer → owner opens a citation → exact retained source excerpt and revision are displayed → owner can inspect quality, time scope, conflicts, and graph context.

Insufficient evidence produces an explicit knowledge gap. Candidate claims are separated from accepted material. A supporting passage means that a source makes an assertion; it does not imply the assertion is objectively true.

### C. Maintain changing knowledge

A review becomes due or evidence changes → system queues the claim and dependent summaries → owner checks the current source/context → records substantive verification, updates the claim, or marks it superseded → earlier versions remain available for historical queries.

Simply opening the claim or fetching unchanged content does not renew its verification date. A failed fetch is recorded as an unsuccessful check.

### D. Use MCP

Authorized client searches and retrieves structured evidence → adds a note or imports a source → receives IDs and job status → proposed claims enter review. The same operation through REST and MCP produces equivalent domain records and authorization outcomes.

## 5. Functional requirements

P0 is required for the first usable release. P1 follows after that release.

| ID     | Priority | Requirement                                                  | Acceptance criteria                                                                                                                                                                                 |
| ------ | -------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CAP-01 | P0       | Capture a note with kind, topic/project, and visibility      | Note is saved with stable ID/revision and retrievable through web and MCP; first-person notes are explicitly self-reported                                                                          |
| IMP-01 | P0       | Import UTF-8 Markdown/text, text PDFs, and public HTML pages | A fixture of each format retains source text, immutable revision hash, language, and citation anchors; unsupported/scanned inputs get a clear warning                                               |
| IMP-02 | P0       | Durable asynchronous imports                                 | Import responds with job ID; stage/progress/errors survive a worker restart; retry does not duplicate records                                                                                       |
| IMP-03 | P0       | Source revisioning and duplicate handling                    | Same content within an authorized collection reuses a revision; changed content creates a linked revision; near-duplicates are suggestions, not silent merges                                       |
| KNO-01 | P0       | Structured candidate extraction                              | Every extracted factual claim has valid source anchors and context, or is rejected/flagged for manual input; model/prompt/parser versions are retained                                              |
| KNO-02 | P0       | Entity/relationship curation                                 | Owner can inspect suggested aliases and merge entities with an audit trail; factual graph edges reference backing claims; rejected suggestions are excluded by default                              |
| KNO-03 | P0       | Evidence attachment and challenges                           | Owner/client can attach support or challenge references; copied-source lineage is retained; generated summaries cannot self-corroborate                                                             |
| QLT-01 | P0       | Separate acceptance, evidence, freshness, and validity       | Accepted self-reported knowledge remains self-reported; stale corroborated claims remain distinguishable from unsupported current claims                                                            |
| QLT-02 | P0       | Review queue and configurable freshness policies             | Owner sets category/item review intervals; due items enter queue; null verification remains unknown; viewing an item cannot renew it                                                                |
| QLT-03 | P0       | Contextual conflict/supersession                             | Manual conflict/supersession links work; same subject/predicate with different values and overlapping scope/time raises a candidate conflict; nonoverlapping versions do not automatically conflict |
| QLT-04 | P0       | Dependency invalidation                                      | Evidence retraction/change or claim edits flag dependent verification and summaries for reassessment; stale derived outputs cannot appear as current without warning                                |
| RET-01 | P0       | Hybrid retrieval                                             | Exact terms and paraphrases retrieve expected authorized evidence; results expose source/claim IDs, quality dimensions, and pagination                                                              |
| RET-02 | P0       | Current/historical views                                     | Current defaults exclude expired/superseded claims; stale hits are labeled; valid-time and recorded-time queries return the correct fixture versions                                                |
| RET-03 | P0       | Cited answer mode                                            | Each factual assertion references accessible evidence or is explicitly marked as inference/unsupported; insufficient evidence yields a knowledge-gap response                                       |
| GRA-01 | P0       | Interactive graph explorer                                   | Owner focuses a node, expands neighbors, filters by type/status/time, and opens evidence; budgets and truncation are visible; list alternative exists                                               |
| MCP-01 | P0       | Typed read/write MCP tools                                   | Search, detail, graph, capture, import, evidence, review, update, archive, and job-status tools work with the selected SDK/client compatibility matrix                                              |
| MCP-02 | P0       | Shared permissions and safe writes                           | Read-only credentials cannot write; write-only authority cannot verify; unauthorized IDs reveal no private details; retries are idempotent; obsolete expected versions fail with conflict           |
| DAT-01 | P0       | Portable export and recovery                                 | Export contains source snapshots, notes, claims, relations, evidence, reviews, and versions; restore to a clean instance preserves IDs and rebuilds retrieval/graph behavior                        |
| DAT-02 | P0       | Archive and forget                                           | Archive is reversible and excluded from default views; deletion immediately blocks retrieval, including dependent outputs, and purges live derivatives through a tracked job                        |
| OPS-01 | P0       | Observable and budgeted processing                           | Owner can see failed jobs, backlog, per-import model usage, and budget stops; logs avoid raw private content and credentials                                                                        |
| EXT-01 | P1       | Connector/sync interfaces                                    | Later adapters retain origin identity, revisions, access context, and import semantics; connector scope determined separately                                                                       |
| DIS-01 | P1       | Topic summaries and discovery                                | Summaries link to versioned dependencies; proposed connections/knowledge gaps appear as suggestions with provenance                                                                                 |
| REV-01 | P1       | Assisted scheduled revalidation                              | Owner configures allowed origins and budgets; checks produce new snapshots and review proposals, never silently certify truth                                                                       |

Automated conflict detection in P0 is deliberately narrow: structured claims with matching normalized subject/predicate and overlapping context. General semantic contradiction discovery is P1.

## 6. Data and lifecycle rules

Canonical records: sources, immutable source revisions, passages, entities, notes, claims, evidence assessments, typed relations, reviews, derivations, jobs, and audit events. See the concept for proposed fields.

Mandatory rules:

1. Claims preserve human-readable statements even when structured triples are available.
2. Evidence references an immutable revision and resolvable passage/observation anchor.
3. Source, claim, and relation edits create history; concurrent updates require expected versions.
4. Acceptance does not imply verified truth. Verification records identify actor, rationale, examined evidence, and time.
5. Lifecycle, freshness, evidence assessment, and conflict flags are independent dimensions.
6. Valid-from/valid-to intervals use an agreed half-open convention; recorded versions retain when the system learned or changed a claim. Unknown dates stay null, with explicit uncertainty.
7. A review interval never authorizes deletion. Retention settings are independent.
8. Source lineage is considered when reporting corroboration. Raw citation count is not independent-source count.
9. Every query applies access control before exposing content, counts, graph neighbors, citations, or answer context.
10. Deletion/visibility reduction invalidates cached answers, graph projections, embeddings, and affected derived outputs. Shared claims with remaining evidence are reassessed rather than indiscriminately removed.
11. Audit records must not retain erased private content. Backup retention and tombstone replay prevent a restore from reviving forgotten material.
12. Embeddings are rebuildable derivatives; vectors from different model namespaces are never mixed in similarity queries.

Freshness follows the concept's explicit precedence: expired applicability first; otherwise unknown without verification; then current, review due, and stale based on review date and configurable grace period. Use 30 days as the initial grace period. Verification against evidence updates `verified_at`; acceptance alone updates review history without renewing verification.

Supported kinds initially: factual assertion, personal observation, preference, hypothesis, and derived inference. Project decisions are notes linked to their rationale and claims.

## 7. Interface contracts

### Web/API

The UI uses application endpoints for notes/claims, sources/imports, search/answers, graph neighborhoods, reviews, exports, and deletion jobs. REST and MCP are adapters over shared application services, with shared schema definitions where practical.

Long-running operations return IDs and use polling initially. Add streaming only where it materially improves the experience. File imports use uploaded-file IDs; neither interface accepts arbitrary host filesystem paths.

### MCP

Required tools: `search_knowledge`, `get_knowledge`, `query_graph`, `add_knowledge`, `import_source`, `get_import_job`, `attach_evidence`, `review_knowledge`, `update_knowledge`, and `archive_knowledge`.

Contract expectations:

- Read responses include stable IDs, versions, citation anchors, quality fields, warnings, and `as_of` time.
- Graph responses return nodes/edges, requested filters, continuation/truncation information, and enforced budgets.
- Imports return a job ID, not a blocked request waiting for extraction.
- Writes accept an idempotency key. Reusing a key with a different payload is a conflict.
- Edits, archival, and reviews check the expected target version.
- Search filters include project/topic, knowledge kind, temporal mode, stale inclusion, and evidence/review status.
- Authorization errors are distinct from validation errors; inaccessible objects do not disclose existence through detail responses.
- Owner review credentials are separate from routine assistant write credentials.

Use Streamable HTTP for protected remote access and stdio for local integrations if needed. Test discovery, auth, tool schemas, pagination, errors, retries, and protocol-version compatibility with at least one chosen remote client and one local client before claiming interoperability. [MCP transports](https://modelcontextprotocol.io/specification/latest/basic/transports), [authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [tools](https://modelcontextprotocol.io/specification/latest/server/tools).

## 8. UX requirements

- Capture is always available from primary navigation.
- Inbox separates import failures from pending knowledge review.
- Search presents readable result cards with claim/source distinction, evidence label, and verification date.
- Answer citations open the stored excerpt even when the original website is unavailable.
- Knowledge detail separates “accepted by me” from “verified against evidence.”
- Review queue prioritizes changing/high-use/project-relevant knowledge rather than treating every old item equally.
- Graph opens around the current topic/project, with evidence nodes collapsed by default.
- Graph states are explained in a legend and an accessible table/list; color is not the only signal.
- Conflicts show both sides and their scopes; the UI offers resolve, keep both with context, or leave contested.
- Empty/insufficient results explain which knowledge is missing and provide a capture/import action.
- Export and forget are owner settings with progress and a clear explanation of backup retention.

## 9. Nonfunctional requirements and release gates

Targets below are provisional. Use a documented reference machine, starting with an 8-core CPU/32 GB RAM/SSD host and two concurrent interactive users. No hosted-model latency or capacity is implied by these local targets.

| Area                | Proposed target / gate                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Retrieval latency   | Warm-index hybrid + bounded graph search p95 ≤ 2 seconds at the benchmark envelope; includes query embedding, excludes answer generation       |
| Graph latency       | Server neighborhood response p95 ≤ 1 second; max 250 nodes/500 edges; separate browser rendering measurement on a documented client            |
| Job submission      | Local capture/import acknowledgment p95 ≤ 1 second, excluding upload transfer or remote OAuth interaction                                      |
| Extraction/answers  | Async progress/clear timeout; measure provider latency separately, report rather than promise an untested limit                                |
| Reliability         | Worker/broker interruptions recover from canonical jobs/outbox; repeated stages do not duplicate claims                                        |
| Input bounds        | Initial upload cap 25 MB, PDF cap 200 pages, HTML fetch cap 10 MB/30 seconds; configurable token/claim ceilings and visible budget failures    |
| Privacy             | Private by default; hosted-model transmission requires owner-configured policy; secrets/raw sources excluded from routine logs                 |
| Access              | All REST/MCP/search/graph/export paths enforce owner/collection access; remote HTTP requires TLS and compatible OAuth token/discovery handling |
| Ingestion isolation | Reject loopback/private/link-local/metadata fetch targets, including redirects and DNS changes; sandbox file parsing and limit resources       |
| Untrusted content   | Imported instructions cannot issue tool calls or grant permissions; extraction uses bounded structured outputs and validated references        |
| Backup              | Daily backup when deployed; proposed RPO 24 hours/RTO 4 hours, verified through a restore drill on the reference host                          |
| Retention           | Owner-configurable backup retention; forgotten IDs replayed as tombstones during restore; no indefinite private content in audit logs          |
| Portability         | Documented Markdown/JSON export plus original sources; schema migrations and index rebuild procedure tested                                    |
| Cost                | Track tokens/model calls per import and answer; configurable hard budget stops; no cost estimate without actual model/workload measurements    |

The localhost development profile may use the owner's local identity. It must bind to loopback and is not approved for remote exposure. A remote deployment adds the authorization-server integration and passes the same access tests for both adapters.

## 10. Evaluation and success measures

Create an owner-relevant benchmark before tuning retrieval. Proposed fixture set: 100 representative documents and 60 labeled questions: 20 exact/name lookups, 20 semantic lookups, 10 graph/context questions, and 10 temporal/conflict/insufficient-evidence questions. Include German/English pairs, copied sources, changing vendor documentation, personal observations, and a retracted source.

### Proposed quality gates

| Measure                    | Definition                                                                                         | Draft target                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Extraction precision       | Sampled extracted claims faithfully represented by cited passages                                  | ≥ 90% on at least 100 manually labeled candidate claims |
| Evidence recall@10         | Fraction of labeled relevant evidence retrieved in top 10                                          | ≥ 85% overall; report every query category separately   |
| Citation validity          | Citation IDs/anchors resolve to accessible retained excerpts                                       | 100% of release fixtures                                |
| Answer support             | Factual statements entailed by cited evidence or correctly qualified as source assertions          | ≥ 95% in manually reviewed benchmark answers            |
| Knowledge-gap behavior     | Unanswerable fixtures produce explicit uncertainty without invented factual answers                | 100% of designated negative fixtures                    |
| Temporal/conflict behavior | Correct applicability filters and conflict warnings                                                | 100% of deterministic lifecycle fixtures                |
| Access isolation           | Inaccessible material never appears through results, graph, citations, caches, exports, or answers | 100% of access fixtures                                 |
| Recovery/idempotency       | Crash/retry fixtures retain progress without duplicate accepted knowledge                          | 100% of fault-injection fixtures                        |

These are acceptance goals, not measured claims. Record scorer instructions, sample counts, disagreements, hardware, model versions, and configuration. Small samples give limited confidence; report failures and category results rather than relying on one headline score.

Compare lexical-only, vector-only, hybrid, and hybrid-plus-graph retrieval on identical fixtures. Ship the graph-assisted query path where it improves contextual questions without unacceptable latency or regressions. Filtered vector recall receives its own check against exact search.

### Owner beta measures

- Time to capture a note: proposed median under 20 seconds.
- Time to locate evidence for a remembered topic: proposed median under 60 seconds.
- Review burden: track queue growth, median review time, and weekly time spent; tune extraction volume and freshness policies accordingly.
- Useful connections: owner marks at least five graph-derived connections/decision links as useful during the first month.
- Continued usefulness: weekly knowledge reuse through either web or MCP, evaluated qualitatively as well as by usage.

## 11. Milestones and implementation order

Effort ranges below are rough planning estimates for one experienced developer working full time. They exclude large connector work and assume available model credentials/hardware. Total MVP planning envelope is approximately 7–12 developer weeks; revise after the first spike.

| Milestone                       | Indicative effort                    | Deliverable and exit gate                                                                                                                                                    |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0: design/evaluation spike     | 3–5 days                             | Confirm local/remote profile, corpus, model candidate, schema, citations, and SDK/client compatibility; parse/embed 20 representative documents and publish measured results |
| M1: complete thin workflow      | 1–2 weeks                            | Markdown/text capture/import, durable jobs, candidate review, hybrid retrieval, minimal graph, and MCP search/add/import on shared services; one document works end to end   |
| M2: reliable ingestion/curation | 1–2 weeks                            | PDF/URL adapters, anchors, dedup/revisions, evidence attachment, entity curation, budgets, and fault recovery                                                                |
| M3: trust/time and useful UI    | 2–3 weeks                            | Quality dimensions, review queue, versioned validity, narrow conflicts, dependency invalidation, cited answers, and graph detail/filter UX                                   |
| M4: release hardening           | 2–3 weeks                            | Complete tool set, export/forget, backup restore, reference benchmarks, access/input tests; remote OAuth/TLS gate if deploying remotely                                      |
| M5: owner beta                  | 2 calendar weeks alongside iteration | Use real knowledge; tune review load, relevance, graph usefulness, and policies; decide next connectors/features                                                             |

Definition of MVP done: all P0 acceptance criteria pass, the owner completes workflows A–D using representative knowledge, quality/performance results are recorded, and export/restore plus deletion propagation have been demonstrated. Remote access is enabled only for a profile that passes its auth gate.

## 12. Risks and open decisions

| Risk                         | Planned response                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Hallucinated facts/relations | Source anchors, validated extraction, candidate review, and support evaluation                                               |
| Wrong entity merges          | Alias suggestions, contextual review, audit history, and reversible merges                                                   |
| False corroboration          | Evidence lineage and separate support/challenge assessments                                                                  |
| Review overload              | Small initial extraction scope, batch actions, prioritized queue, and configurable intervals                                 |
| Misleading graph             | Typed edges, backing claims, visible candidates, and bounded neighborhoods                                                   |
| Long/costly imports          | Durable staged jobs, budgets, checkpoints, and limited formats                                                               |
| Hosted-model exposure        | Explicit transmission policy and local embedding baseline; fully local extraction is a separate quality/performance decision |
| Stale copies after deletion  | Dependency tracking, retrieval tombstones, derivative invalidation, and restore replay                                       |
| Protocol/client differences  | Pin compatible SDK versions and test selected clients before release                                                         |

Decisions to resolve in M0, with proposed defaults:

- Deployment: local/private single host first; remote access optional after authentication integration.
- First knowledge domains: two or three recurring project topics, chosen with the owner.
- Privacy: local embeddings; extraction/answer provider selected based on what material may leave the host.
- LLM: one provider/model selected against the extraction and support gates; avoid premature multi-provider orchestration.
- Knowledge promotion: AI extraction always starts as candidate; owner-authored notes are accepted as self-reported.
- Freshness: category policies from the concept, tuned during beta; no automatic deletion for staleness.
- Database: PostgreSQL/pgvector initially; revisit only with measured graph requirements.
- Remote clients/auth server: name the initial clients and select an authorization server that meets their MCP requirements.
- Availability/storage: confirm desired backup destination, retention, and recovery targets before deployment.

## 13. First implementation slice

Build one demonstrable path using a single Markdown document:

1. Upload and retain an immutable revision.
2. Parse anchored passages and index them.
3. Extract three candidate claims with valid evidence references.
4. Accept one, reject one, and leave one pending.
5. Retrieve the accepted claim with its source and quality dimensions.
6. Display claim → entity/project → source in a bounded graph.
7. Run MCP search, capture, and import using the same services.
8. Retry the import and demonstrate that records do not duplicate.

This slice validates the core architecture before expanding ingestion formats and maintenance features.
