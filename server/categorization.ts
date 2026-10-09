/** Local, explainable organization suggestions. These rules do not verify content. */
export const CATEGORY_ENGINE = 'semantic-taxonomy-v2';
export interface ClassificationInput {
  title: string;
  text: string;
  tags: string[];
  project: string;
  metadata?: { notebook?: string; stack?: string } | null;
}
export interface CategorySuggestion {
  path: string[];
  namespace: 'topics' | 'collections' | 'custom';
  method: 'content_rule' | 'metadata' | 'fallback' | 'semantic' | 'manual';
  rationale: string;
}
const rules: [string[], string[]][] = [
  [
    ['Technology', 'Software development'],
    [
      'programming',
      'software',
      'typescript',
      'javascript',
      'python',
      'react',
      'api',
      'git',
      'programmierung',
      'entwicklung',
      'code',
      'docker',
    ],
  ],
  [
    ['Technology', 'Data & AI'],
    [
      'database',
      'postgresql',
      'postgres',
      'sql',
      'vector',
      'embedding',
      'machine learning',
      'artificial intelligence',
      'knowledge graph',
      'datenbank',
      'ki',
      'wissensgraph',
      'llm',
      'mcp',
    ],
  ],
  [
    ['Technology', 'Networks & systems'],
    [
      'synology',
      'nas',
      'server',
      'linux',
      'network',
      'netzwerk',
      'wifi',
      'router',
      'backup',
      'heimnetz',
    ],
  ],
  [
    ['Technology', 'Hardware & making'],
    [
      '3d printing',
      '3d druck',
      '3d-druck',
      'freecad',
      'gridfinity',
      'arduino',
      'raspberry',
      'electronics',
      'elektronik',
      'cad',
      'soldering',
      'löten',
    ],
  ],
  [
    ['Life', 'Food & cooking'],
    [
      'recipe',
      'recipes',
      'cooking',
      'baking',
      'rezept',
      'rezepte',
      'kochen',
      'backen',
      'zutaten',
      'ingredients',
    ],
  ],
  [
    ['Life', 'Health & fitness'],
    [
      'fitness',
      'workout',
      'exercise',
      'health',
      'gesundheit',
      'training',
      'sport',
      'medizin',
      'schlaf',
      'nutrition',
      'ernährung',
    ],
  ],
  [
    ['Life', 'Travel & places'],
    [
      'travel',
      'itinerary',
      'holiday',
      'vacation',
      'reise',
      'reisen',
      'urlaub',
      'hotel',
      'flight',
      'flug',
      'wanderung',
    ],
  ],
  [
    ['Life', 'Home & garden'],
    [
      'garden',
      'gardening',
      'garten',
      'pflanzen',
      'plants',
      'renovation',
      'renovierung',
      'household',
      'haushalt',
      'furniture',
      'möbel',
    ],
  ],
  [
    ['Money', 'Personal finance'],
    [
      'budget',
      'finance',
      'finanzen',
      'investment',
      'investing',
      'aktien',
      'etf',
      'steuer',
      'tax',
      'insurance',
      'versicherung',
      'mortgage',
    ],
  ],
  [
    ['Work', 'Projects & planning'],
    [
      'project plan',
      'projektplan',
      'roadmap',
      'milestone',
      'meilenstein',
      'meeting',
      'besprechung',
      'task',
      'aufgaben',
      'deadline',
      'prd',
    ],
  ],
  [
    ['Learning', 'Knowledge & research'],
    [
      'research',
      'forschung',
      'study',
      'studium',
      'learning',
      'lernen',
      'evidence',
      'knowledge',
      'wissen',
      'literature',
      'literatur',
    ],
  ],
  [
    ['Culture', 'Books & media'],
    [
      'book',
      'books',
      'buch',
      'bücher',
      'film',
      'movie',
      'music',
      'musik',
      'podcast',
      'photography',
      'fotografie',
    ],
  ],
];
const normalized = (value: string) =>
  value.toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/\p{M}/gu, '');
function hits(value: string, words: string[]) {
  const text = normalized(value);
  return words.filter((word) => {
    const escaped = normalized(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
  });
}
export function suggestCategories(input: ClassificationInput): CategorySuggestion[] {
  const result: CategorySuggestion[] = [];
  const prominent = [input.title, ...input.tags].join('\n');
  const ranked = rules
    .map(([path, words]) => {
      const heading = hits(prominent, words);
      const body = hits(input.text, words);
      return {
        path,
        score: heading.length * 3 + body.length,
        words: [...new Set([...heading, ...body])],
      };
    })
    .filter((rule) => rule.score >= 2)
    .sort((a, b) => b.score - a.score || a.path.join('/').localeCompare(b.path.join('/')));
  for (const rule of ranked.slice(0, 3))
    result.push({
      path: rule.path,
      namespace: 'topics',
      method: 'content_rule',
      rationale: `Local keyword rule matched: ${rule.words.join(', ')}. Organization suggestion; not factual verification.`,
    });
  for (const tag of input.tags) {
    const path = tag
      .split(/\s*(?:\/|>)\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (path.length > 1)
      result.push({
        path,
        namespace: 'custom',
        method: 'metadata',
        rationale: 'Hierarchy explicitly supplied in a tag.',
      });
  }
  if (!result.length)
    result.push({
      path: ['Uncategorized'],
      namespace: 'topics',
      method: 'fallback',
      rationale:
        'No sufficiently specific local category rule matched. Review or add a hierarchical tag.',
    });
  if (input.metadata?.notebook)
    result.push({
      path: [
        'Notebooks',
        ...(input.metadata.stack ? [input.metadata.stack] : []),
        input.metadata.notebook,
      ],
      namespace: 'collections',
      method: 'metadata',
      rationale:
        'Original Note Station stack and notebook; organizational metadata, not an inferred subject.',
    });
  return result;
}
