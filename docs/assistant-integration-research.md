# Assistant, Garmin and Graphify integration — external research

Research date: 25 October 2026. This note checks official platform documentation only. It proposes design constraints; it does not describe features already implemented in Orbit or inspect the user's Garmin records. No private content or paid inference request was sent to a provider.

## OpenRouter as the model gateway

OpenRouter standardizes requests to models operated by different providers. For client tool calling, the model proposes a function and arguments; the application executes the function and returns its result. Consequently, adding an API key alone does not give a chat interface reliable search or write access: Orbit needs a server-side tool dispatcher and a bounded model/tool loop. Model selection must explicitly include tool support. [OpenRouter client tools](https://openrouter.ai/docs/guides/features/tool-calling).

Provider support can differ even for the same model. `provider.require_parameters=true` restricts routing to endpoints that support the supplied parameters; otherwise some unsupported parameters can be ignored. Proposed policy: validate model capabilities at configuration time, require parameter support for tool-enabled calls, and test configured fallbacks with the actual tool schemas. [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection).

Streaming is suitable for the web interface, but requires correct SSE parsing, including comment events, split input buffers, end markers, usage chunks, cancellation, and mid-stream errors. Streaming tool arguments arrive incrementally; assemble each complete call before validating or executing it. Return one result for each tool-call ID. [Streaming reference](https://openrouter.ai/docs/api/reference/streaming), [OpenRouter tool-calling tutorial](https://openrouter.ai/blog/tutorials/tool-calling/).

## Application design implications

These are recommendations inferred from the execution model above:

- Keep credentials, tool execution, scope checks, and context assembly on Orbit's server. The browser gets streamed UI events, citations and proposed changes.
- Reuse the same application operations used by REST/MCP. MCP is an adapter for external clients; the first-party assistant can dispatch directly to those operations rather than calling its own HTTP server.
- Begin with allowlisted retrieval, source/knowledge detail, category and graph tools. Expose Garmin through separate typed retrieval/aggregation tools. Do not give the model unrestricted SQL, shell execution, or arbitrary filesystem access.
- Read tools return bounded, attributable evidence. Numeric aggregation and time-window filtering belong in deterministic code; the model explains the returned results.
- For writes, produce a reviewable proposal and apply it through existing validated/versioned commands after an explicit user save/approval. Make execution idempotent and record the actor, affected IDs and result. A generated answer should not automatically become a verified fact.
- Persist conversations separately from saved knowledge. Support explicit promotion of a useful answer to a note, with links to its source evidence and the model/provider used.
- Bound turns, tool calls, output/context size, time and spend; support cancellation. Retrieved notes and tool results are untrusted data, never instructions granting extra permissions.

## Privacy and health-related context

Selected note excerpts or Garmin summaries included in an OpenRouter request leave the NAS and pass through OpenRouter and the chosen model endpoint. OpenRouter says prompt/completion storage is opt-in, while request metadata is retained. Keep content logging/use-of-inputs opt-ins disabled when privacy is desired, and avoid logging full retrieved context in Orbit's own diagnostics. [Data collection](https://openrouter.ai/docs/guides/privacy/data-collection).

Providers have their own retention and training policies. Opting out of training is separate from eliminating retention. Proposed sensitive-data defaults are `provider.data_collection="deny"`, `provider.zdr=true`, and a reviewed provider/model allowlist; fail clearly if no matching endpoint is available rather than silently relaxing these constraints. [Provider policies](https://openrouter.ai/docs/guides/privacy/provider-logging), [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection).

ZDR filters inference endpoints; it does not cover all third-party server tools/plugins. OpenRouter also permits certain in-memory prompt caching under ZDR. Therefore a ZDR toggle is neither a local-only mode nor a guarantee that every optional component has identical handling. Prefer local Garmin aggregation and minimal summaries, with a visible choice of whether a chat may include health context. A genuinely local-only mode needs a local model/provider path. [ZDR scope and caching](https://openrouter.ai/docs/guides/features/zdr).

## Graphify's useful role

Current upstream is Graphify-Labs/graphify; the Python package is `graphifyy`. It persists graph JSON alongside reports/visualizations, with graph schema and Graphify version metadata. Preserve source references and provenance through any integration; do not assume JSON from different versions is interchangeable. [Upstream README](https://github.com/Graphify-Labs/graphify).

Graphify can add extracted relationships, community structure and graph traversal context. Its code parsing is local and deterministic, while semantic extraction of documents/media may send inputs to the selected provider. `INFERRED` can reflect static resolution as well as model-derived interpretation; neither means independently verified truth. MCP exposes graph operations. Missing inputs and stale scans leave gaps. [Architecture](https://docs.graphify.com/concepts/architecture).

`graphify query` returns a compact graph neighborhood with an approximate token budget; it is evidence context rather than a verified answer. This makes a scoped Graphify retrieval adapter plausible alongside Orbit's existing search and temporal/structured Garmin retrieval. It does not establish a reason to replace Orbit's canonical store or put every Garmin sample into a graph. Evaluate extraction on representative notes/summaries first and keep inferred graph enrichment rebuildable. [Query reference](https://docs.graphify.com/reference/query).

## Suggested sequencing

1. Add the server-side assistant and cited read tools to the existing Orbit web app.
2. Add proposed knowledge writes with explicit save/review and an audit trail.
3. Connect Garmin as a typed observation/aggregation source, preserving original timestamps, units and provenance.
4. Evaluate optional Graphify enrichment using a small benchmark of cross-note questions. Compare answer correctness, citation accuracy, latency, privacy exposure and cost against existing retrieval before expanding deployment.

The sequencing is a design recommendation, not a platform requirement. The parent assessment separately inspects the two local projects to decide which concrete modules and interfaces can be reused.
