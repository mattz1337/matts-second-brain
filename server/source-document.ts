import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  documentTags,
  readingLink,
  type DocumentNode,
  type DocumentTag,
} from '../shared/document.js';

/** Return a bounded presentation tree, never executable imported HTML or attributes. */
export function sourceDocument(parser: string, original: string | null): DocumentNode[] | null {
  if (
    !original ||
    !['html-v1', 'synology-nsx-json-v1'].includes(parser) ||
    original.length > 3 * 1024 * 1024
  )
    return null;
  try {
    const raw = Buffer.from(original, 'base64').toString('utf8');
    const record = parser === 'synology-nsx-json-v1' ? JSON.parse(raw) : null;
    if (record && (record.encrypt === true || record.encrypt === 1 || record.encrypt === 'true'))
      return null;
    const html = record ? record.content : raw;
    if (typeof html !== 'string' || html.length > 2 * 1024 * 1024) return null;
    const $ = load(html);
    const blocked = new Set([
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'svg',
      'math',
      'noscript',
      'form',
      'input',
      'button',
      'select',
      'textarea',
      'template',
      'nav',
      'header',
      'footer',
      'aside',
    ]);
    const allowed = new Set<string>(documentTags);
    let count = 0,
      exhausted = false;
    const readable = (nodes: DocumentNode[]): boolean =>
      nodes.some((node) =>
        node.type === 'text' ? Boolean(node.text.trim()) : readable(node.children),
      );
    const walk = (node: AnyNode, depth = 0): DocumentNode[] => {
      if (depth > 50 || ++count > 15000) {
        exhausted = true;
        return [];
      }
      if (node.type === 'text') return [{ type: 'text', text: node.data }];
      if (!('name' in node) || !('attribs' in node) || blocked.has(node.name)) return [];
      if (node.name === 'img')
        return [{ type: 'text', text: node.attribs.alt ? `[Image: ${node.attribs.alt}]` : '' }];
      const children = node.children.flatMap((child) => walk(child, depth + 1));
      if (node.name === 'li' && !readable(children)) return [];
      if (!allowed.has(node.name)) return children;
      let tag = node.name as DocumentTag;
      if (tag === 'span' && /font-weight\s*:\s*(?:bold|[7-9]00)/i.test(node.attribs.style || ''))
        tag = 'strong';
      const result: Extract<DocumentNode, { type: 'element' }> = { type: 'element', tag, children };
      if (tag === 'a') {
        const href = readingLink(node.attribs.href || '');
        if (href) result.href = href;
      }
      if (tag === 'td' || tag === 'th')
        for (const attr of ['colspan', 'rowspan'] as const) {
          const value = Number(node.attribs[attr]);
          if (Number.isInteger(value) && value > 1 && value <= 16)
            result[attr === 'colspan' ? 'colSpan' : 'rowSpan'] = value;
        }
      return [result];
    };
    const root = parser === 'html-v1' && $('main').length ? $('main').first() : $('body');
    const result = root
      .contents()
      .toArray()
      .flatMap((node) => walk(node));
    return exhausted ? null : result;
  } catch {
    return null;
  }
}
