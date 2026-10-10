import type { Source, SourceAttachment } from '../shared/contracts';
import type { DocumentNode } from '../shared/document';
import DocumentContent from './DocumentContent';
import { FileText, Download } from 'lucide-react';
export type SourceSnapshot = Source & {
  revisions: {
    id: string;
    text: string;
    observed_at: string;
    content_hash?: string;
    parser?: string;
    document?: DocumentNode[] | null;
  }[];
  passages: { id: string; revision_id: string; anchor: string; text: string }[];
  attachments?: SourceAttachment[];
};
export function SourceAttachments({ attachments = [] }: { attachments?: SourceAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <section className="reading-attachments" aria-label="Source attachments">
      <h3>Attachments</h3>
      {attachments.map((attachment) => (
        <figure key={attachment.id}>
          {attachment.mime.startsWith('image/') && attachment.size <= 10 * 1024 * 1024 && (
            <a href={`/api/attachments/${attachment.id}`} target="_blank" rel="noreferrer">
              <img src={`/api/attachments/${attachment.id}`} alt={attachment.name} loading="lazy" />
            </a>
          )}
          <figcaption>
            <a href={`/api/attachments/${attachment.id}`}>
              <FileText size={15} />
              <span>{attachment.name}</span>
              <Download size={14} />
            </a>
            <small>{(attachment.size / 1024).toFixed(1)} KB</small>
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
export default function SourceContent({
  source,
  revision = source.revisions[0],
  compact = false,
}: {
  source: SourceSnapshot;
  revision?: SourceSnapshot['revisions'][number];
  compact?: boolean;
}) {
  return (
    <div className="source-document">
      {revision?.text ? (
        <DocumentContent text={revision.text} document={revision.document} compact={compact} />
      ) : (
        <p className="reading-empty">
          No readable text was exported. Open the retained original or check its attachments.
        </p>
      )}
      <SourceAttachments
        attachments={source.attachments?.filter(
          (attachment) => attachment.revision_id === revision?.id,
        )}
      />
    </div>
  );
}
