# Second brain spike: implementation and evaluation

Implemented 8 October 2026. This is a working local spike, not a claim that all production gates in the [PRD](prd.md) have been met.

25 October extension: [the integrated assistant](assistant.md) adds OpenRouter conversations, scoped retrieval and reviewed actions, a read-only Garmin companion, and Graphify export/import/review. The earlier baseline counts below are historical: the extension has passed 109 distinct backend checks (the 107-case suite plus two added context/configuration checks), 22 browser workflows, four Python adapter checks, and the Linux container smoke check including saved assistant conversations across restart. A real-provider check with an invented note also passed; no representative answer-quality or NAS resource benchmark is claimed.

## Architecture decision

The workspace has Node.js 22.17, no installed Python interpreter, and no running Docker daemon. The implementation therefore uses TypeScript throughout and PGlite, a filesystem-persistent embedded PostgreSQL runtime. pgvector, GIN full-text indexes, explicit graph relations, source revisions, evidence, review history, and canonical durable jobs are actual database records.

PGlite is an intentional single-process deployment choice. The MCP stdio bridge calls the API rather than opening the database directly. The SQL domain schema can inform a later PostgreSQL-service migration, but that migration and multi-worker operation have not been implemented or validated. [PGlite documentation](https://pglite.dev/docs/), [supported pgvector extension](https://pglite.dev/extensions/).

The stack is React 19, Vite 7, Three.js, Express 5, Zod, PGlite/pgvector, Transformers.js, PDF.js, Cheerio, and the official TypeScript MCP SDK. The lockfile records installed package versions.

## Complete workflows

| Workflow | Implemented behavior                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture  | Owner notes are accepted self-reported knowledge; assistant additions are candidates; kind/context/tags/project/time fields are retained            |
| Import   | Async text/file/public-URL inputs; immutable originals and parsed revisions; exact anchors; candidate extraction; errors/retry and restart recovery |
| Review   | Inspect evidence, accept/reject, record substantive verification with rationale, and batch accept/reject with per-item concurrency results          |
| Maintain | Review dates/grace, validity intervals, structured conflicts, supersession, source-change/retraction invalidation, version history                  |
| Search   | PostgreSQL lexical search + local 384-dimensional E5 embeddings + reciprocal rank fusion + bounded typed graph expansion                            |
| Ask      | A structured evidence digest with claim citations, quality dimensions, retained passages, and explicit knowledge gaps                               |
| Explore  | Interactive graph and table, one/two-hop focus, topic/status filters, node inspection, named-entity merge/undo                                      |
| Reuse    | Fourteen MCP tools including category suggestions/corrections/rescan; authenticated HTTP and stdio transports; shared REST/MCP services             |
| Control  | Reversible archival, live-data deletion, source derivative purge, export, empty-database restore, and index rebuilding                              |

## Knowledge globe update (9 October 2026)

The flat graph was replaced with a WebGL globe: atmospheric glow, a latitude/longitude scaffold, typed luminous nodes, lifted great-circle connections, traveling signals, slow orbital motion, and smooth camera flights. Positions express a logical space rather than geographic location or similarity distance. The layout is deterministic for the same node set regardless of API ordering; changing the visible node set redistributes positions.

Drag or swipe to orbit, scroll/pinch or use buttons to zoom, and select a light or use the keyboard-accessible node finder. Selection pauses the orbit, highlights real connected edges, and offers typed connection navigation, evidence inspection, and a bounded graph focus. The dashboard also renders a compact globe. Decorative stars and the orbit guide are separate from actual knowledge nodes.

Motion can be paused and respects the operating system's reduced-motion preference, including camera transitions. GPU rendering pauses offscreen or in a hidden tab; graphics resources and input listeners are released when switching views. A failed/lost WebGL context falls back to the knowledge table. Topic/candidate filtering, graph limits, and canonical data remain server-controlled.

## Category hierarchy update (9 October 2026)

Category nodes and typed `categorized_as` / `category_parent` relations add a real taxonomy to the graph. Assignments retain an engine version, method, and readable rationale. Local English/German keyword rules propose up to three subject categories; ambiguous text receives an Uncategorized node. Hierarchical tags supply explicit custom branches. Original stack and notebook labels remain import metadata and filters, and can inform subject inference. They do not create a category tree. This is a deterministic suggestion engine with a fixed initial taxonomy, not unrestricted semantic classification or evidence verification.

Capture, edits, original-source imports, and extracted candidates categorize inside their database transactions. Schema migration 5 adds categorization fingerprints and relationship properties. Existing data gets a durable startup backfill; the graph's Rescan categories button or MCP `rescan_categories` queues a full rebuild. Concurrent queue requests reuse a running job, repeated rescans retain canonical category IDs and link IDs, and interrupted scans recover through the existing worker. Rescans change only organization metadata, leaving originals, evidence, verification, versions, and lifecycle intact. Export preserves categorization provenance; legacy backups rebuild it during restore.

The graph has a collapsible category tree with unique descendant item counts and branch filters. The globe clusters related items around broader category hubs. Bounded samples include category ancestors and sample across branches. Candidate/archived/source visibility still applies. REST exposes category list/status/rescan, and MCP adds category browsing plus rescan tools. Browser and database checks cover branching, bilingual matching, candidate visibility, NSX metadata, rescan recovery, verification preservation, export compatibility, filtering, and mobile layout.

## Semantic categories and corrections update (9 October 2026)

The initial keyword-only classifier was insufficient for the imported collection. Categorization now uses the local multilingual E5 model to compare title, readable content, tags, and project/notebook/stack context against 24 bilingual subject descriptions and up to 100 user-defined category leaves. The inference path uses `query:` prefixes for both note windows and category descriptions, as recommended for classification features in the [E5 model card](https://huggingface.co/intfloat/multilingual-e5-small). Category prototypes are cached per model instance. At most eight distributed windows sample long notes; this bounds inference cost but does not exhaustively cover arbitrary-length documents.

Up to three specific suggestions retain model ID, cosine similarity, runner-up separation, confidence grade, and automatic-assignment status. The suggestion floor defaults to 0.78; ordinary automatic assignments require 0.82 plus a separation guard (or a very strong score), with a stricter secondary-category threshold. Explicit content/title/tag/notebook keywords can corroborate a retained semantic suggestion. Close siblings can yield an additional broader-parent assignment when that branch is clearly separated from every competitor. Assignment provenance distinguishes specific, corroborated, and broad suggestions. Sparse content without topic signals and ambiguity across unrelated branches still abstain. Confidence is a heuristic rather than a calibrated probability. A real-model bilingual fixture check covers paraphrases about printing, cooking and travel, plus abstention on ambiguous text. It is not a representative corpus accuracy benchmark.

New writes persist metadata/provisional categories and enqueue inference; inference runs outside database transactions, checks fingerprints before committing, and shares a serialized model queue with search/indexing. Full rescans own the category worker while running. Pending, disabled and failed model states remain visible, and item errors are persisted. A lexical-only configuration retains metadata/keyword fallback and does not claim semantic analysis.

The 10 October categorization audit found that close leaf-category scores were blocking assignments even when contextual keywords or a broader branch were useful. Version 4 combines keyword corroboration, a separate title/tag comparison for ambiguous notes, and a broader-parent fallback. A conflicting title prevents the broader assignment. On the current 753-item collection, the rescan reduced visible Uncategorized memberships from 403 to 336, with 21 broader assignments and zero model errors. Exact before/after backup records preserved 744 sources and all nine knowledge items' versions, lifecycle states and verification timestamps. This measures coverage, not classification accuracy; generated memberships remain reviewable suggestions. The private audit data stays outside the repository and container image.

Version 5 corrects the distinction between imported folders and subject categories. Generated `collections:` category nodes are retired as hidden `import_collection` records, with their category edges removed. Their historical owner decisions remain in backups; custom subject categories and their corrections remain active. Migration runs at startup, on rescans, and during restore. Notebook labels and original IDs remain in source metadata and filters. Descriptive titles count as meaningful input even when the body is a short image marker, fixing the Lebkuchen example as Life / Food & cooking. Other notes can corroborate a retained content suggestion above the automatic score threshold: at least five independently confirmed/high-confidence peers must agree, cover at least half the peers, and represent at least 80% of single-subject votes. A note cannot vote for itself; notebook-context assignments never seed further votes. Full scans freeze these votes before replacing assignments. Mixed notebooks abstain. The live rescan retired 13 import-folder nodes and reduced Uncategorized from 336 to 321, with zero model errors. No peer-context assignments were warranted in this collection. Exact backups preserved sources, revisions, passages, attachments, evidence, knowledge, version history, and owner decisions.

Schema migration 6 stores independent owner accept/dismiss decisions and category-decision versions. Organize categories is accessible from source details, knowledge details and globe selections. The owner can confirm, dismiss, add custom parent/child paths, or undo decisions. Corrections survive edits, model rescans and export/restore; ordinary assistant credentials may read suggestions but cannot override owner decisions. The API and two additional MCP tools expose inspection and versioned correction. Category decisions never change knowledge verification or version history.

## UX flow improvements (10 October 2026)

The [UX audit](ux-audit.md) records observed friction and the implemented changes to capture, searching, imports, category review, batch review, graph recovery, and reading. Seven browser regressions cover slow/failed saves, retained search context, stale evidence digests, large source lists, import next steps, partial review failures, filter/network recovery, and upload reuse. Three more cover formatted note/source graph previews, fullscreen and its fallback, continuous source reading, and secondary citation/provenance views. Together with the original nine workflows, this gives 19 browser checks. Sources render at most 25 rows per page instead of all 744 records. Mutation checks use an isolated workspace; the desktop collection stays unchanged.

## Note Station migration update (9 October 2026)

NSX imports use a disk-backed upload (up to 512 MB) and a bounded random-access ZIP reader. The user previews archive counts/warnings and selects notebooks before queuing the job. Native note JSON is retained exactly; safe readable text becomes individually indexed source passages. Notebook/stack names, original tags, creation/modification dates, and available attachments survive migration. No import operation automatically verifies a claim. Optional extraction can run during initial import or later on an unchanged retained revision without duplicating previously derived claims.

Each note is a separate transaction, identified by its Note Station ID and native record hash. Retrying a partially committed job reuses existing revisions. Attachment files use SHA-256 names, atomic writes, authenticated downloads, reference-aware deletion, and a portable ZIP backup/restore flow. The completed bulk archive is removed; forgetting an individual source removes its native record and unshared attachments. ZIP entries are never expanded to user-controlled filesystem paths. Older JSON backups remain readable; new JSON exports are v2, and ZIP backups avoid base64 expansion for large media collections.

The supplied 244,673,580-byte archive was tested through the real browser upload/preview flow and migrated into an isolated validation database in approximately 20 seconds. The full portable backup was then restored into a second isolated database. Observed counts in both databases: 743 sources, 165 retained attachment references, and 7,032 indexed passages. The export lists 13 notebooks and 166 attachment references; one file is absent from the original archive, and 11 notes have no exported HTML. All 743 records were retained, with warnings for these limitations and zero skipped records. No notes from this validation were added to the live second brain.

Limits: current JSON-format NSX only, no decryption or attachment OCR/content parsing, and a readable-text rather than exact rich-layout viewer. Original native HTML remains available through the downloadable note JSON. This archive-sized check does not establish large-corpus retrieval quality or general throughput guarantees.

## Quality semantics

- Acceptance is a lifecycle choice; it does not set `verified_at`.
- Factual verification requires active supporting evidence. First-person observations/preferences are self-reported and can be checked by the owner.
- Evidence status is computed from support/challenge and distinct active source lineages. A copied page does not create another independent lineage when that lineage is supplied.
- Freshness is independent of evidence status: unknown, current, review due, stale, expired, or not yet applicable. Review grace is initially 30 days.
- Reads and unchanged imports do not renew verification. Substantive edits, changed source revisions, evidence attachment, and retractions invalidate it.
- Structured conflict detection compares subject/predicate, differing object, equal project/context, and overlapping applicability. General semantic contradiction discovery is deferred.
- Supersession closes the older claim's applicability at the present time and starts the replacement's applicability when unspecified.
- Source-extracted claims retain an explicit derivation source ID. Forgetting a source removes those claims even after their wording/context changes; unrelated user-authored claims lose only that source's evidence and require reassessment.

## Extraction and retrieval baseline

Default extraction segments exact sentences from retained passages, proposes at most 40 claims, and labels them candidates. All passages remain searchable, even when extraction is capped. This makes the spike usable without a generative model and makes evidence fidelity easy to inspect.

Optional loopback Ollama extraction uses a constrained JSON schema, validates source quotes and passage indices, rejects malformed claims, and treats imported content as untrusted data. It does not grant tool authority. An installed Ollama model was not available for live provider validation in this session.

The local embedding model is `Xenova/multilingual-e5-small`, quantized ONNX, 384 dimensions. Query/passage prefixes are used. The index records model namespace and input hashes; updates invalidate embeddings and a background loop rebuilds them. Inputs are chunked conservatively, but tokenizer truncation may still occur on unusual text. [Transformers.js pipeline documentation](https://huggingface.co/docs/transformers.js/en/pipelines).

Observed semantic smoke fixture:

| Query                                                       | Similarity to printing observation | Similarity to garden observation | Result with cutoff 0.8 |
| ----------------------------------------------------------- | ---------------------------------- | -------------------------------- | ---------------------- |
| How can I stop fine hairs between parts of a printed model? | 0.8304                             | 0.7572                           | Printing observation   |
| Wie verhindere ich Fäden beim 3D-Druck?                     | 0.8201                             | 0.7328                           | Printing observation   |
| What is the distance from Earth to Neptune?                 | 0.7539                             | 0.7095                           | Knowledge gap          |

The initial 0.72 cutoff admitted irrelevant results. Raising it to 0.8 fixed these fixtures. This is a retrieval threshold, not confidence in truth. A broader labeled corpus is required before choosing a production threshold, measuring recall@10, or claiming the PRD's quality targets.

Ask mode uses selected accepted knowledge and exact source excerpts rather than generating unverified synthesis. It preserves citations and separates source assertions from owner observations. No provider bill or hosted transmission is incurred by default.

## Authorization and ingestion boundaries

The application is intentionally local: loopback binding, explicit Host/Origin restrictions, HttpOnly/SameSite browser sessions, and scoped random bearer credentials for MCP. The local browser may establish the single-owner session; this is not remote authentication or isolation from other processes/users on the same operating-system account.

The standard contribution token has `brain:read` and `brain:write`. The reader token has only `brain:read`. Neither has `brain:review` or `brain:admin`; the server enforces this independently of MCP descriptions. Local owner UI operations have those additional scopes. Credentials are persisted under the ignored data directory and are available to the owner in settings.

Public URL imports validate all resolved addresses, pin the chosen address for the request, repeat checks on redirects, reject private/loopback/link-local/metadata targets and credentials/non-web ports, and enforce request size/time limits. File inputs stay in managed database storage; MCP accepts uploaded IDs, never arbitrary host paths. PDF parsing disables evaluation, has a page cap, and warns about table/OCR limitations. A separate sandboxed parser process remains a production hardening task.

## Validation

Commands and reproducible fixtures are included in the repository:

Current validation: 84 tests (32 integration/MCP, 14 NSX migration/backup checks, 9 category hierarchy checks, 15 semantic/correction checks, 6 globe geometry checks, 4 password-access checks, 1 copied-database inspection check, and 3 safe source-presentation checks) and 19 browser workflows passed. Category checks include import-folder retirement on startup/rescan/restore, retained provenance, descriptive titles for sparse notes, homogeneous versus mixed notebook context, self-vote exclusion, broader-parent assignment, separate title/content agreement, conflicting-title abstention, and persistent owner decisions. Backup checks cover both Orbit exports and earlier Commonplace exports. The actual local model also passed the sparse Lebkuchen fixture alongside English/German printing, cooking and travel examples, and ambiguous-text abstention. The amd64 Linux container passed checks for login, scoped MCP, imports, backups, copied SQL inspection, clean shutdown, persistent data/tokens across restart, and offline CPU embedding inference. These results are fixture verification, not the PRD's proposed large-corpus quality/performance evaluation or a DS423+ hardware benchmark.

- `npm test`: lifecycle, idempotency, exact source offsets, PDF/HTML extraction, lineages/challenges, retraction, conflicts, supersession, temporal/recorded-time search, bounded graph, recoverable imports, filesystem restart, source/item deletion, export/restore, batch reviews, merge/undo, real pgvector distances, HTTP boundaries, and MCP scopes.
- Official MCP client tests initialize/discover fourteen tools, write/read knowledge, reject review escalation, verify reader write denial, and exercise both Streamable HTTP and stdio.
- `npm run test:semantic`: real English/German inference and an unrelated negative query.
- `npm run test:categories:semantic`: real bilingual semantic category rankings and abstention on ambiguous text. Database checks cover owner decisions across rescans/backups, inference races, and model-error recovery; browser checks cover source/knowledge correction controls and persistence after rescan.
- `npm run test:e2e`: build/typecheck and Chrome workflows for capture/edit/archive/restore/forget; Markdown upload/accept/verify/source inspection; live WebGL animation, light picking, camera controls, evidence inspection and graph focus; graph/list/settings; a 390px mobile viewport without horizontal overflow; reduced-motion stability and WebGL failure/recovery.
- Desktop, mobile, graph list, and evidence screenshots are generated under `.data/screenshots` and were visually inspected.

Browser testing caught and fixed Cytoscape cleanup interfering with the list view, missing explicit table-header scope, ambiguous form labels on prefilled textareas, and a source list that did not refresh when async imports completed.

## Remaining production decisions

1. Evaluate 20+ owner-relevant documents, then the proposed 100-document/60-question benchmark; choose chunking/model/threshold using measured recall and support.
2. Decide whether the TypeScript/PGlite deployment is sufficient for personal use or move the same concepts to a PostgreSQL service and external durable workers.
3. Choose a generative extraction/synthesis provider and assess privacy, fidelity, latency, and token budgets. Add summaries with explicit dependency tracking before enabling automated synthesis.
4. Extend the password-protected LAN/VPN [NAS deployment](synology.md) with OAuth, collection/user isolation, parser process isolation, and operating controls before offering a public multi-user service.
5. Add scheduled backup/restore drills, current deletion-history replay across independent older backups, and streaming large export/restore handling. Manual JSON exports are supported now; old external files cannot be erased by this application.
6. Extend source suitability assessments, recorded-time evidence history, semantic contradiction discovery, connector sync, OCR/table handling, and automatic revalidation according to real usage.

No large-corpus throughput, production availability, exhaustive prompt-injection resistance, or numerical truth calibration is asserted by the spike.
