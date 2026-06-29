// packages/core/src/files.ts
import { basename, extname } from 'node:path';

const FILE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

export function mimeFromExt(p: string): string {
  return FILE_MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
}

export function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  return base.length ? base.slice(0, 200) : 'file';
}
