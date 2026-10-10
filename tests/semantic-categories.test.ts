import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type DB } from '../server/db.js';
import { BrainService, owner } from '../server/service.js';
import { CategoryService } from '../server/category-service.js';
import {
  SemanticCategories,
  categoryWindows,
  type CategoryEmbedder,
} from '../server/semantic-categories.js';
import { invokeTool } from '../server/mcp.js';

class FixtureModel implements CategoryEmbedder {
  state = 'ready';
  modelId = 'fixture-category-model';
  onWindow?: (text: string) => Promise<number[]>;
  async initialize() {}
  async embed(text: string) {
    if (text.startsWith('Life / Food & cooking.')) return [1, 0, 0];
    if (text.startsWith('Technology / Hardware & making.')) return [0, 1, 0];
    if (text.startsWith('Technology / Data & AI.')) return [0, 0, 1];
    if (!text.startsWith('Title:')) return [-1, 0, 0];
    if (this.onWindow) return this.onWindow(text);
    if (text.includes('fixture-food')) return [1, 0, 0];
    if (text.includes('fixture-metal')) return [0, 1, 0];
    return [0, 0.1, -0.9];
  }
}
let db: DB, service: BrainService, model: FixtureModel;
const input = (statement = 'fixture-food', title = 'Fixture note') => ({
  title,
  statement,
  idempotency_key: randomUUID(),
});
beforeEach(async () => {
  db = await openDatabase();
  service = new BrainService(db);
  model = new FixtureModel();
  service.classification = new CategoryService(db, model);
});
afterEach(async () => {
  await db.close();
});

