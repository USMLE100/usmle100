/**
 * Uploaded files (Course Book PDFs, student and faculty notes), kept in D1 in pieces under its 2 MB row limit,
 * so no extra storage service is needed. Only the types below are accepted, checked by their contents.
 */
export const CHUNK = 1_900_000;
export const MB = 1024 * 1024;

export type FileMeta = { id: number; owner_id: number | null; name: string; type: string; size: number };

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Types that can be shown in the browser. Anything else is always downloaded. */
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain; charset=utf-8']);

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

/** The real type of an upload, from its first bytes (not from what the browser claims). Null = not allowed. */
export function sniff(b: Uint8Array, name: string, allow: 'pdf' | 'notes'): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (allow === 'pdf') return null;
  if (starts(b, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts(b, [0x50, 0x4b, 0x03, 0x04]) && ext === 'docx') return DOCX;
  if ((ext === 'txt' || ext === 'md') && !b.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b);
      return 'text/plain; charset=utf-8';
    } catch {
      return null;
    }
  }
  return null;
}

export const cleanName = (name: string) =>
  (name.split(/[\\/]/).pop() ?? 'file')
    .replace(/[^\w.\- ()]+/g, '_')
    .slice(0, 120) || 'file';

export async function saveFile(db: D1Database, ownerId: number, name: string, type: string, data: Uint8Array): Promise<number> {
  const r = await db.prepare('INSERT INTO files (owner_id, name, type, size) VALUES (?, ?, ?, ?)').bind(ownerId, cleanName(name), type, data.byteLength).run();
  const id = Number(r.meta.last_row_id);
  try {
    for (let i = 0, idx = 0; i < data.byteLength; i += CHUNK, idx++) {
      await db.prepare('INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)').bind(id, idx, data.subarray(i, i + CHUNK)).run();
    }
  } catch (e) {
    await deleteFile(db, id);
    throw e;
  }
  return id;
}

export async function deleteFile(db: D1Database, id: number | null | undefined) {
  if (!id) return;
  await db.batch([db.prepare('DELETE FROM file_chunks WHERE file_id = ?').bind(id), db.prepare('DELETE FROM files WHERE id = ?').bind(id)]);
}

export const fileMeta = (db: D1Database, id: number) => db.prepare('SELECT id, owner_id, name, type, size FROM files WHERE id = ?').bind(id).first<FileMeta>();

const toBytes = (d: unknown) => (d instanceof ArrayBuffer ? new Uint8Array(d) : d instanceof Uint8Array ? d : new Uint8Array(d as number[]));

/** The file as a download or (for PDFs, images and text) for viewing in the browser. Callers check access first. */
export function fileResponse(db: D1Database, f: FileMeta, mode: 'view' | 'download') {
  const count = Math.ceil(f.size / CHUNK);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i >= count) return ctrl.close();
      const row = await db.prepare('SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?').bind(f.id, i++).first<{ data: unknown }>();
      if (!row) return ctrl.error(new Error('missing file piece'));
      ctrl.enqueue(toBytes(row.data));
    },
  });
  const inline = mode === 'view' && INLINE.has(f.type);
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(body, {
    headers: {
      'Content-Type': f.type,
      'Content-Length': String(f.size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Read an uploaded form file, enforcing a size limit. */
export async function readUpload(v: unknown, maxBytes: number): Promise<{ name: string; data: Uint8Array } | { error: string } | null> {
  if (!v || typeof v === 'string') return null;
  const f = v as File;
  if (!f.size) return null;
  if (f.size > maxBytes) return { error: `That file is ${(f.size / MB).toFixed(1)} MB. The limit is ${Math.round(maxBytes / MB)} MB.` };
  return { name: f.name || 'file', data: new Uint8Array(await f.arrayBuffer()) };
}

export const fmtSize = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
