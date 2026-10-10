import {
  suggestCategories,
  type ClassificationInput,
  type CategorySuggestion,
} from './categorization.js';

export interface CategoryEmbedder {
  state: string;
  modelId: string;
  initialize(): Promise<void>;
  embed(text: string, query?: boolean): Promise<number[] | null>;
}
export interface CategoryPrototype {
  path: string[];
  description: string;
  namespace?: CategorySuggestion['namespace'];
}
export const CATEGORY_PROTOTYPES: CategoryPrototype[] = [
  {
    path: ['Technology', 'Software development'],
    description:
      'Writing and debugging computer programs, apps, APIs, source code and developer tools. Programmierung, Softwareentwicklung, Fehlerbehebung, Webanwendungen und Versionskontrolle.',
  },
  {
    path: ['Technology', 'Data & AI'],
    description:
      'Storing, querying and analyzing data, database tables, SQL, embeddings, artificial intelligence and machine learning. Datenbanken, Datenanalyse, künstliche Intelligenz, Sprachmodelle und Wissensgraphen.',
  },
  {
    path: ['Technology', 'Networks & systems'],
    description:
      'Installing and administering operating systems, networks, routers, servers, storage, home automation and backups. Linux, Heimnetz, Netzwerkverwaltung, NAS, Synology, Systemadministration und Datensicherung.',
  },
  {
    path: ['Technology', 'Hardware & making'],
    description:
      'Building physical things, electronics, circuit boards, microcontrollers, CAD models, 3D printer settings and digital fabrication. Elektronik, Löten, Platinen, Mikrocontroller, 3D-Druck, Basteln und Konstruktion.',
  },
  {
    path: ['Technology', 'Security & privacy'],
    description:
      'Protecting digital accounts and systems, passwords, authentication, encryption, cyber security and personal data privacy. Passwörter, Verschlüsselung, Datenschutz und IT-Sicherheit.',
  },
  {
    path: ['Life', 'Food & cooking'],
    description:
      'Preparing meals, ingredients, kitchen techniques, baking bread, cakes and food recipes. Speisen zubereiten, Kochrezepte, Zutaten, Küchenanleitung, Brotbacken, Kuchen und Lebensmittel.',
  },
  {
    path: ['Life', 'Health & fitness'],
    description:
      'Physical and mental health, medical care, symptoms, wellbeing, exercise, running, strength training and nutrition. Gesundheit, Krankheiten, Arztbesuch, Wohlbefinden, Sport, Krafttraining, Ernährung und Schlaf.',
  },
  {
    path: ['Life', 'Travel & places'],
    description:
      'Planning trips, holidays, destinations, flights, lodging, sightseeing and walking routes. Reiseplanung, Urlaub, Ausflugsziele, Sehenswürdigkeiten, Unterkunft, Zugverbindungen und Wanderwege.',
  },
  {
    path: ['Life', 'Home & garden'],
    description:
      'Maintaining a home, furnishings, repairs, renovation, gardening, growing plants and household organization. Haushalt, Wohnung, Hausbau, Renovierung, Möbel, Gartenpflege und Pflanzen.',
  },
  {
    path: ['Life', 'Family & relationships'],
    description:
      'Personal relationships, family, children, parenting, friends, celebrations, birthdays and shared activities. Familie, Partnerschaft, Freunde, Kinder, Erziehung, Geburtstage und gemeinsame Aktivitäten.',
  },
  {
    path: ['Life', 'Personal organization'],
    description:
      'Personal reminders, checklists, shopping lists, appointments, habits and everyday organization. Persönliche Erinnerungen, Termine, Einkaufslisten, Gewohnheiten und Alltagsorganisation.',
  },
  {
    path: ['Money', 'Personal finance'],
    description:
      'Saving, spending, banking, household budgets, financial investments, retirement planning and loans. Bankkonto, Geldanlage, Aktien, Sparen, Ausgaben, Altersvorsorge, Kredite und Finanzplanung.',
  },
  {
    path: ['Money', 'Taxes & insurance'],
    description:
      'Tax returns, deductions, insurance policies, premiums and financial administrative paperwork. Steuererklärung, Steuerbescheid, Abzüge, Versicherung, Versicherungsbeiträge und finanzielle Unterlagen.',
  },
  {
    path: ['Work', 'Projects & planning'],
    description:
      'Project requirements, product specifications, task planning, schedules, milestones and team coordination. Projektplanung, Aufgaben, Meilensteine, Anforderungen, Produktentwicklung und Arbeitsorganisation.',
  },
  {
    path: ['Work', 'Business & career'],
    description:
      'Jobs, professional development, recruiting, company strategy, sales, customer services and business processes. Beruf, Karriere, Bewerbung, Unternehmensstrategie, Kunden, Vertrieb und Geschäftsprozesse.',
  },
  {
    path: ['Work', 'Meetings & communication'],
    description:
      'Meeting notes, discussions, minutes, presentations, correspondence, calls and agreements between coworkers. Besprechungsnotizen, Protokolle, Gespräch, Präsentation, E-Mails und berufliche Kommunikation.',
  },
  {
    path: ['Learning', 'Knowledge & research'],
    description:
      'Studying, research methods, learning techniques, scientific findings, references, citations and organizing knowledge. Lernen, Studium, Forschung, wissenschaftliche Methoden, Literaturrecherche und Wissensmanagement.',
  },
  {
    path: ['Learning', 'Science & mathematics'],
    description:
      'Mathematics, physics, chemistry, biology, calculations, equations, natural phenomena and experiments. Mathematik, Physik, Chemie, Biologie, Formeln, Berechnungen und Naturwissenschaften.',
  },
  {
    path: ['Learning', 'Languages'],
    description:
      'Language learning, grammar, vocabulary, translation, phrases and writing skills. Sprachen lernen, Grammatik, Vokabeln, Übersetzung, Redewendungen und Sprachübungen.',
  },
  {
    path: ['Culture', 'Books & media'],
    description:
      'Reading books, films, television, podcasts, authors, reviews, quotations and media recommendations. Bücher, Lesen, Filme, Serien, Autoren, Zitate, Podcasts und Rezensionen.',
  },
  {
    path: ['Culture', 'Art & creativity'],
    description:
      'Drawing, design, creative writing, music, instruments, photography, artistic inspiration and visual arts. Kunst, Zeichnen, Gestaltung, Musik, Instrumente, Fotografie und kreative Ideen.',
  },
  {
    path: ['Leisure', 'Games & hobbies'],
    description:
      'Video games, board games, recreational hobbies, cycling, mountain biking, sports events, entertainment and free time activities. Computerspiele, Brettspiele, Radfahren, Mountainbike, MTB, Freizeit, Hobbys und Freizeitaktivitäten.',
  },
  {
    path: ['Society', 'Law & administration'],
    description:
      'Legal contracts, laws, government forms, official documents, permits and administrative processes. Recht, Gesetze, Verträge, Behörden, Anträge, Formulare und Verwaltung.',
  },
  {
    path: ['Society', 'History & ideas'],
    description:
      'Historical events, politics, philosophy, religion, ethics, social issues and cultural ideas. Geschichte, Politik, Philosophie, Religion, Ethik, Gesellschaft und Weltanschauung.',
  },
];
export interface SemanticSuggestion extends CategorySuggestion {
  confidence: 'high' | 'medium' | 'low';
  similarity: number;
  margin: number;
  auto_applied: boolean;
  model_id: string;
  level: 'specific' | 'broad';
  basis: 'semantic' | 'corroborated' | 'title_corroborated' | 'notebook_context' | 'broad';
}
export interface NotebookContext {
  path: string[];
  support: number;
  peers: number;
}
export interface SemanticResult {
  suggestions: SemanticSuggestion[];
  chunks: number;
  truncated: boolean;
}
const cosine = (a: number[], b: number[]) => {
  if (!a.length || a.length !== b.length || [...a, ...b].some((v) => !Number.isFinite(v)))
    throw new Error('Invalid category embedding.');
  const length = Math.hypot(...a) * Math.hypot(...b);
  if (!length) throw new Error('Empty category embedding.');
  return Math.max(-1, Math.min(1, a.reduce((sum, value, i) => sum + value * b[i], 0) / length));
};
/** Bounded distributed windows preserve later sections instead of silently using only a prefix. */
export function categoryWindows(input: ClassificationInput) {
  const context = [
    `Title: ${input.title}`,
    `Tags: ${input.tags.join(', ')}`,
    `Notebook: ${input.metadata?.notebook || input.project}`,
    `Stack: ${input.metadata?.stack || ''}`,
  ]
    .join('\n')
    .slice(0, 350);
  const text = input.text.trim();
  const total = Math.max(1, Math.ceil(text.length / 550));
  const count = Math.min(total, 8);
  return {
    windows: Array.from({ length: count }, (_, i) => {
      const index = count === 1 ? 0 : Math.round((i * (total - 1)) / (count - 1));
      return `${context}\nContent: ${text.slice(index * 550, (index + 1) * 550)}`;
    }),
    truncated: total > count,
  };
}
export class SemanticCategories {
  private prototypes = new Map<string, Promise<number[] | null>>();
  constructor(
    private embedder: CategoryEmbedder,
    public minSimilarity = 0.78,
    public autoSimilarity = 0.82,
  ) {
    if (
      !Number.isFinite(minSimilarity) ||
      !Number.isFinite(autoSimilarity) ||
      minSimilarity < 0 ||
      autoSimilarity > 1 ||
      autoSimilarity < minSimilarity
    )
      throw new Error(
        'Category similarity thresholds must satisfy 0 <= minimum <= automatic <= 1.',
      );
  }
  async analyze(
    input: ClassificationInput,
    extra: CategoryPrototype[] = [],
    notebookContext?: NotebookContext,
  ): Promise<SemanticResult> {
    const catalog = [...CATEGORY_PROTOTYPES, ...extra];
    const prototypes = await Promise.all(
      catalog.map(async (prototype) => {
        const key = JSON.stringify(prototype);
        if (!this.prototypes.has(key))
          this.prototypes.set(
            key,
            this.embedder
              .embed(`${prototype.path.join(' / ')}. ${prototype.description}`, true)
              .catch((error) => {
                this.prototypes.delete(key);
                throw error;
              }),
          );
        const embedding = await this.prototypes.get(key)!;
        if (!embedding) {
          this.prototypes.delete(key);
          throw new Error('Local embedding model is unavailable.');
        }
        return embedding;
      }),
    );
    const { windows, truncated } = categoryWindows(input);
    const vectors: number[][] = [];
    for (const window of windows) {
      const vector = await this.embedder.embed(window, true);
      if (!vector) throw new Error('Local embedding model is unavailable.');
      vectors.push(vector);
    }
    const ranked = catalog
      .map((prototype, i) => ({
        prototype,
        score: Math.max(...vectors.map((vector) => cosine(vector, prototypes[i]))),
      }))
      .sort(
        (a, b) =>
          b.score - a.score || a.prototype.path.join('/').localeCompare(b.prototype.path.join('/')),
      );
    const best = ranked[0].score;
    const separation = best - (ranked[1]?.score || 0);
    const rules = suggestCategories(input).filter((item) => item.method === 'content_rule');
    const meaningful =
      (input.text.match(/\p{L}/gu) || []).length >= 12 ||
      ((input.title.match(/\p{L}/gu) || []).length >= 16 &&
        !/^https?:\/\/\S+$/i.test(input.title.trim())) ||
      rules.length > 0 ||
      input.tags.some((tag) => tag.trim().length >= 4);
    const suggestions = ranked
      .filter((match) => match.score >= this.minSimilarity && best - match.score <= 0.045)
      .slice(0, 3)
      .map((match, i): SemanticSuggestion => {
        const corroboration = rules.find(
          (rule) =>
            rule.path.join('/') === match.prototype.path.join('/') &&
            (match.prototype.namespace || 'topics') === rule.namespace,
        );
        const auto =
          (meaningful || match.score >= 0.9) &&
          ((match.score >= this.autoSimilarity &&
            (i === 0 ? separation >= 0.008 || match.score >= 0.88 : match.score >= 0.86)) ||
            (!!corroboration && match.score >= this.minSimilarity));
        const confidence = auto
          ? match.score >= 0.86 && separation >= 0.02
            ? 'high'
            : 'medium'
          : 'low';
        return {
          path: match.prototype.path,
          namespace: match.prototype.namespace || 'topics',
          method: 'semantic',
          rationale:
            (corroboration
              ? `Meaning and explicit topic keywords agree. ${corroboration.rationale} `
              : '') +
            'Local semantic comparison of note content, title, tags, notebook and stack with the category description. Similarity and confidence are model estimates, not probabilities or factual verification.',
          confidence,
          similarity: Number(match.score.toFixed(4)),
          margin: Number(separation.toFixed(4)),
          auto_applied: auto,
          model_id: this.embedder.modelId,
          level: 'specific',
          basis: corroboration ? 'corroborated' : 'semantic',
        };
      });
    let headingWinner: CategoryPrototype | undefined;
    if (
      !suggestions.some((item) => item.auto_applied) &&
      meaningful &&
      (input.title.match(/\p{L}/gu) || []).length >= 16 &&
      !/^https?:\/\/\S+$/i.test(input.title.trim())
    ) {
      const heading = await this.embedder.embed(
        `Title: ${input.title}\nTags: ${input.tags.join(', ')}\nContent: ${input.title}`,
        true,
      );
      if (!heading) throw new Error('Local embedding model is unavailable.');
      const headingRanked = catalog
        .map((prototype, i) => ({ prototype, score: cosine(heading, prototypes[i]) }))
        .sort((a, b) => b.score - a.score);
      const first = headingRanked[0];
      if (
        first.score >= this.autoSimilarity &&
        (first.score - headingRanked[1].score >= 0.008 || first.score >= 0.88)
      ) {
        headingWinner = first.prototype;
        const agreement = suggestions.find(
          (item) =>
            item.path.join('/') === first.prototype.path.join('/') &&
            item.namespace === (first.prototype.namespace || 'topics'),
        );
        if (agreement) {
          agreement.auto_applied = true;
          agreement.confidence = 'medium';
          agreement.basis = 'title_corroborated';
          agreement.rationale =
            'Separate interpretation of the title and tags agrees with this content-based suggestion. This resolves a close content match; it remains a reviewable organization suggestion, not factual verification.';
        }
      }
    }
    // Peer subjects only resolve a retained, close content match. They never replace
    // a clear subject, and generic/mixed notebooks do not supply a context vote.
    if (meaningful && notebookContext && !suggestions.some((item) => item.auto_applied)) {
      const agreement = suggestions.find(
        (item) =>
          item.namespace === 'topics' && item.path.join('/') === notebookContext.path.join('/'),
      );
      const headingAgrees =
        !headingWinner || headingWinner.path.join('/') === notebookContext.path.join('/');
      if (agreement && headingAgrees && agreement.similarity >= this.autoSimilarity) {
        agreement.auto_applied = true;
        agreement.confidence = 'medium';
        agreement.basis = 'notebook_context';
        agreement.rationale = `${notebookContext.support} of ${notebookContext.peers} other notes in this notebook independently support this subject and agree with a close content match. Notebook context is supporting evidence for organization, not a subject category or factual verification.`;
      }
    }
    // A close choice between siblings can still provide a reliable broader subject.
    // Compare against every competing branch, rather than hiding the note merely
    // because two children of the same branch are hard to distinguish.
    if (
      meaningful &&
      !suggestions.some((item) => item.auto_applied) &&
      best >= this.autoSimilarity
    ) {
      const first = ranked[0],
        second = ranked[1];
      const namespace = first.prototype.namespace || 'topics';
      const parent: string[] = [];
      if (namespace === (second?.prototype.namespace || 'topics')) {
        for (
          let i = 0;
          i < Math.min(first.prototype.path.length, second.prototype.path.length) - 1;
          i++
        ) {
          if (first.prototype.path[i] !== second.prototype.path[i]) break;
          parent.push(first.prototype.path[i]);
        }
      }
      const outside = ranked.find(
        (match) =>
          (match.prototype.namespace || 'topics') !== namespace ||
          parent.some((part, i) => match.prototype.path[i] !== part),
      );
      const margin = best - (outside?.score ?? 1);
      const headingAgrees =
        !headingWinner ||
        ((headingWinner.namespace || 'topics') === namespace &&
          parent.every((part, i) => headingWinner!.path[i] === part));
      if (parent.length && headingAgrees && best - second.score < 0.008 && margin >= 0.008) {
        suggestions.unshift({
          path: parent,
          namespace,
          method: 'semantic',
          rationale: `The closest specific subjects share the ${parent.join(' / ')} branch and are too close to choose between. This broader subject is separated from other branches; review the specific suggestions to narrow it. Organization only, not factual verification.`,
          confidence: 'medium',
          similarity: Number(best.toFixed(4)),
          margin: Number(margin.toFixed(4)),
          auto_applied: true,
          model_id: this.embedder.modelId,
          level: 'broad',
          basis: 'broad',
        });
      }
    }
    return { suggestions, chunks: windows.length, truncated };
  }
}
