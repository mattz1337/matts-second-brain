import { ZipFile } from 'yazl';
import { createHash } from 'node:crypto';

export const media = Buffer.from('Retained Note Station attachment bytes.');
export const mediaMd5 = createHash('md5').update(media).digest('hex');
export async function zipBytes(entries: { name: string; bytes: Buffer; mode?: number }[]) {
  const zip = new ZipFile();
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.on('error', reject);
  });
  for (const entry of entries)
    zip.addBuffer(entry.bytes, entry.name, entry.mode ? { mode: entry.mode } : {});
  zip.end();
  return result;
}
export async function nsxFixture(
  options: { changed?: boolean; missing?: boolean; encrypted?: boolean; malformed?: boolean } = {},
) {
  const attachment = {
    a: {
      name: 'Messung ä.txt',
      md5: mediaMd5,
      ext: 'txt',
      type: 'file',
      size: media.length,
      ref: 'safe-reference',
    },
  };
  const a = {
    title: 'Versuch α',
    parent_id: 'book-a',
    tag: ['Workshop', 'Material'],
    ctime: 1700000000,
    mtime: options.changed ? 1800000000 : 1700000100,
    content: `<p>LabNeedle observations include the measured outcome and material.</p><p>${options.changed ? 'A revised observation includes the corrected measurement.' : 'Repeatable experiments retain the original setup and measurements.'}</p><script>Never execute imported code.</script><a href="https://example.com/lab">Lab reference</a>`,
    attachment,
    encrypt: options.encrypted || false,
  };
  const b = {
    title: 'Second note',
    parent_id: 'book-b',
    content: '<p>SecondNeedle observations stay in a different notebook.</p>',
    attachment,
    ctime: 1600000000,
    mtime: 1600000100,
  };
  const entries = [
    {
      name: 'config.json',
      bytes: Buffer.from(
        JSON.stringify({
          note: ['note-a', 'note-b'],
          notebook: ['book-a', 'book-b'],
          shortcut: null,
        }),
      ),
    },
    { name: 'book-a', bytes: Buffer.from(JSON.stringify({ title: 'Labor', stack: 'Research' })) },
    { name: 'book-b', bytes: Buffer.from(JSON.stringify({ title: 'Personal', stack: '' })) },
    { name: 'note-a', bytes: Buffer.from(JSON.stringify(a)) },
    { name: 'note-b', bytes: Buffer.from(options.malformed ? '{bad JSON' : JSON.stringify(b)) },
  ];
  if (!options.missing) entries.push({ name: `file_${mediaMd5}`, bytes: media });
  return zipBytes(entries);
}
