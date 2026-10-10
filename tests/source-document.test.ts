import { describe, it, expect } from 'vitest';
import { sourceDocument } from '../server/source-document';
import { readingLink } from '../shared/document';
const encoded = (html: string) => Buffer.from(html).toString('base64');
describe('retained source presentation', () => {
  it('preserves headings, nested lists, emphasis, links and table structure without rewriting stored content', () => {
    const html =
      '<h2>Exercises</h2><ol><li><strong>Backwards walk</strong> 5–10 minutes<ul><li>Slow pace</li></ul></li><li>Heel raises</li><li><br></li></ol><a href="https://example.com/routine">Reference</a><table><tr><th colspan="2">Sets</th></tr><tr><td>3</td><td>12 reps</td></tr></table>';
    const tree = sourceDocument('synology-nsx-json-v1', encoded(JSON.stringify({ content: html })));
    const json = JSON.stringify(tree);
    expect(json).toContain('"tag":"ol"');
    expect(json).toContain('"tag":"ul"');
    expect(json).toContain('"tag":"strong"');
    expect(json).toContain('"href":"https://example.com/routine"');
    expect(json).toContain('"colSpan":2');
    expect(json).toContain('5–10 minutes');
    expect(json.match(/"tag":"li"/g)).toHaveLength(3);
  });
  it('omits executable elements, remote resources, styles and unsafe link protocols', () => {
    const tree = sourceDocument(
      'html-v1',
      encoded(
        '<p onclick="evil()" style="background:url(https://evil.test)">Safe<script>evil()</script><iframe src="https://evil.test"></iframe><svg onload="evil()"></svg><a href="javascript:evil()">Unsafe link</a><img src="https://evil.test" onerror="evil()" alt="Picture"><strong>Text</strong></p>',
      ),
    );
    const json = JSON.stringify(tree);
    expect(json).not.toMatch(/evil|onclick|onerror|iframe|script|svg|style|src/);
    expect(json).toContain('Unsafe link');
    expect(json).toContain('Safe');
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,test',
      'vbscript:test',
      'https://user:secret@example.com',
    ])
      expect(readingLink(href)).toBeUndefined();
  });
  it('falls back to extracted text for encrypted, malformed, unsupported or oversized originals', () => {
    expect(
      sourceDocument(
        'synology-nsx-json-v1',
        encoded(JSON.stringify({ encrypt: true, content: 'ciphertext' })),
      ),
    ).toBeNull();
    expect(sourceDocument('synology-nsx-json-v1', encoded('invalid'))).toBeNull();
    expect(sourceDocument('pdfjs-text-v1', encoded('binary'))).toBeNull();
    expect(sourceDocument('html-v1', 'x'.repeat(3 * 1024 * 1024 + 1))).toBeNull();
    expect(
      sourceDocument('html-v1', encoded('<div>'.repeat(60) + 'Too deep' + '</div>'.repeat(60))),
    ).toBeNull();
  });
});
