import type { Detail, GraphNode } from '../shared/contracts';
import type { DocumentNode } from '../shared/document';
import { api, pretty } from './api';
import { useResource } from './hooks';
import DocumentContent from './DocumentContent';
import SourceContent, { type SourceSnapshot } from './SourceContent';

function excerpt(nodes: DocumentNode[], budget = { remaining: 3500 }): DocumentNode[] {
  const result: DocumentNode[] = [];
  for (const node of nodes) {
    if (budget.remaining <= 0) break;
    if (node.type === 'text') {
      const text = node.text.slice(0, budget.remaining);
      budget.remaining -= text.length;
      result.push({ ...node, text });
    } else result.push({ ...node, children: excerpt(node.children, budget) });
  }
  return result;
}
export default function GraphNodePreview({
  node,
  revision = 0,
}: {
  node: GraphNode;
  revision?: number;
}) {
  const resource = useResource<{
    id: string;
    source?: SourceSnapshot;
    knowledge?: Detail;
  }>(async () => {
    if (node.type === 'source')
      return { id: node.id, source: await api<SourceSnapshot>(`/sources/${node.id}`) };
    return { id: node.id, knowledge: await api<Detail>(`/knowledge/${node.id}`) };
  }, [node.id, revision]);
  const data = resource.data?.id === node.id ? resource.data : null;
  if (resource.error)
    return (
      <div className="node-preview-error" role="alert">
        Could not load this preview.<button onClick={resource.retry}>Try again</button>
      </div>
    );
  if (!data)
    return (
      <div className="node-preview-loading" aria-busy="true">
        Loading preview…
      </div>
    );
  const source = data.source,
    knowledge = data.knowledge,
    original = source?.revisions[0];
  return (
    <section className="node-reading-preview" aria-label="Selected node preview">
      <div className="node-preview-metadata">
        {source
          ? source.metadata?.notebook || source.project || 'Retained original'
          : knowledge
            ? `${pretty(knowledge.evidence_status)} · ${pretty(knowledge.freshness)}`
            : ''}
      </div>
      {source && (
        <SourceContent
          compact
          source={{
            ...source,
            attachments: source.attachments
              ?.filter((item) => item.revision_id === original?.id)
              .slice(0, 2),
          }}
          revision={
            original
              ? {
                  ...original,
                  text: original.text.slice(0, 3500),
                  document: original.document ? excerpt(original.document) : null,
                }
              : undefined
          }
        />
      )}
      {knowledge && <DocumentContent text={knowledge.statement.slice(0, 3500)} compact />}
      {(original?.text.length || knowledge?.statement.length || 0) > 3500 && (
        <small className="preview-truncated">
          Preview shortened. Open the full item to keep reading.
        </small>
      )}
    </section>
  );
}
