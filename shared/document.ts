export const documentTags = [
  'p',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'code',
  'pre',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'br',
  'hr',
  'a',
] as const;
export type DocumentTag = (typeof documentTags)[number];
export type DocumentNode =
  | { type: 'text'; text: string }
  | {
      type: 'element';
      tag: DocumentTag;
      children: DocumentNode[];
      href?: string;
      colSpan?: number;
      rowSpan?: number;
    };
export function readingLink(value: string) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
