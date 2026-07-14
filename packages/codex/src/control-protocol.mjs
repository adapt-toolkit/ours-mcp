const COMMANDS = new Set(['register_session', 'binding_changed', 'arm', 'disarm', 'status']);
const MAX_LINE = 64 * 1024;
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function decodeControlLine(line, expectedCapability) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE) throw new Error('control message too large');
  let value;
  try { value = JSON.parse(line); } catch { throw new Error('control message is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('control message must be a plain object');
  if (!nonEmpty(value.capability) || value.capability !== expectedCapability) throw new Error('invalid control capability');
  if (!COMMANDS.has(value.command)) throw new Error(`unknown command: ${String(value.command)}`);
  if (value.command === 'register_session') {
    for (const field of ['sessionId', 'threadId', 'cwd']) if (!nonEmpty(value[field])) throw new Error(`${field} must be a non-empty string`);
  }
  if ((value.command === 'binding_changed' || value.command === 'arm') && !nonEmpty(value.identity)) throw new Error('identity must be a non-empty string');
  return value;
}

export function encodeControlResponse(value) {
  return `${JSON.stringify(value)}\n`;
}
