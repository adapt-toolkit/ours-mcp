import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errFileUnreadable } from '@ours.network/sdk';
import { canRead } from './format.js';
import type { ToolRequestExtra } from './tool.js';

/** All path resolution, probing and I/O happens in the caller's OS context. */
export interface FileExecutionContext {
  read(path: string, extra: ToolRequestExtra): Promise<{
    filename: string; size: number; body: ReadableStream<Uint8Array>; close(): void | Promise<void>;
  }>;
  write(path: string, body: ReadableStream<Uint8Array>, extra: ToolRequestExtra): Promise<{ path: string; size: number }>;
  canRead(path: string, extra: ToolRequestExtra): Promise<boolean>;
}

/** Standalone only. Managed callers must supply their sandbox callback context. */
export const localFileContext: FileExecutionContext = {
  async read(path, extra) {
    const abs = resolve(path);
    let size: number;
    try { size = statSync(abs).size; } catch (error) { throw errFileUnreadable(String(error)); }
    const source = createReadStream(abs, { signal: extra.signal });
    return { filename: basename(abs), size, body: Readable.toWeb(source) as ReadableStream<Uint8Array>, close: () => { source.destroy(); } };
  },
  async write(path, body, extra) {
    const abs = resolve(path);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(abs), { signal: extra.signal });
      return { path: abs, size: statSync(abs).size };
    } catch (error) {
      if (!body.locked) await body.cancel().catch(() => {});
      throw error;
    }
  },
  async canRead(path) { return canRead(path); },
};
