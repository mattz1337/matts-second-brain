import path from 'node:path';
import { NsxArchive } from '../server/nsx.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: npm run nsx:inspect -- path/to/export.nsx');
const archive = await NsxArchive.open(path.resolve(input));
try {
  const preview = await archive.preview();
  console.log(
    JSON.stringify(
      {
        notes: preview.notes,
        notebooks: preview.notebooks.length,
        attachments: preview.attachments,
        missing_attachments: preview.missing_attachments,
        unreadable_notes: preview.unreadable_notes,
        warnings: preview.warnings,
      },
      null,
      2,
    ),
  );
} finally {
  archive.close();
}
