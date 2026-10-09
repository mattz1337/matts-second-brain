import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { AppError, requireCondition } from './errors.js';
import type { NsxPreview, NoteStationMetadata } from '../shared/contracts.js';

export const NSX_LIMIT = 512 * 1024 * 1024;
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const incomingDirectory = (root: string) => path.join(root, 'incoming');
export function storedPath(root: string, key: string, kind: 'incoming' | 'attachments') {
  requireCondition(
    kind === 'attachments' ? /^[a-f0-9]{64}$/.test(key) : /^[a-f0-9-]{36}$/.test(key),
    400,
    'invalid_storage_key',
    'Invalid stored file identifier.',
  );
  return path.join(root, kind, key);
}
export async function storeAttachment(root: string, bytes: Buffer) {
  const digest = sha256(bytes);
  await mkdir(path.join(root, 'attachments'), { recursive: true });
  const file = storedPath(root, digest, 'attachments');
  try {
    if (sha256(await readFile(file)) === digest) return digest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await removeStoredFile(temporary);
  }
  return digest;
}
export async function removeStoredFile(file: string) {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Random-access ZIP reading: archive and media are never expanded into RAM together. */
export class SafeZip {
  private constructor(
    public zip: ZipFile,
    public entries: Map<string, Entry>,
  ) {}
  static async open(file: string) {
    const zip = await new Promise<ZipFile>((resolve, reject) =>
      yauzl.open(
        file,
        { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
        (error, result) =>
          error
            ? reject(
                new AppError(400, 'invalid_zip', 'The file is not a readable ZIP/NSX archive.'),
              )
            : resolve(result!),
      ),
    );
    try {
      const entries = await new Promise<Map<string, Entry>>((resolve, reject) => {
        const entries = new Map<string, Entry>();
        let expanded = 0;
        zip.on('error', reject);
        zip.on('entry', (entry: Entry) => {
          try {
            requireCondition(
              !entries.has(entry.fileName) && !entry.isEncrypted(),
              400,
              'invalid_zip',
              'Archive contains duplicate or encrypted ZIP entries.',
            );
            requireCondition(
              !entry.fileName.includes('\\') &&
                !entry.fileName.split('/').includes('..') &&
                !entry.fileName.startsWith('/') &&
                !/^[a-z]:/i.test(entry.fileName),
              400,
              'unsafe_archive',
              'Archive contains an unsafe entry name.',
            );
            const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
            requireCondition(
              unixType !== 0xa000,
              400,
              'unsafe_archive',
              'Archive symlinks are not supported.',
            );
            expanded += entry.uncompressedSize;
            requireCondition(
              entries.size < 30000 &&
                expanded <= 2 * 1024 ** 3 &&
                entry.uncompressedSize <= NSX_LIMIT,
              400,
              'archive_limit',
              'Archive exceeds entry or expanded-size limits.',
            );
            entries.set(entry.fileName, entry);
            zip.readEntry();
          } catch (error) {
            reject(error);
          }
        });
        zip.on('end', () => resolve(entries));
        zip.readEntry();
      });
      return new SafeZip(zip, entries);
    } catch (error) {
      zip.close();
      throw error;
    }
  }
  async read(name: string, max = 8 * 1024 * 1024): Promise<Buffer> {
    const entry = this.entries.get(name);
    requireCondition(entry, 400, 'missing_entry', 'A referenced archive entry is missing.');
    requireCondition(
      entry.uncompressedSize <= max,
      400,
      'entry_limit',
      'An archive entry exceeds its size limit.',
    );
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      this.zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream!))),
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      requireCondition(
        size <= max,
        400,
        'entry_limit',
        'Expanded archive entry exceeds its size limit.',
      );
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  async json(name: string): Promise<Record<string, unknown>> {
    try {
      const raw = await this.read(name);
      const value = JSON.parse(raw.toString('utf8'));
      requireCondition(
        value && typeof value === 'object' && !Array.isArray(value),
        400,
        'invalid_nsx',
        'NSX metadata must be a JSON object.',
      );
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, 'invalid_nsx', 'An NSX metadata record could not be read.');
    }
  }
  close() {
    this.zip.close();
  }
}
const string = (value: unknown) => (typeof value === 'string' ? value : '');
function timestamp(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export interface NsxAttachment {
  name: string;
  entry: string;
  mime: string;
  size: number;
  missing: boolean;
}
export interface NsxNote {
  id: string;
  title: string;
  html: string;
  text: string;
  original: Buffer;
  metadata: NoteStationMetadata;
  attachments: NsxAttachment[];
  unreadable: boolean;
}
export class NsxArchive {
  private constructor(
    public archive: SafeZip,
    public ids: string[],
    public notebooks: Map<string, { title: string; stack: string }>,
  ) {}
  static async open(file: string) {
    const archive = await SafeZip.open(file);
    try {
      const config = await archive.json('config.json');
      requireCondition(
        Array.isArray(config.note) &&
          Array.isArray(config.notebook) &&
          config.note.length <= 10000 &&
          config.note.every((id) => typeof id === 'string') &&
          config.notebook.every((id) => typeof id === 'string'),
        400,
        'invalid_nsx',
        'Use a Note Station JSON-format NSX export with notes and notebooks.',
      );
      const notebooks = new Map<string, { title: string; stack: string }>();
      for (const id of config.notebook as string[]) {
        const record = await archive.json(id);
        notebooks.set(id, {
          title: string(record.title) || 'Untitled notebook',
          stack: string(record.stack),
        });
      }
      return new NsxArchive(archive, [...new Set(config.note as string[])], notebooks);
    } catch (error) {
      archive.close();
      throw error;
    }
  }
  async note(id: string): Promise<NsxNote> {
    const original = await this.archive.read(id);
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(original.toString('utf8'));
    } catch {
      throw new AppError(400, 'invalid_nsx', 'A note contains invalid JSON.');
    }
    requireCondition(
      record && typeof record === 'object' && !Array.isArray(record),
      400,
      'invalid_nsx',
      'Invalid note metadata.',
    );
    const encrypted = record.encrypt === true || record.encrypt === 1 || record.encrypt === 'true';
    const html = encrypted ? '' : string(record.content);
    const warnings: string[] = [];
    const attachments: NsxAttachment[] = [];
    const records =
      record.attachment &&
      typeof record.attachment === 'object' &&
      !Array.isArray(record.attachment)
        ? (record.attachment as Record<string, unknown>)
        : {};
    for (const value of Object.values(records)) {
      if (!value || typeof value !== 'object') continue;
      const att = value as Record<string, unknown>;
      const digest = string(att.md5);
      const entry = `file_${digest}`;
      const stored = this.archive.entries.get(entry);
      const name = string(att.name) || `attachment.${string(att.ext) || 'bin'}`;
      const extension = string(att.ext).toLowerCase();
      const mime =
        (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            pdf: 'application/pdf',
            txt: 'text/plain',
          } as Record<string, string>
        )[extension] || 'application/octet-stream';
      attachments.push({
        name,
        entry,
        mime,
        size: stored?.uncompressedSize || 0,
        missing: !stored,
      });
      if (!stored) warnings.push(`Missing attachment: ${name}`);
    }
    const $ = cheerio.load(html);
    $('script,style,noscript,iframe,object,embed,svg').remove();
    $('br').replaceWith('\n');
    $('img').each((_i, element) => {
      const alt = $(element).attr('alt');
      $(element).replaceWith(alt ? `[Image: ${alt}]` : '[Image attachment]');
    });
    $('a').each((_i, element) => {
      const href = $(element).attr('href') || '';
      if (/^https?:\/\//i.test(href)) $(element).append(` (${href})`);
    });
    $('p,div,h1,h2,h3,h4,li,pre,tr,section,article,blockquote').each((_i, element) => {
      $(element).append('\n\n');
    });
    const body = $('body')
      .text()
      .replace(/\r\n/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n\s*\n/g, '\n\n')
      .trim();
    if (encrypted) warnings.push('Encrypted note: readable content was not exported.');
    else if (!html.trim()) warnings.push('This note has no exported HTML content.');
    const notebookId = string(record.parent_id);
    const notebook = this.notebooks.get(notebookId);
    const originalTags = Array.isArray(record.tag)
      ? record.tag.filter((tag): tag is string => typeof tag === 'string')
      : [];
    const title = string(record.title) || 'Untitled note';
    const attachmentText = attachments.length
      ? `\n\nAttachments:\n${attachments.map((att) => `- ${att.name}${att.missing ? ' (missing from export)' : ''}`).join('\n')}`
      : '';
    return {
      id,
      title,
      html,
      text: `${body || `[${warnings[0] || 'Empty note'}]`}${attachmentText}`,
      original,
      attachments,
      unreadable: encrypted || !html.trim(),
      metadata: {
        note_id: id,
        notebook_id: notebookId,
        notebook: notebook?.title || 'Unfiled notes',
        stack: notebook?.stack || '',
        created_at: timestamp(record.ctime),
        modified_at: timestamp(record.mtime),
        original_tags: originalTags,
        warnings,
      },
    };
  }
  async preview(): Promise<NsxPreview> {
    const counts = new Map<string, number>();
    let attachments = 0,
      missing = 0,
      unreadable = 0,
      malformed = 0;
    for (const id of this.ids) {
      try {
        const note = await this.note(id);
        counts.set(note.metadata.notebook_id, (counts.get(note.metadata.notebook_id) || 0) + 1);
        attachments += note.attachments.length;
        missing += note.attachments.filter((att) => att.missing).length;
        unreadable += Number(note.unreadable);
      } catch {
        malformed++;
      }
    }
    return {
      notes: this.ids.length,
      attachments,
      missing_attachments: missing,
      unreadable_notes: unreadable + malformed,
      notebooks: [...this.notebooks]
        .map(([id, notebook]) => ({ id, ...notebook, notes: counts.get(id) || 0 }))
        .concat(
          [...counts]
            .filter(([id]) => !this.notebooks.has(id))
            .map(([id, notes]) => ({ id, title: 'Unfiled notes', stack: '', notes })),
        ),
      warnings: [
        missing ? `${missing} attachment reference(s) have no matching file in the export.` : '',
        unreadable
          ? `${unreadable} note(s) have no readable exported content; metadata will still be retained.`
          : '',
        malformed
          ? `${malformed} note(s) contain missing or malformed records and will be reported as skipped.`
          : '',
      ].filter(Boolean),
    };
  }
  close() {
    this.archive.close();
  }
}