describe('semantic suggestions and persistent owner corrections', () => {
  const tiedModel = (otherBranch = false): CategoryEmbedder => ({
    state: 'ready',
    modelId: 'tied-fixture',
    async initialize() {},
    async embed(text) {
      const at = (similarity: number, direction = 1) => [
        similarity,
        direction * Math.sqrt(1 - similarity ** 2),
        0,
      ];
      if (text.startsWith('Title:')) return [1, 0, 0];
      if (text.startsWith('Life / Food & cooking.')) return at(0.84);
      if (
        text.startsWith(
          otherBranch ? 'Technology / Hardware & making.' : 'Life / Health & fitness.',
        )
      )
        return at(0.839, -1);
      return [-1, 0, 0];
    },
  });
  it('uses a broader parent for close sibling matches, while retaining specific suggestions for review', async () => {
    service.classification = new CategoryService(db, tiedModel());
    const item = await service.addKnowledge(
      owner,
      input('A meaningful but ambiguous description of daily activities.'),
    );
    await service.classification.processPending();
    const detail = await service.classification.detail(item.id);
    expect(detail.assigned[0]).toMatchObject({
      path: ['Life'],
      level: 'broad',
      basis: 'broad',
      status: 'suggested',
    });
    expect(detail.suggestions.filter((item) => item.level === 'specific')).toHaveLength(2);
    await service.classification.decide(owner, item.id, {
      action: 'dismiss',
      category_id: detail.assigned[0].category_id,
      expected_version: 0,
    });
    await service.classification.queue();
    await service.processNextJob();
    expect(
      (await service.classification.detail(item.id)).assigned.some(
        (item) => item.level === 'broad',
      ),
    ).toBe(false);
    expect((await service.getKnowledge(owner, item.id)).verified_at).toBeNull();
  });
  it('resolves a close semantic match when explicit notebook keywords corroborate the subject', async () => {
    const classifier = new SemanticCategories(tiedModel());
    const result = await classifier.analyze({
      title: 'Fixture note',
      text: 'An ambiguous description of daily activities.',
      tags: [],
      project: '',
      metadata: { notebook: 'Cooking' },
    });
    expect(result.suggestions[0]).toMatchObject({
      path: ['Life', 'Food & cooking'],
      basis: 'corroborated',
      level: 'specific',
      auto_applied: true,
    });
    expect(result.suggestions.some((item) => item.level === 'broad')).toBe(false);
  });
  it('uses separate title evidence only when it agrees with content and vetoes a conflicting broad branch', async () => {
    const title = 'A descriptive heading about nourishment';
    const base = tiedModel();
    const model: CategoryEmbedder = {
      ...base,
      async embed(text) {
        if (text.startsWith('Technology / Hardware & making.')) return [0, 0, 1];
        if (text.startsWith('Title:') && text.endsWith(`Content: ${title}`)) return [1, 0.5, 0];
        return base.embed(text);
      },
    };
    const input = {
      title,
      text: 'A meaningful but ambiguous description of daily activities.',
      tags: [],
      project: '',
    };
    const result = await new SemanticCategories(model).analyze(input);
    expect(result.suggestions.find((item) => item.auto_applied)).toMatchObject({
      path: ['Life', 'Food & cooking'],
      basis: 'title_corroborated',
      level: 'specific',
    });
    model.embed = async (text) => {
      if (
        text.startsWith('Technology / Hardware & making.') ||
        (text.startsWith('Title:') && text.endsWith(`Content: ${title}`))
      )
        return [0, 0, 1];
      return base.embed(text);
    };
    const conflict = await new SemanticCategories(model).analyze(input);
    expect(conflict.suggestions.every((item) => !item.auto_applied)).toBe(true);
  });
  it('abstains across unrelated branches and for short content without topic signals', async () => {
    const ambiguous = await new SemanticCategories(tiedModel(true)).analyze({
      title: 'Fixture note',
      text: 'A meaningful but ambiguous description of daily activities.',
      tags: [],
      project: '',
    });
    expect(ambiguous.suggestions.every((item) => !item.auto_applied)).toBe(true);
    const empty = await new SemanticCategories(tiedModel()).analyze({
      title: 'Blank reminder',
      text: 'zxqv 172839',
      tags: [],
      project: '',
    });
    expect(empty.suggestions.every((item) => !item.auto_applied)).toBe(true);
  });
  it('uses descriptive titles for short image notes while keeping the normal semantic threshold', async () => {
    const base = tiedModel(true);
    const model = {
      ...base,
      async embed(text: string) {
        if (text.startsWith('Life / Food & cooking.'))
          return [0.8758, Math.sqrt(1 - 0.8758 ** 2), 0];
        if (text.startsWith('Technology / Hardware & making.'))
          return [0.8591, -Math.sqrt(1 - 0.8591 ** 2), 0];
        return base.embed(text);
      },
    };
    const result = await new SemanticCategories(model).analyze({
      title: 'besten Lebkuchen nusselt',
      text: 'IMG_001.jpg',
      tags: [],
      project: 'Erstes Notizbuch',
      metadata: { notebook: 'Erstes Notizbuch' },
    });
    expect(result.suggestions[0]).toMatchObject({
      path: ['Life', 'Food & cooking'],
      auto_applied: true,
    });
    const empty = await new SemanticCategories(model).analyze({
      title: 'Blank reminder',
      text: 'zxqv 172839',
      tags: [],
      project: '',
    });
    expect(empty.suggestions.every((item) => !item.auto_applied)).toBe(true);
  });
  it('uses peer context only to corroborate an ambiguous content suggestion', async () => {
    const input = {
      title: 'Fixture note',
      text: 'A meaningful but ambiguous description of daily activities.',
      tags: [],
      project: '',
    };
    const context = { path: ['Life', 'Food & cooking'], support: 5, peers: 6 };
    const result = await new SemanticCategories(tiedModel(true)).analyze(input, [], context);
    expect(result.suggestions.find((item) => item.auto_applied)).toMatchObject({
      path: context.path,
      basis: 'notebook_context',
      confidence: 'medium',
    });
    const conflict = await new SemanticCategories(new FixtureModel()).analyze(
      { ...input, text: 'fixture-metal' },
      [],
      context,
    );
    expect(conflict.suggestions.find((item) => item.auto_applied)?.path).toEqual([
      'Technology',
      'Hardware & making',
    ]);
  });
  it('uses independent peers in homogeneous notebooks, excludes its own vote, and abstains in mixed notebooks', async () => {
    service.classification = new CategoryService(db, tiedModel(true));
    const importNote = async (notebook: string, title: string) => {
      const job = await service.importSource(owner, {
        title: `${title} ${randomUUID()}`,
        text: `A meaningful but ambiguous description of daily activities. Fixture ${randomUUID()}`,
        idempotency_key: randomUUID(),
      });
      await service.processNextJob();
      const id = (await service.getJob(owner, job.id)).result.source_id as string;
      await db.query('UPDATE sources SET metadata=$2 WHERE id=$1', [
        id,
        JSON.stringify({ notebook: 'General', notebook_id: notebook }),
      ]);
      await db.transaction((q) => service.classification.classify(q, id, true));
      return id;
    };
    const confirm = async (id: string, path: string[]) =>
      service.classification.decide(owner, id, { action: 'accept', path, expected_version: 0 });
    const food = ['Life', 'Food & cooking'];
    const seeds = [];
    for (let i = 0; i < 5; i++) {
      const id = await importNote('homogeneous', 'Fixture note');
      seeds.push(id);
      await confirm(id, food);
    }
    const target = await importNote('homogeneous', 'Fixture note');
    for (let i = 0; i < 6; i++) {
      const id = await importNote('mixed', 'Fixture note');
      await confirm(id, i < 3 ? food : ['Technology', 'Hardware & making']);
    }
    const mixed = await importNote('mixed', 'Fixture note');
    await service.classification.processPending(100);
    expect((await service.classification.detail(target)).assigned).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: food, basis: 'notebook_context' })]),
    );
    expect(
      (await service.classification.detail(mixed)).assigned.some(
        (item) => item.method === 'fallback',
      ),
    ).toBe(true);
    const seed = await service.classification.detail(seeds[0]);
    expect(seed.suggestions.some((item) => item.basis === 'notebook_context')).toBe(false);
    await service.classification.queue();
    await service.processNextJob();
    expect(
      (await service.classification.detail(target)).assigned.some(
        (item) => item.basis === 'notebook_context',
      ),
    ).toBe(true);
  });
  it('runs semantic categorization asynchronously and exposes confidence without verifying the note', async () => {
    const item = await service.addKnowledge(owner, input());
    expect((await service.classification.detail(item.id)).semantic_state).toBe('pending');
    await service.classification.processPending();
    const detail = await service.classification.detail(item.id);
    expect(detail.semantic_state).toBe('completed');
    expect(detail.assigned[0]).toMatchObject({
      path: ['Life', 'Food & cooking'],
      method: 'semantic',
      confidence: 'high',
      similarity: 1,
      status: 'suggested',
    });
    expect(detail.suggestions[0].auto_applied).toBe(true);
    expect((await service.getKnowledge(owner, item.id)).verified_at).toBeNull();
  });
  it('leaves uncertain content unclassified instead of forcing the nearest label', async () => {
    const item = await service.addKnowledge(owner, input('unmatched fixture'));
    await service.classification.processPending();
    const detail = await service.classification.detail(item.id);
    expect(detail.semantic_state).toBe('completed');
    expect(detail.assigned.some((category) => category.method === 'fallback')).toBe(true);
    expect(detail.suggestions).toHaveLength(0);
  });
  it('preserves confirmations and dismissals across edits and repeated rescans', async () => {
    const item = await service.addKnowledge(owner, input());
    await service.classification.processPending();
    let detail = await service.classification.detail(item.id);
    const food = detail.suggestions[0].category_id;
    detail = await service.classification.decide(owner, item.id, {
      action: 'dismiss',
      category_id: food,
      expected_version: detail.decision_version,
    });
    detail = await service.classification.decide(owner, item.id, {
      action: 'accept',
      path: ['My interests', 'Experiments'],
      expected_version: detail.decision_version,
    });
    await service.update(owner, item.id, {
      expected_version: 1,
      title: 'Changed fixture title',
      statement: 'fixture-food revised',
    });
    await service.classification.processPending();
    for (let i = 0; i < 2; i++) {
      await service.classification.queue();
      await service.processNextJob();
    }
    const after = await service.classification.detail(item.id);
    expect(after.assigned.some((category) => category.category_id === food)).toBe(false);
    expect(
      after.assigned.some(
        (category) =>
          category.path.join('/') === 'My interests/Experiments' && category.method === 'manual',
      ),
    ).toBe(true);
    expect(after.decisions).toHaveLength(2);
    expect(after.decision_version).toBe(2);
    expect((await service.getKnowledge(owner, item.id)).version).toBe(2);
    await expect(
      service.classification.decide(owner, item.id, {
        action: 'reset',
        category_id: food,
        expected_version: 0,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const reset = await service.classification.decide(owner, item.id, {
      action: 'reset',
      category_id: food,
      expected_version: 2,
    });
    expect(
      reset.assigned.some(
        (category) => category.category_id === food && category.method === 'semantic',
      ),
    ).toBe(true);
  });
  it('round-trips decisions and independent decision versions in a backup', async () => {
    const item = await service.addKnowledge(owner, input());
    await service.classification.processPending();
    const detail = await service.classification.detail(item.id);
    await service.classification.decide(owner, item.id, {
      action: 'dismiss',
      category_id: detail.suggestions[0].category_id,
      expected_version: 0,
    });
    await service.classification.decide(owner, item.id, {
      action: 'accept',
      path: ['Owner category'],
      expected_version: 1,
    });
    const archive = await service.exportData(owner);
    const fresh = await openDatabase();
    try {
      const restored = new BrainService(fresh);
      restored.classification = new CategoryService(fresh, model);
      await restored.restoreData(owner, archive);
      await restored.classification.processPending();
      const after = await restored.classification.detail(item.id);
      expect(after.decision_version).toBe(2);
      expect(after.decisions.map((decision) => decision.decision).sort()).toEqual([
        'accept',
        'dismiss',
      ]);
      expect(after.assigned.map((category) => category.path.join('/'))).toEqual(['Owner category']);
    } finally {
      await fresh.close();
    }
  });
  it('discards stale inference after concurrent edits and applies the current version', async () => {
    const item = await service.addKnowledge(owner, input());
    let release!: (value: number[]) => void, started!: () => void;
    const waiting = new Promise<number[]>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    model.onWindow = async () => {
      started();
      return waiting;
    };
    const processing = service.classification.processPending();
    await began;
    await service.update(owner, item.id, { expected_version: 1, statement: 'fixture-metal' });
    release([1, 0, 0]);
    await processing;
    expect((await service.classification.detail(item.id)).semantic_state).toBe('pending');
    model.onWindow = undefined;
    await service.classification.processPending();
    expect((await service.classification.detail(item.id)).assigned[0].path).toEqual([
      'Technology',
      'Hardware & making',
    ]);
  });
  it('persists model failures and retries them through the rescan job', async () => {
    const item = await service.addKnowledge(owner, input());
    model.onWindow = async () => {
      throw new Error('Synthetic inference failure');
    };
    await service.classification.processPending();
    expect((await service.classification.detail(item.id)).semantic_state).toBe('error');
    expect((await service.classification.status()).semantic_errors).toBe(1);
    model.onWindow = undefined;
    const scan = await service.classification.queue();
    await service.processNextJob();
    expect((await service.getJob(owner, scan.id)).status).toBe('completed');
    expect((await service.classification.detail(item.id)).semantic_state).toBe('completed');
  });
  it('requires owner authority for corrections while allowing assistants to inspect suggestions', async () => {
    const item = await service.addKnowledge(owner, input());
    const assistant = { id: 'assistant', owner: false, scopes: ['brain:read', 'brain:write'] };
    await expect(
      invokeTool(service, assistant, 'correct_item_category', {
        id: item.id,
        action: 'accept',
        path: ['Owner category'],
        expected_version: 0,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await invokeTool(service, assistant, 'get_item_categories', { id: item.id }),
    ).toHaveProperty('node_id', item.id);
  });
  it('uses tags and notebook context in every bounded window and includes late sections', () => {
    const result = categoryWindows({
      title: 'Title',
      text: 'x'.repeat(10000) + 'late section',
      tags: ['Tag'],
      project: 'Project',
      metadata: { notebook: 'Notebook', stack: 'Stack' },
    });
    expect(result.truncated).toBe(true);
    expect(result.windows).toHaveLength(8);
    expect(result.windows.at(-1)).toContain('late section');
    for (const window of result.windows) {
      expect(window).toContain('Tags: Tag');
      expect(window).toContain('Notebook: Notebook');
      expect(window).toContain('Stack: Stack');
      expect(window.length).toBeLessThan(1000);
    }
  });
});
