import { createElement, useMemo, type ReactNode } from 'react';
import { documentTags, readingLink, type DocumentNode } from '../shared/document';
import './reading.css';

function inline(text: string, depth = 0): ReactNode {
  if (depth > 8) return text;
  const parts: ReactNode[] = [];
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s<>]+)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(start, match.index));
    const value = match[0],
      key = match.index;
    if (value.startsWith('`')) parts.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith('**') || value.startsWith('__'))
      parts.push(<strong key={key}>{inline(value.slice(2, -2), depth + 1)}</strong>);
    else if (value.startsWith('*')) parts.push(<em key={key}>{value.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(value);
      const href = readingLink(link ? link[2] : value);
      parts.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {link ? link[1] : value}
          </a>
        ) : (
          value
        ),
      );
    }
    start = (match.index || 0) + value.length;
  }
  parts.push(text.slice(start));
  return parts;
}
function markdown(text: string, depth = 0): ReactNode[] {
  if (depth > 12) return [<p key="deep-quote">{text}</p>];
  const lines = text.replace(/\r\n?/g, '\n').split('\n'),
    blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const key = i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(
        <pre key={key}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(createElement(`h${heading[1].length}`, { key: i++ }, inline(heading[2])));
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      blocks.push(<hr key={i++} />);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const key = i,
        quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key}>{markdown(quote.join('\n'), depth + 1)}</blockquote>);
      continue;
    }
    const list = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      const key = i,
        ordered = /^\s*\d/.test(line),
        items: ReactNode[] = [];
      while (i < lines.length) {
        const item = /^\s*(?:[-+*]|\d+[.)])\s+(.+)$/.exec(lines[i]);
        if (!item || /^\s*\d/.test(lines[i]) !== ordered) break;
        items.push(<li key={i++}>{inline(item[1])}</li>);
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    const key = i,
      paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      (i === key || !/^\s*(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>|```)/.test(lines[i]))
    )
      paragraph.push(lines[i++]);
    blocks.push(
      <p key={key}>
        {paragraph.map((value, j) => (
          <span key={j}>
            {j > 0 && <br />}
            {inline(value)}
          </span>
        ))}
      </p>,
    );
  }
  return blocks;
}
function documentTree(nodes: DocumentNode[], depth = 0): ReactNode {
  if (depth > 50) return null;
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.text;
    let tag = (documentTags as readonly string[]).includes(node.tag) ? node.tag : 'span';
    const href = node.tag === 'a' && node.href ? readingLink(node.href) : undefined;
    if (tag === 'a' && !href) tag = 'span';
    const props = {
      key: index,
      ...(href ? { href, target: '_blank', rel: 'noreferrer noopener' } : {}),
      ...(node.colSpan ? { colSpan: node.colSpan } : {}),
      ...(node.rowSpan ? { rowSpan: node.rowSpan } : {}),
    };
    return createElement(
      tag,
      props,
      ...(['br', 'hr'].includes(tag) ? [] : [documentTree(node.children, depth + 1)]),
    );
  });
}
export default function DocumentContent({
  text,
  document,
  compact = false,
}: {
  text: string;
  document?: DocumentNode[] | null;
  compact?: boolean;
}) {
  const content = useMemo(
    () => (document?.length ? documentTree(document) : markdown(text)),
    [text, document],
  );
  return <div className={`reading-document ${compact ? 'compact' : ''}`}>{content}</div>;
}
