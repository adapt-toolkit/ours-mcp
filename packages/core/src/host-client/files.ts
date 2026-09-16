import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildIdentityFile, writeIdentityFile } from '@ours.network/sdk/connector';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type HostFileClient = {
  uploadFile(
    body: ReadableStream<Uint8Array>,
    metadata: { filename: string; mime?: string; size: number },
  ): Promise<{ upload_id: string }>;
  openFile(wireId: string): Promise<ReadableStream<Uint8Array>>;
};

type JsonRpcFrame = Record<string, unknown>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'operation cancelled'));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function toolCall(frame: JsonRpcFrame): { name?: string; arguments?: Record<string, unknown> } | null {
  if (frame.method !== 'tools/call' || !frame.params || typeof frame.params !== 'object') return null;
  return frame.params as { name?: string; arguments?: Record<string, unknown> };
}

/** Replace a host `send_file.path` with an authenticated staged upload. */
export async function prepareHostFileCall(
  client: HostFileClient,
  frame: JsonRpcFrame,
  signal?: AbortSignal,
): Promise<JsonRpcFrame> {
  throwIfAborted(signal);
  const params = toolCall(frame);
  if (params?.name !== 'send_file' || typeof params.arguments?.path !== 'string') return frame;
  const args = params.arguments;
  const inputPath = args.path as string;
  if (args.upload_id !== undefined || args.data_base64 !== undefined) {
    throw new Error('send_file accepts exactly one host file input.');
  }
  const path = resolve(inputPath);
  const size = statSync(path).size;
  const filename = typeof args.filename === 'string' && args.filename ? args.filename : basename(path);
  const mime = typeof args.mime === 'string' ? args.mime : undefined;
  const file = createReadStream(path);
  const stop = () => file.destroy(abortError(signal!));
  signal?.addEventListener('abort', stop, { once: true });
  let staged: { upload_id: string };
  try {
    const stream = Readable.toWeb(file) as ReadableStream<Uint8Array>;
    staged = await client.uploadFile(stream, { filename, mime, size });
    throwIfAborted(signal);
  } finally {
    signal?.removeEventListener('abort', stop);
    if (signal?.aborted) file.destroy();
  }
  const nextArguments: Record<string, unknown> = { ...args, upload_id: staged.upload_id, filename };
  delete nextArguments.path;
  return { ...frame, params: { ...(frame.params as Record<string, unknown>), arguments: nextArguments } };
}

/** Consume a server save intent and replace it with the final host write result. */
export async function completeHostFileCall(
  client: HostFileClient,
  request: JsonRpcFrame,
  response: JsonRpcFrame,
  signal?: AbortSignal,
): Promise<JsonRpcFrame> {
  throwIfAborted(signal);
  const params = toolCall(request);
  if (params?.name === 'define_local_identity_file') {
    const result = response.result as Record<string, unknown> | undefined;
    if (result?.isError === true) return response;
    const args = params.arguments ?? {};
    const expected = {
      name: args.name, path: args.path, force: args.force ?? false,
      expose_local: args.expose_local ?? true, local_auto_accept: args.local_auto_accept ?? true,
      overwrite: args.overwrite ?? false,
    };
    const structured = result?.structuredContent as Record<string, unknown> | undefined;
    if (!isDeepStrictEqual(structured?.oursHostIdentityFile, expected) ||
        typeof expected.name !== 'string' || typeof expected.path !== 'string' ||
        !isAbsolute(expected.path) ||
        [expected.force, expected.expose_local, expected.local_auto_accept, expected.overwrite]
          .some(value => typeof value !== 'boolean')) {
      throw new Error('define_local_identity_file returned an invalid or mismatched host intent.');
    }
    try {
      const options = {
        name: expected.name, force: expected.force as boolean,
        exposeLocal: expected.expose_local as boolean, localAutoAccept: expected.local_auto_accept as boolean,
      };
      const written = writeIdentityFile(expected.path, options, expected.overwrite as boolean);
      return { ...response, result: {
        content: [{ type: 'text', text: `Wrote ${written}:\n${JSON.stringify(buildIdentityFile(options), null, 2)}` }],
        isError: false,
      } };
    } catch (error) {
      return { ...response, result: {
        content: [{ type: 'text', text: `define_local_identity_file failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      } };
    }
  }
  if (params?.name !== 'save_file') return response;
  const result = response.result as Record<string, unknown> | undefined;
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  const intent = structured?.oursHostSave as { wire_id?: unknown; dest_path?: unknown } | undefined;
  if (result?.isError === true || !intent) return response;
  const requestedWireId = params.arguments?.wire_id;
  const requestedDestination = params.arguments?.dest_path;
  if (intent.wire_id !== requestedWireId || intent.dest_path !== requestedDestination ||
      typeof intent.wire_id !== 'string' || typeof intent.dest_path !== 'string') {
    throw new Error('save_file returned a host intent that does not match the request.');
  }
  try {
    const bodyPromise = client.openFile(intent.wire_id);
    const body = signal ? await new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
      let stopped = false;
      const stop = () => { stopped = true; reject(abortError(signal)); };
      signal.addEventListener('abort', stop, { once: true });
      bodyPromise.then((value) => {
        signal.removeEventListener('abort', stop);
        if (stopped) void value.cancel().catch(() => {});
        else resolve(value);
      }, (error) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      });
    }) : await bodyPromise;
    throwIfAborted(signal);
    const path = resolve(intent.dest_path);
    mkdirSync(dirname(path), { recursive: true });
    const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
    const destination = createWriteStream(path);
    if (signal) await pipeline(source, destination, { signal });
    else await pipeline(source, destination);
    throwIfAborted(signal);
    const size = statSync(path).size;
    return {
      ...response,
      result: {
        content: [{
          type: 'text',
          text: `Saved file (wire_id ${intent.wire_id}) to ${path} (${size} bytes). The bytes were streamed daemon→disk and never entered this result.`,
        }],
        isError: false,
      },
    };
  } catch (error) {
    throwIfAborted(signal);
    return {
      ...response,
      result: {
        content: [{ type: 'text', text: `save_file failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      },
    };
  }
}
