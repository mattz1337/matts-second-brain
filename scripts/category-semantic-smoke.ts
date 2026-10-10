import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { Embeddings } from '../server/embeddings.js';
import { SemanticCategories } from '../server/semantic-categories.js';
const db = await openDatabase();
try {
  const model = new Embeddings(db);
  await model.initialize();
  assert.equal(model.state, 'ready', 'Local semantic model must load.');
  const classifier = new SemanticCategories(model);
  const cases = [
    {
      title: 'besten Lebkuchen nusselt',
      text: 'IMG_001.jpg',
      notebook: 'Erstes Notizbuch',
      expected: 'Food & cooking',
    },
    {
      title: 'Extrusion adjustment',
      text: 'Reducing how far the filament is pulled back helps prevent thin hairs between printed parts.',
      notebook: 'Maker experiments',
      expected: 'Hardware & making',
    },
    {
      title: 'Düsenversuch',
      text: 'Weniger Rückzug des Filaments verhindert feine Fäden zwischen den gedruckten Bauteilen.',
      notebook: 'Bastelprojekte',
      expected: 'Hardware & making',
    },
    {
      title: 'Morning loaf',
      text: 'Knead flour with water and yeast, allow the dough to rise, then place it in the hot oven.',
      notebook: 'Kitchen notes',
      expected: 'Food & cooking',
    },
    {
      title: 'Fahrt durch die Berge',
      text: 'Wir nehmen den Zug nach Innsbruck, verbringen zwei Nächte dort und laufen dann zur Hütte.',
      notebook: 'Sommerferien',
      expected: 'Travel & places',
    },
  ];
  const results = [];
  for (const test of cases) {
    const result = await classifier.analyze({
      title: test.title,
      text: test.text,
      tags: [],
      project: test.notebook,
      metadata: { notebook: test.notebook },
    });
    assert.equal(result.suggestions[0]?.path.at(-1), test.expected);
    assert.equal(result.suggestions[0].auto_applied, true);
    results.push({
      title: test.title,
      category: result.suggestions[0].path.join(' / '),
      similarity: result.suggestions[0].similarity,
      confidence: result.suggestions[0].confidence,
    });
  }
  const ambiguous = await classifier.analyze({
    title: 'Blank reminder',
    text: 'zxqv 172839',
    tags: [],
    project: '',
  });
  assert.equal(
    ambiguous.suggestions.some((suggestion) => suggestion.auto_applied),
    false,
    'Ambiguous text must not be forced into a category.',
  );
  console.log(
    JSON.stringify(
      { model: model.modelId, cases: results, ambiguous_auto_assignments: 0 },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
