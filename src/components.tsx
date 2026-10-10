import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  X,
  ArrowUpRight,
  FileText,
  Lightbulb,
  Check,
  AlertCircle,
  Clock,
  BookOpen,
  ChevronRight,
} from 'lucide-react';
import type { Knowledge } from '../shared/contracts';
import { pretty, date } from './api';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function KnowledgeCard({
  item,
  onOpen,
  compact = false,
  selected,
}: {
  item: Knowledge;
  onOpen: (id: string) => void;
  compact?: boolean;
  selected?: boolean;
}) {
  const supported = ['cited', 'corroborated'].includes(item.evidence_status);
  const stale = ['stale', 'review_due'].includes(item.freshness);
  return (
    <button
      className={`knowledge-card ${compact ? 'small' : ''} ${selected ? 'is-selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onOpen(item.id)}
    >
      <div className={`knowledge-icon ${item.kind === 'factual_assertion' ? 'sage' : 'amber'}`}>
        {item.kind === 'factual_assertion' ? <FileText size={18} /> : <Lightbulb size={18} />}
      </div>
      <div className="knowledge-content">
        <div className="knowledge-heading">
          <h3>{item.title}</h3>
          <ArrowUpRight size={16} />
        </div>
        {!compact && <p>{item.statement}</p>}
        <div className="knowledge-meta">
          {item.tags.slice(0, 2).map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
          <span className={`evidence-label ${supported ? 'supported' : ''}`}>
            {supported ? <Check size={12} /> : <BookOpen size={12} />}{' '}
            {pretty(item.evidence_status)}
          </span>
          {stale && (
            <span className="overdue-label">
              <Clock size={12} /> Review due
            </span>
          )}
          {item.lifecycle === 'candidate' && <Badge tone="amber">Candidate</Badge>}
          {item.conflict_count > 0 && (
            <span className="overdue-label">
              <AlertCircle size={12} /> Conflict
            </span>
          )}
          {item.match_type && <span className="match-label">{item.match_type}</span>}
        </div>
      </div>
      {compact && <span className="card-date">{date(item.updated_at)}</span>}
    </button>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <BookOpen size={28} />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading-state">
      <div className="spinner" />
      Loading your knowledge…
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('input,button,textarea')?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key === 'Tab') {
        const focusable = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]',
          ) || []),
        ];
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function LinkAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ChevronRight size={15} />
    </button>
  );
}
