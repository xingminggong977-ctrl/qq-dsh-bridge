import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Hard cap on a single downloaded image; larger ones are dropped (node caps at 4 MiB anyway). */
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

const MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
]);

function guessMime(name) {
  const ext = path.extname(String(name ?? '').split('?')[0]).toLowerCase();
  return MIME_BY_EXT.get(ext) ?? null;
}

function cleanMime(value) {
  if (typeof value !== 'string') return null;
  const base = value.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : null;
}

export class BlobStore {
  constructor({ db, dir, log, now = () => Date.now() }) {
    this.db = db;
    this.dir = dir;
    this.log = log;
    this.now = now;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Persist bytes and return the blob metadata that goes into a Task. */
  save(buffer, mime) {
    const blobId = crypto.randomUUID();
    const fileName = blobId;
    fs.writeFileSync(path.join(this.dir, fileName), buffer);
    this.db
      .prepare('INSERT INTO blobs (blob_id, mime, bytes, file_name, created_at) VALUES (?,?,?,?,?)')
      .run(blobId, mime, buffer.byteLength, fileName, this.now());
    return { blobId, mime, bytes: buffer.byteLength };
  }

  find(blobId) {
    const row = this.db.prepare('SELECT * FROM blobs WHERE blob_id = ?').get(blobId);
    if (!row) return null;
    const filePath = path.join(this.dir, row.file_name);
    if (!fs.existsSync(filePath)) return null;
    return { blobId: row.blob_id, mime: row.mime, bytes: Number(row.bytes), path: filePath };
  }

  /**
   * OneBot image segment -> stored blob. Returns null when the segment carries
   * nothing the bridge can fetch (the message is still enqueued without that image).
   */
  async download(segment) {
    // Accepts a raw OneBot segment ({data:{url,file}}) or the flat {url,file,mime} form.
    const data = segment?.data ?? segment ?? {};
    const candidates = [data.url, data.file].filter((value) => typeof value === 'string' && value.length > 0);
    for (const candidate of candidates) {
      try {
        const loaded = await this.load(candidate);
        if (!loaded) continue;
        if (loaded.bytes > MAX_BLOB_BYTES) {
          this.log.warn('blob skipped: too large', { bytes: loaded.bytes, limit: MAX_BLOB_BYTES });
          return null;
        }
        return this.save(loaded.buffer, cleanMime(data.mime) ?? guessMime(candidate) ?? loaded.mime ?? 'application/octet-stream');
      } catch (error) {
        this.log.warn('blob download failed', { reason: error.message });
      }
    }
    return null;
  }

  async load(source) {
    if (source.startsWith('base64://')) {
      const buffer = Buffer.from(source.slice('base64://'.length), 'base64');
      return { buffer, bytes: buffer.byteLength, mime: null };
    }
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, bytes: buffer.byteLength, mime: cleanMime(response.headers.get('content-type')) };
    }
    if (source.startsWith('file://')) {
      const buffer = fs.readFileSync(new URL(source));
      return { buffer, bytes: buffer.byteLength, mime: null };
    }
    // NapCat sometimes hands out a bare local path (bridge and NapCat share the host).
    if (path.isAbsolute(source) && fs.existsSync(source)) {
      const buffer = fs.readFileSync(source);
      return { buffer, bytes: buffer.byteLength, mime: null };
    }
    return null;
  }
}

export function createBlobStore(options) {
  return new BlobStore(options);
}
