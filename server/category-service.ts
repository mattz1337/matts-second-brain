import { createHash, randomUUID } from 'node:crypto';
import type { QueryDB, DB } from './db.js';
import { one, rows } from './db.js';
import { CATEGORY_ENGINE, suggestCategories, type ClassificationInput } from './categorization.js';
import { categoryDecisionSchema } from '../shared/contracts.js';
import type {
  Actor,
  ItemCategory,
  ItemCategories,
  CategorySummary,
  CategorizationStatus,
  ImportJob,
} from '../shared/contracts.js';
import { requireCondition } from './errors.js';
import {
  SemanticCategories,
  CATEGORY_PROTOTYPES,
  type CategoryEmbedder,
  type CategoryPrototype,
  type NotebookContext,
} from './semantic-categories.js';
import type { CategorySuggestion } from './categorization.js';

export class CategoryService {
  private processing = false;
  private semantic?: SemanticCategories;
  constructor(
    private db: DB,
    private embedder?: CategoryEmbedder,
    minSimilarity = 0.78,
    autoSimilarity = 0.82,
  ) {
    if (embedder) this.semantic = new SemanticCategories(embedder, minSimilarity, autoSimilarity);
  }
  get engineVersion() {
    return `${CATEGORY_ENGINE}:${this.embedder?.modelId || 'lexical'}:${this.semantic?.minSimilarity || 0}:${this.semantic?.autoSimilarity || 0}`;
  }
  private input(q: QueryDB, nodeId: string) {
    return one<ClassificationInput>(
      q,
      `
      SELECT title,statement AS text,tags,project,NULL::jsonb AS metadata FROM knowledge WHERE id=$1
      UNION ALL SELECT s.title,COALESCE((SELECT text FROM revisions WHERE source_id=s.id ORDER BY observed_at DESC,id DESC LIMIT 1),''),s.tags,s.project,s.metadata FROM sources s WHERE s.id=$1`,
      [nodeId],
    );
  }
  private fingerprint(input: ClassificationInput) {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }
  private async ensureCategory(
    q: QueryDB,
    suggestion: Pick<CategorySuggestion, 'path' | 'namespace'>,
  ) {
    let parent: string | null = null;
    for (let i = 0; i < suggestion.path.length; i++) {
      const canonical = `${suggestion.namespace}:${JSON.stringify(suggestion.path.slice(0, i + 1).map((part) => part.trim().toLowerCase()))}`;
      let category = await one<{ id: string }>(
        q,
        "SELECT id FROM entities WHERE canonical=$1 AND type='category'",
        [canonical],
      );
      if (!category) {
        category = { id: randomUUID() };
        await q.query("INSERT INTO nodes(id,type,label) VALUES($1,'category',$2)", [
          category.id,
          suggestion.path[i],
        ]);
        await q.query("INSERT INTO entities(id,canonical,type) VALUES($1,$2,'category')", [
          category.id,
          canonical,
        ]);
      }
      if (parent)
        await q.query(
          "INSERT INTO relations(id,source_node,target_node,type) VALUES($1,$2,$3,'category_parent') ON CONFLICT(source_node,target_node,type) DO NOTHING",
          [randomUUID(), category.id, parent],
        );
      parent = category.id;
    }
    return parent!;
  }
  private async resolve(
    q: QueryDB,
    suggestions: (CategorySuggestion & Partial<ItemCategory>)[],
  ): Promise<ItemCategory[]> {
    const result: ItemCategory[] = [];
    for (const suggestion of suggestions.filter((item) => item.namespace !== 'collections'))
      result.push({ ...suggestion, category_id: await this.ensureCategory(q, suggestion) });
    return result;
  }
  private async apply(q: QueryDB, nodeId: string, automatic: ItemCategory[]) {
    const decisions = await rows<{ category_id: string; decision: 'accept' | 'dismiss' }>(
      q,
      "SELECT d.category_id,d.decision FROM category_decisions d JOIN nodes n ON n.id=d.category_id AND n.type='category' WHERE d.node_id=$1",
      [nodeId],
    );
    const choices = new Map(decisions.map((decision) => [decision.category_id, decision.decision]));
    const items = new Map(
      automatic
        .filter((item) => choices.get(item.category_id) !== 'dismiss')
        .map((item) => [item.category_id, item]),
    );
    for (const decision of decisions)
      if (decision.decision === 'accept')
        items.set(decision.category_id, {
          category_id: decision.category_id,
          path: [],
          method: 'manual',
          rationale:
            'Category explicitly confirmed or added by the owner. Preserved during edits and rescans.',
          status: 'confirmed',
        });
    if (
      [...items.values()].some(
        (item) =>
          item.method !== 'fallback' &&
          (item.method !== 'metadata' ||
            (item as ItemCategory & { namespace?: string }).namespace === 'custom'),
      )
    ) {
      for (const [id, item] of items) if (item.method === 'fallback') items.delete(id);
    } else {
      const fallback = (
        await this.resolve(q, [
          {
            path: ['Uncategorized'],
            namespace: 'topics',
            method: 'fallback',
            rationale:
              'No category has been confirmed or met the automatic semantic threshold. Review the suggestions or add a category.',
          },
        ])
      )[0];
      if (choices.get(fallback.category_id) !== 'dismiss')
        items.set(fallback.category_id, fallback);
    }
    for (const item of items.values())
      await q.query(
        `INSERT INTO relations(id,source_node,target_node,type,properties) VALUES($1,$2,$3,'categorized_as',$4)
      ON CONFLICT(source_node,target_node,type) DO UPDATE SET properties=excluded.properties`,
        [
          randomUUID(),
          nodeId,
          item.category_id,
          JSON.stringify({
            ...item,
            engine_version: this.engineVersion,
            status:
              item.method === 'semantic'
                ? 'suggested'
                : item.method === 'manual'
                  ? 'confirmed'
                  : 'automatic',
          }),
        ],
      );
    await q.query(
      "DELETE FROM relations WHERE source_node=$1 AND type='categorized_as' AND NOT(target_node=ANY($2::uuid[]))",
      [nodeId, [...items.keys()]],
    );
  }
  async classify(q: QueryDB, nodeId: string, force = false) {
    const input = await this.input(q, nodeId);
    if (!input) return;
    const fingerprint = this.fingerprint(input);
    const prior = await one<{ input_hash: string; engine_version: string }>(
      q,
      'SELECT * FROM categorizations WHERE node_id=$1',
      [nodeId],
    );
    if (!force && prior?.input_hash === fingerprint && prior.engine_version === this.engineVersion)
      return;
    const suggestions = await this.resolve(q, suggestCategories(input));
    await this.apply(q, nodeId, suggestions);
    await q.query(
      `INSERT INTO categorizations(node_id,engine_version,input_hash,semantic_state,suggestions) VALUES($1,$2,$3,$4,'[]')
      ON CONFLICT(node_id) DO UPDATE SET engine_version=excluded.engine_version,input_hash=excluded.input_hash,semantic_state=excluded.semantic_state,suggestions='[]',error=NULL,scanned_at=now()`,
      [nodeId, this.engineVersion, fingerprint, this.semantic ? 'pending' : 'disabled'],
    );
  }
  async queue() {
    return this.db.transaction(async (q) => {
      const existing = await one<{ id: string; status: string }>(
        q,
        "SELECT id,status FROM jobs WHERE payload->>'kind'='categorization' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      );
      if (existing) return existing;
      const id = randomUUID();
      await q.query('INSERT INTO jobs(id,title,payload) VALUES($1,$2,$3)', [
        id,
        'Rescan categories',
        JSON.stringify({ kind: 'categorization', engine_version: this.engineVersion }),
      ]);
      return { id, status: 'queued' };
    });
  }
  async ensureBackfill() {
    await this.db.transaction((q) => this.retireImportedCollections(q));
    const status = await this.status();
    if (status.pending && !status.job) await this.queue();
  }
  /** Keep legacy owner decisions in backups, but retire generated import folders. */
  async retireImportedCollections(q: QueryDB) {
    await q.query(`DELETE FROM relations WHERE type IN ('categorized_as','category_parent')
      AND (source_node IN (SELECT id FROM entities WHERE canonical LIKE 'collections:%')
        OR target_node IN (SELECT id FROM entities WHERE canonical LIKE 'collections:%'))`);
    await q.query(
      "UPDATE nodes SET type='import_collection' WHERE type='category' AND id IN (SELECT id FROM entities WHERE canonical LIKE 'collections:%')",
    );
    await q.query(
      "UPDATE entities SET type='import_collection' WHERE type='category' AND canonical LIKE 'collections:%'",
    );
  }
  private async notebookProfiles() {
    const sources = await rows<{ id: string; notebook: string | null }>(
      this.db,
      "SELECT id,metadata->>'notebook_id' AS notebook FROM sources WHERE status='active'",
    );
    const votes = await rows<{ id: string; path: string[] }>(
      this.db,
      `
      SELECT r.source_node AS id,r.properties->'path' AS path FROM relations r
      JOIN entities e ON e.id=r.target_node AND e.type='category' AND e.canonical LIKE 'topics:%'
      JOIN sources s ON s.id=r.source_node AND s.status='active'
      WHERE r.type='categorized_as' AND r.properties->>'method'='semantic'
        AND r.properties->>'confidence'='high' AND r.properties->>'level'='specific'
        AND r.properties->>'basis' <> 'notebook_context'
      UNION ALL
      SELECT d.node_id,substring(e.canonical FROM 8)::jsonb FROM category_decisions d
      JOIN entities e ON e.id=d.category_id AND e.type='category' AND e.canonical LIKE 'topics:%'
      JOIN sources s ON s.id=d.node_id AND s.status='active'
      WHERE d.decision='accept'`,
    );
    const groups = new Map<string, Map<string, string[][]>>();
    for (const source of sources) {
      if (!source.notebook) continue;
      if (!groups.has(source.notebook)) groups.set(source.notebook, new Map());
      groups.get(source.notebook)!.set(source.id, []);
    }
    const notebookOf = new Map(sources.map((source) => [source.id, source.notebook]));
    for (const vote of votes) {
      const notebook = notebookOf.get(vote.id);
      if (notebook && Array.isArray(vote.path) && vote.path.length > 1)
        groups.get(notebook)?.get(vote.id)?.push(vote.path);
    }
    return groups;
  }
  private notebookContext(
    profiles: Awaited<ReturnType<CategoryService['notebookProfiles']>>,
    input: ClassificationInput,
    nodeId: string,
  ): NotebookContext | undefined {
    const group = input.metadata?.notebook_id && profiles.get(input.metadata.notebook_id);
    if (!group) return;
    const counts = new Map<string, number>();
    let classified = 0,
      peers = 0;
    for (const [id, paths] of group) {
      if (id === nodeId) continue; // A note cannot corroborate itself.
      peers++;
      const unique = [
        ...new Set(paths.map((path) => JSON.stringify(path.map((part) => part.toLowerCase())))),
      ];
      if (unique.length !== 1) continue; // Multi-subject notes are not confident votes.
      classified++;
      counts.set(unique[0], (counts.get(unique[0]) || 0) + 1);
    }
    const winner = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (
      !winner ||
      winner[1] < 5 ||
      winner[1] / Math.max(1, classified) < 0.8 ||
      winner[1] / Math.max(1, peers) < 0.5
    )
      return;
    const path = CATEGORY_PROTOTYPES.find(
      (item) => JSON.stringify(item.path.map((part) => part.toLowerCase())) === winner[0],
    )?.path;
    if (path) return { path, support: winner[1], peers };
  }
  async status(): Promise<CategorizationStatus> {
    const count = await one<{ total: number; scanned: number }>(
      this.db,
      `SELECT count(*)::int AS total,count(c.node_id)::int AS scanned FROM nodes n LEFT JOIN categorizations c ON c.node_id=n.id AND c.engine_version=$1 WHERE n.type IN ('claim','note','source')`,
      [this.engineVersion],
    );
    const job = await one<ImportJob>(
      this.db,
      "SELECT id,title,status,stage,progress,error,warnings,result,created_at,updated_at,attempts FROM jobs WHERE payload->>'kind'='categorization' AND payload->>'engine_version'=$1 ORDER BY created_at DESC LIMIT 1",
      [this.engineVersion],
    );
    return {
      engine_version: this.engineVersion,
      total: count!.total,
      scanned: count!.scanned,
      pending: count!.total - count!.scanned,
      job: job || null,
      ...(await one<{
        semantic_pending: number;
        semantic_errors: number;
        suggested: number;
        needs_review: number;
        broad_assigned: number;
        corroborated: number;
      }>(
        this.db,
        `SELECT count(*) FILTER(WHERE semantic_state='pending')::int AS semantic_pending,
          count(*) FILTER(WHERE semantic_state='error')::int AS semantic_errors,
          count(*) FILTER(WHERE jsonb_array_length(suggestions)>0)::int AS suggested,
          count(*) FILTER(WHERE EXISTS(SELECT 1 FROM relations r WHERE r.source_node=c.node_id AND r.type='categorized_as' AND r.properties->>'method'='fallback'))::int AS needs_review,
          count(*) FILTER(WHERE EXISTS(SELECT 1 FROM relations r WHERE r.source_node=c.node_id AND r.type='categorized_as' AND r.properties->>'level'='broad'))::int AS broad_assigned,
          count(*) FILTER(WHERE EXISTS(SELECT 1 FROM relations r WHERE r.source_node=c.node_id AND r.type='categorized_as' AND r.properties->>'basis' IN ('corroborated','title_corroborated')))::int AS corroborated
          FROM categorizations c WHERE engine_version=$1`,
        [this.engineVersion],
      ))!,
      model_state: this.embedder?.state || 'disabled',
      model_error: (this.embedder as CategoryEmbedder & { error?: string | null })?.error || null,
    };
  }
  private async extraPrototypes(): Promise<CategoryPrototype[]> {
    const custom = await rows<{ canonical: string }>(
      this.db,
      "SELECT e.canonical FROM entities e WHERE e.type='category' AND e.canonical LIKE 'custom:%' AND NOT EXISTS(SELECT 1 FROM relations r WHERE r.type='category_parent' AND r.target_node=e.id) ORDER BY e.canonical LIMIT 100",
    );
    return custom.map((item) => {
      const path = JSON.parse(item.canonical.slice('custom:'.length)) as string[];
      return {
        path,
        namespace: 'custom',
        description: `Notes about ${path.join(' / ')}. User-defined subject category.`,
      };
    });
  }
  private async categorizeSemantic(
    nodeId: string,
    profiles: Awaited<ReturnType<CategoryService['notebookProfiles']>>,
  ) {
    if (!this.semantic) return;
    const input = await this.input(this.db, nodeId);
    if (!input) return;
    const fingerprint = this.fingerprint(input);
    try {
      const result = await this.semantic.analyze(
        input,
        await this.extraPrototypes(),
        this.notebookContext(profiles, input, nodeId),
      );
      await this.db.transaction(async (q) => {
        const current = await this.input(q, nodeId);
        const state = await one<{ input_hash: string; engine_version: string }>(
          q,
          'SELECT input_hash,engine_version FROM categorizations WHERE node_id=$1',
          [nodeId],
        );
        // Inference happens outside the transaction. Reject stale results after edits/deletion.
        if (
          !current ||
          this.fingerprint(current) !== fingerprint ||
          state?.input_hash !== fingerprint ||
          state.engine_version !== this.engineVersion
        )
          return;
        const suggestions = await this.resolve(q, result.suggestions);
        const context = await this.resolve(
          q,
          suggestCategories(current).filter((item) => item.method === 'metadata'),
        );
        await this.apply(q, nodeId, [
          ...context,
          ...suggestions.filter((item) => item.auto_applied),
        ]);
        await q.query(
          "UPDATE categorizations SET semantic_state='completed',suggestions=$2,error=NULL,scanned_at=now() WHERE node_id=$1 AND input_hash=$3 AND engine_version=$4",
          [
            nodeId,
            JSON.stringify(
              suggestions.map((item) => ({
                ...item,
                chunks: result.chunks,
                truncated: result.truncated,
              })),
            ),
            fingerprint,
            this.engineVersion,
          ],
        );
      });
    } catch (error) {
      await this.db.query(
        "UPDATE categorizations SET semantic_state='error',error=$2 WHERE node_id=$1 AND input_hash=$3",
        [
          nodeId,
          error instanceof Error ? error.message : 'Semantic categorization failed.',
          fingerprint,
        ],
      );
      throw error;
    }
  }
  async processPending(limit = 2) {
    if (this.processing || !this.semantic || this.embedder?.state !== 'ready') return;
    this.processing = true;
    try {
      const pending = await rows<{ node_id: string }>(
        this.db,
        "SELECT node_id FROM categorizations WHERE semantic_state='pending' AND engine_version=$1 ORDER BY scanned_at,node_id LIMIT $2",
        [this.engineVersion, limit],
      );
      const profiles = await this.notebookProfiles();
      for (const item of pending) {
        try {
          await this.categorizeSemantic(item.node_id, profiles);
        } catch {
          /* Persisted per item; visible in category status and retryable by rescan. */
        }
      }
    } finally {
      this.processing = false;
    }
  }
  async detail(nodeId: string): Promise<ItemCategories> {
    const input = await this.input(this.db, nodeId);
    requireCondition(input, 404, 'not_found', 'Knowledge or source not found.');
    const state = await one<{
      decision_version: number;
      semantic_state: string;
      error: string | null;
      suggestions: ItemCategory[];
    }>(this.db, 'SELECT * FROM categorizations WHERE node_id=$1', [nodeId]);
    const labels = await rows<{ id: string; label: string; parent: string | null }>(
      this.db,
      "SELECT n.id,n.label,r.target_node AS parent FROM nodes n LEFT JOIN relations r ON r.source_node=n.id AND r.type='category_parent' WHERE n.type='category'",
    );
    const byId = new Map(labels.map((node) => [node.id, node]));
    const pathOf = (id: string) => {
      const path: string[] = [];
      const seen = new Set<string>();
      let current: string | null = id;
      while (current && !seen.has(current)) {
        seen.add(current);
        const node = byId.get(current);
        if (!node) break;
        path.unshift(node.label);
        current = node.parent;
      }
      return path;
    };
    const assigned = await rows<{ category_id: string; properties: ItemCategory }>(
      this.db,
      "SELECT r.target_node AS category_id,r.properties FROM relations r JOIN nodes n ON n.id=r.target_node AND n.type='category' WHERE r.source_node=$1 AND r.type='categorized_as'",
      [nodeId],
    );
    const decisions = await rows<{ category_id: string; decision: 'accept' | 'dismiss' }>(
      this.db,
      "SELECT d.category_id,d.decision FROM category_decisions d JOIN nodes n ON n.id=d.category_id AND n.type='category' WHERE d.node_id=$1",
      [nodeId],
    );
    return {
      node_id: nodeId,
      title: input.title,
      decision_version: state?.decision_version || 0,
      semantic_state: state?.semantic_state || 'pending',
      error: state?.error || null,
      assigned: assigned.map((edge) => ({
        ...edge.properties,
        category_id: edge.category_id,
        path: pathOf(edge.category_id),
      })),
      suggestions: (state?.suggestions || [])
        .filter((item) => byId.has(item.category_id))
        .map((item) => ({
          ...item,
          path: pathOf(item.category_id),
          decision: decisions.find((decision) => decision.category_id === item.category_id)
            ?.decision,
        })),
      decisions: decisions.map((decision) => ({
        ...decision,
        path: pathOf(decision.category_id),
        method: 'manual',
        rationale:
          decision.decision === 'accept'
            ? 'Confirmed by the owner; preserved during rescans.'
            : 'Dismissed by the owner; excluded during rescans.',
      })),
    };
  }
  async decide(actor: Actor, nodeId: string, raw: unknown) {
    requireCondition(
      actor.scopes.includes('brain:review'),
      403,
      'insufficient_scope',
      'Category corrections require owner review authority.',
    );
    const input = categoryDecisionSchema.parse(raw);
    await this.db.transaction(async (q) => {
      const item = await this.input(q, nodeId);
      requireCondition(item, 404, 'not_found', 'Knowledge or source not found.');
      const state = await one<{
        decision_version: number;
        suggestions: ItemCategory[];
        semantic_state: string;
      }>(q, 'SELECT * FROM categorizations WHERE node_id=$1', [nodeId]);
      requireCondition(
        state && state.decision_version === input.expected_version,
        409,
        'version_conflict',
        'Categories changed. Refresh before saving.',
      );
      let categoryId = input.category_id;
      if (input.path) {
        const builtIn = CATEGORY_PROTOTYPES.find(
          (prototype) =>
            prototype.path.slice(0, input.path!.length).join('/').toLowerCase() ===
            input.path!.join('/').toLowerCase(),
        );
        categoryId = await this.ensureCategory(q, {
          path: builtIn?.path.slice(0, input.path.length) || input.path,
          namespace: builtIn ? 'topics' : 'custom',
        });
      }
      const category = await one(q, "SELECT id FROM nodes WHERE id=$1 AND type='category'", [
        categoryId,
      ]);
      requireCondition(category, 404, 'not_found', 'Category not found.');
      if (input.action === 'reset')
        await q.query('DELETE FROM category_decisions WHERE node_id=$1 AND category_id=$2', [
          nodeId,
          categoryId,
        ]);
      else
        await q.query(
          `INSERT INTO category_decisions(node_id,category_id,decision,actor) VALUES($1,$2,$3,$4)
        ON CONFLICT(node_id,category_id) DO UPDATE SET decision=excluded.decision,actor=excluded.actor,updated_at=now()`,
          [nodeId, categoryId, input.action, actor.id],
        );
      const context = await this.resolve(
        q,
        suggestCategories(item).filter((suggestion) => suggestion.method === 'metadata'),
      );
      const automatic =
        state.semantic_state === 'completed'
          ? state.suggestions.filter((suggestion) => suggestion.auto_applied)
          : await this.resolve(q, suggestCategories(item));
      await this.apply(q, nodeId, [...context, ...automatic]);
      await q.query(
        'UPDATE categorizations SET decision_version=decision_version+1 WHERE node_id=$1',
        [nodeId],
      );
    });
    return this.detail(nodeId);
  }
  async run(jobId: string) {
    // Background incremental inference waits while the full rescan owns the classifier.
    while (this.processing) await new Promise((resolve) => setTimeout(resolve, 25));
    this.processing = true;
    try {
      await this.db.transaction((q) => this.retireImportedCollections(q));
      // Freeze independent peer votes before the rescan replaces assignments.
      const profiles = await this.notebookProfiles();
      if (this.embedder) {
        await this.db.query(
          "UPDATE jobs SET stage='Loading local category model',progress=0 WHERE id=$1",
          [jobId],
        );
        await this.embedder.initialize();
        if (this.embedder.state === 'error')
          throw new Error(
            'Local category model could not load. Check category status and retry the scan.',
          );
      }
      const targets = await rows<{ id: string }>(
        this.db,
        "SELECT id FROM nodes WHERE type IN ('claim','note','source') ORDER BY id",
      );
      const result = { scanned: 0, total: targets.length, categorized: 0, uncategorized: 0 };
      for (const target of targets) {
        await this.db.transaction((q) => this.classify(q, target.id, true));
        if (this.embedder?.state === 'ready') await this.categorizeSemantic(target.id, profiles);
        else if (this.embedder?.state === 'disabled')
          await this.db.query(
            "UPDATE categorizations SET semantic_state='disabled' WHERE node_id=$1",
            [target.id],
          );
        await this.db.transaction(async (q) => {
          // Read inside the transaction so an edit/import cannot leave obsolete categories.
          const assignment = await one<{ fallback: boolean }>(
            q,
            "SELECT bool_or(properties->>'method'='fallback') AS fallback FROM relations WHERE source_node=$1 AND type='categorized_as'",
            [target.id],
          );
          if (!assignment || assignment.fallback === null) return; // deleted during scan
          result.scanned++;
          if (assignment.fallback) result.uncategorized++;
          else result.categorized++;
          await q.query(
            "UPDATE jobs SET stage='Categorizing',progress=$2,result=$3,updated_at=now() WHERE id=$1",
            [
              jobId,
              Math.floor((result.scanned / Math.max(1, result.total)) * 100),
              JSON.stringify(result),
            ],
          );
        });
      }
      await this.db.query(
        "UPDATE jobs SET status='completed',stage='completed',progress=100,result=$2,updated_at=now() WHERE id=$1",
        [jobId, JSON.stringify(result)],
      );
    } finally {
      this.processing = false;
    }
  }
  async list(includeCandidates = false): Promise<CategorySummary[]> {
    const categories = await rows<CategorySummary>(
      this.db,
      `SELECT n.id,n.label,r.target_node AS parent_id,0 AS direct_count,0 AS count FROM nodes n LEFT JOIN relations r ON r.source_node=n.id AND r.type='category_parent' WHERE n.type='category' ORDER BY n.label,n.id`,
    );
    const memberships = await rows<{ source: string; target: string }>(
      this.db,
      `SELECT r.source_node AS source,r.target_node AS target FROM relations r LEFT JOIN knowledge k ON k.id=r.source_node LEFT JOIN sources s ON s.id=r.source_node WHERE r.type='categorized_as' AND (k.lifecycle='active' OR ($1 AND k.lifecycle='candidate') OR s.status='active')`,
      [includeCandidates],
    );
    const byId = new Map(categories.map((category) => [category.id, category]));
    const counts = new Map<string, Set<string>>();
    for (const membership of memberships) {
      const leaf = byId.get(membership.target);
      if (leaf) leaf.direct_count++;
      let current: string | null = membership.target;
      const visited = new Set<string>();
      while (current && !visited.has(current)) {
        visited.add(current);
        if (!counts.has(current)) counts.set(current, new Set());
        counts.get(current)!.add(membership.source);
        current = byId.get(current)?.parent_id || null;
      }
    }
    return categories
      .map((category) => ({ ...category, count: counts.get(category.id)?.size || 0 }))
      .filter((category) => category.count > 0);
  }
}
