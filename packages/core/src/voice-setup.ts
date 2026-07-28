import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { sttStatus, type SttUserConfig } from './transcribe';

export const VOICE_PROVIDER_CHOICES = [
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible',
    detail: 'an OpenAI-style /v1 transcription endpoint',
  },
  {
    value: 'elevenlabs',
    label: 'ElevenLabs',
    detail: 'ElevenLabs speech-to-text',
  },
  {
    value: 'deepgram',
    label: 'Deepgram',
    detail: 'Deepgram speech-to-text',
  },
  {
    value: 'custom',
    label: 'Custom HTTP endpoint',
    detail: 'a fully specified transcription URL',
  },
] as const;

type VoiceProvider = (typeof VOICE_PROVIDER_CHOICES)[number]['value'];
type JsonObject = Record<string, unknown>;
type DaemonState = 'managed' | 'external' | 'stopped';
type ApplyResult = { ok: boolean };

export interface VoiceSetupOptions {
  configFile: string;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  daemonState?: DaemonState;
  apply?: () => Promise<ApplyResult> | ApplyResult;
  stdout?: (text: string) => void;
}

type ConfigSnapshot =
  | { exists: false }
  | { exists: true; text: string; mode: number };

class PromptEnded extends Error {
  constructor(readonly reason: 'cancel' | 'eof' | 'unavailable') {
    super(reason);
  }
}

function readConfigDocument(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config root must be a JSON object');
  }
  return parsed as JsonObject;
}

function snapshotConfig(path: string): ConfigSnapshot {
  if (!existsSync(path)) return { exists: false };
  return {
    exists: true,
    text: readFileSync(path, 'utf8'),
    mode: statSync(path).mode & 0o777,
  };
}

export function atomicWriteVoiceConfig(path: string, config: JsonObject): void {
  atomicWriteText(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

function atomicWriteText(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may not have been created, or may already have been renamed.
    }
    throw error;
  }
}

function restoreConfig(path: string, snapshot: ConfigSnapshot): void {
  if (!snapshot.exists) {
    try {
      unlinkSync(path);
    } catch {
      // Already absent.
    }
    return;
  }
  atomicWriteText(path, snapshot.text, snapshot.mode);
}

export type VoiceConfigTransactionResult =
  | { ok: true; stage: 'write' | 'apply' }
  | {
      ok: false;
      stage: 'write' | 'apply' | 'rollback';
      rolledBack: boolean;
      daemonRestored: boolean;
    };

export async function transactVoiceConfig(
  path: string,
  config: JsonObject,
  daemonState: DaemonState,
  apply?: () => Promise<ApplyResult> | ApplyResult,
): Promise<VoiceConfigTransactionResult> {
  const snapshot = snapshotConfig(path);
  try {
    atomicWriteVoiceConfig(path, config);
  } catch {
    return { ok: false, stage: 'write', rolledBack: true, daemonRestored: true };
  }
  if (daemonState !== 'managed') return { ok: true, stage: 'write' };

  let applied: ApplyResult;
  try {
    applied = apply ? await apply() : { ok: false };
  } catch {
    applied = { ok: false };
  }
  if (applied.ok) return { ok: true, stage: 'apply' };

  try {
    restoreConfig(path, snapshot);
  } catch {
    return { ok: false, stage: 'rollback', rolledBack: false, daemonRestored: false };
  }

  let restored: ApplyResult;
  try {
    restored = apply ? await apply() : { ok: false };
  } catch {
    restored = { ok: false };
  }
  return {
    ok: false,
    stage: restored.ok ? 'apply' : 'rollback',
    rolledBack: true,
    daemonRestored: restored.ok,
  };
}

function effectiveStt(file: SttUserConfig, env: NodeJS.ProcessEnv): SttUserConfig {
  const effective = { ...file };
  const fields: Array<[keyof SttUserConfig, string | undefined]> = [
    ['provider', env.OURS_STT_PROVIDER],
    ['apiKey', env.OURS_STT_API_KEY],
    ['model', env.OURS_STT_MODEL],
    ['baseUrl', env.OURS_STT_BASE_URL],
    ['language', env.OURS_STT_LANGUAGE],
  ];
  for (const [field, raw] of fields) {
    if (raw?.trim()) {
      // All environment-driven fields in this list are strings.
      (effective as Record<string, unknown>)[field] = raw.trim();
    }
  }
  return effective;
}

function validateSecret(input: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = input.trim();
  if (value.length < 8) return { ok: false, reason: 'API key must contain at least 8 characters' };
  if (/[\s\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, reason: 'API key must not contain whitespace or control characters' };
  }
  return { ok: true, value };
}

function openPromptTty(): number | null {
  try {
    return openSync('/dev/tty', 'r+');
  } catch {
    // Some PTY hosts do not expose /dev/tty even though stdin/stdout are a real
    // terminal. Re-open stdin read/write in that case. A pipe/headless process
    // never enters this fallback.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      try {
        return openSync('/dev/stdin', 'r+');
      } catch {
        // Fall through to the non-interactive path.
      }
    }
    return null;
  }
}

function ttyWrite(fd: number, text: string): void {
  writeSync(fd, text);
}

function readByte(fd: number): number | null {
  const byte = Buffer.alloc(1);
  try {
    const count = readSync(fd, byte, 0, 1, null);
    return count === 1 ? byte[0] : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EINTR') throw new PromptEnded('cancel');
    throw error;
  }
}

function readEscapeSequence(fd: number): string {
  let sequence = '';
  for (let i = 0; i < 12; i++) {
    const byte = readByte(fd);
    if (byte === null) break;
    const char = String.fromCharCode(byte);
    sequence += char;
    if (/[A-Za-z~]$/.test(sequence)) break;
  }
  return sequence;
}

function withRawTerminal<T>(fd: number, fn: () => T): T {
  const saved = spawnSync('stty', ['-g'], {
    stdio: [fd, 'pipe', 'ignore'],
    encoding: 'utf8',
  });
  const savedMode = (saved.stdout || '').trim();
  if (saved.status !== 0 || !savedMode) throw new PromptEnded('unavailable');
  const raw = spawnSync('stty', ['-icanon', '-echo', '-isig', 'min', '1', 'time', '0'], {
    stdio: [fd, 'ignore', 'ignore'],
  });
  if (raw.status !== 0) throw new PromptEnded('unavailable');

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    const result = spawnSync('stty', [savedMode], { stdio: [fd, 'ignore', 'ignore'] });
    if (result.status !== 0) {
      spawnSync('stty', ['sane'], { stdio: [fd, 'ignore', 'ignore'] });
    }
  };
  process.once('exit', restore);
  try {
    return fn();
  } finally {
    process.removeListener('exit', restore);
    restore();
  }
}

function readRawLine(fd: number, prompt: string, def: string, hidden: boolean): string {
  return withRawTerminal(fd, () => {
    // Raw/no-echo is active before the prompt becomes visible, closing the fast-paste
    // window that could otherwise echo the first bytes of a credential.
    ttyWrite(fd, prompt);
    let value = '';
    for (;;) {
      const byte = readByte(fd);
      if (byte === null || byte === 0x04) throw new PromptEnded('eof');
      if (byte === 0x03) throw new PromptEnded('cancel');
      if (byte === 0x0a || byte === 0x0d) {
        ttyWrite(fd, '\n');
        break;
      }
      if (byte === 0x7f || byte === 0x08) {
        if (value.length) {
          value = value.slice(0, -1);
          if (!hidden) ttyWrite(fd, '\b \b');
        }
        continue;
      }
      if (byte === 0x1b) {
        // Ignore terminal control sequences, including bracketed-paste wrappers.
        // The pasted payload arrives as ordinary bytes and is still accepted.
        readEscapeSequence(fd);
        continue;
      }
      if (byte < 0x20) continue;
      if (value.length >= 16_384) continue;
      const char = String.fromCharCode(byte);
      value += char;
      if (!hidden) ttyWrite(fd, char);
    }
    const answer = value.trim();
    return answer === '' ? def : answer;
  });
}

function readCookedLine(fd: number, prompt: string, def = ''): string {
  ttyWrite(fd, prompt);
  const chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    const chunk = Buffer.alloc(1024);
    let count: number;
    try {
      count = readSync(fd, chunk, 0, chunk.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') throw new PromptEnded('cancel');
      throw error;
    }
    if (count === 0) throw new PromptEnded('eof');
    const end = chunk.subarray(0, count).indexOf(0x0a);
    const used = end >= 0 ? chunk.subarray(0, end) : chunk.subarray(0, count);
    chunks.push(used);
    length += used.length;
    if (length > 16_384) throw new Error('prompt input too long');
    if (end >= 0) break;
  }
  const answer = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '').trim();
  return answer === '' ? def : answer;
}

function askLine(fd: number, prompt: string, def = '', hidden = false): string {
  try {
    return readRawLine(fd, prompt, def, hidden);
  } catch (error) {
    if (error instanceof PromptEnded && error.reason === 'unavailable' && !hidden) {
      return readCookedLine(fd, prompt, def);
    }
    throw error;
  }
}

function askYesNo(fd: number, prompt: string, def: boolean): boolean {
  const answer = askLine(fd, `${prompt} ${def ? '[Y/n]' : '[y/N]'} `, def ? 'y' : 'n');
  return /^y(?:es)?$/i.test(answer);
}

function selectProvider(fd: number, current: string): VoiceProvider {
  let cursor = VOICE_PROVIDER_CHOICES.findIndex((choice) => choice.value === current);
  if (cursor < 0) cursor = 0;
  try {
    return withRawTerminal(fd, () => {
    ttyWrite(fd, 'Choose one transcription provider (↑/↓ or j/k, then Enter; q cancels):\n');
    let drawn = false;
    const redraw = () => {
      if (drawn) ttyWrite(fd, `\x1b[${VOICE_PROVIDER_CHOICES.length}A`);
      drawn = true;
      VOICE_PROVIDER_CHOICES.forEach((choice, index) => {
        const radio = index === cursor ? '(*)' : '( )';
        const pointer = index === cursor ? '>' : ' ';
        ttyWrite(fd, `\r\x1b[K  ${pointer} ${radio} ${choice.label} — ${choice.detail}\n`);
      });
    };
    redraw();
    for (;;) {
      const byte = readByte(fd);
      if (byte === null || byte === 0x04) throw new PromptEnded('eof');
      if (byte === 0x03 || byte === 0x71 || byte === 0x51) throw new PromptEnded('cancel');
      if (byte === 0x0a || byte === 0x0d) {
        ttyWrite(fd, '\n');
        return VOICE_PROVIDER_CHOICES[cursor].value;
      }
      if (byte >= 0x31 && byte <= 0x34) {
        cursor = byte - 0x31;
      } else if (byte === 0x6b || byte === 0x4b) {
        cursor = (cursor - 1 + VOICE_PROVIDER_CHOICES.length) % VOICE_PROVIDER_CHOICES.length;
      } else if (byte === 0x6a || byte === 0x4a) {
        cursor = (cursor + 1) % VOICE_PROVIDER_CHOICES.length;
      } else if (byte === 0x1b) {
        const sequence = readEscapeSequence(fd);
        if (sequence === '[A' || sequence === 'OA') {
          cursor = (cursor - 1 + VOICE_PROVIDER_CHOICES.length) % VOICE_PROVIDER_CHOICES.length;
        } else if (sequence === '[B' || sequence === 'OB') {
          cursor = (cursor + 1) % VOICE_PROVIDER_CHOICES.length;
        }
      } else {
        continue;
      }
      redraw();
    }
    });
  } catch (error) {
    if (!(error instanceof PromptEnded) || error.reason !== 'unavailable') throw error;
    ttyWrite(fd, 'Choose one transcription provider:\n');
    VOICE_PROVIDER_CHOICES.forEach((choice, index) => {
      ttyWrite(fd, `  ${index + 1}. ${choice.label} — ${choice.detail}\n`);
    });
    const selected = readCookedLine(fd, `Select 1-${VOICE_PROVIDER_CHOICES.length}: `);
    if (!/^[1-4]$/.test(selected)) throw new PromptEnded('cancel');
    return VOICE_PROVIDER_CHOICES[Number(selected) - 1].value;
  }
}

function fileStt(config: JsonObject): SttUserConfig {
  const value = config.stt;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as SttUserConfig) }
    : {};
}

export async function runVoiceSetup(options: VoiceSetupOptions): Promise<number> {
  const env = options.env ?? process.env;
  const output = options.stdout ?? ((text: string) => process.stdout.write(text));
  const line = (text = '') => output(`${text}\n`);
  const daemonState = options.daemonState ?? 'stopped';
  let ttyFd: number | null = null;

  try {
    let document: JsonObject;
    try {
      document = readConfigDocument(options.configFile);
    } catch {
      line(`voice setup: ${options.configFile} is not valid JSON; no changes made.`);
      return 1;
    }

    const fromFile = fileStt(document);
    const beforeStatus = sttStatus(effectiveStt(fromFile, env));
    const keySource = env.OURS_STT_API_KEY?.trim()
      ? 'environment'
      : fromFile.apiKey?.trim()
        ? 'config'
        : 'missing';

    ttyFd = env.OURS_ASSUME_YES ? null : openPromptTty();
    line(`ours-mcp voice-setup — ${options.configFile}`);
    if (beforeStatus.ready) {
      line(`voice transcription is already ready (${beforeStatus.provider}; API key from ${keySource}).`);
      if (ttyFd === null) return 0;
      if (!askYesNo(ttyFd, 'Change the current voice settings?', false)) {
        line('kept the current voice settings; no changes made.');
        return 0;
      }
    } else {
      line('Voice transcription is not ready. This command keeps the provider key hidden.');
      if (ttyFd === null) {
        line('No interactive terminal is available; no changes made.');
        line('Run `ours-mcp voice-setup` in a terminal, or configure OURS_STT_* environment values.');
        return 0;
      }
    }

    line('');
    const currentProvider = String(env.OURS_STT_PROVIDER || fromFile.provider || '').trim().toLowerCase();
    const provider = selectProvider(ttyFd, currentProvider);
    let model = String(env.OURS_STT_MODEL || fromFile.model || '').trim();
    let baseUrl = String(env.OURS_STT_BASE_URL || fromFile.baseUrl || '').trim();
    let customUrl = String(fromFile.custom?.url || '').trim();

    if (provider === 'openai-compatible') {
      baseUrl = askLine(ttyFd, `Provider /v1 base URL${baseUrl ? ` [${baseUrl}]` : ''}: `, baseUrl);
      model = askLine(ttyFd, `Model name (sent verbatim)${model ? ` [${model}]` : ''}: `, model);
    } else if (provider === 'elevenlabs') {
      model = askLine(ttyFd, `ElevenLabs model id${model ? ` [${model}]` : ''}: `, model);
      baseUrl = askLine(ttyFd, `Custom base URL (Enter for provider default)${baseUrl ? ` [${baseUrl}]` : ''}: `, baseUrl);
    } else if (provider === 'deepgram') {
      model = askLine(ttyFd, `Model (optional; Enter for provider default)${model ? ` [${model}]` : ''}: `, model);
      baseUrl = askLine(ttyFd, `Custom base URL (optional)${baseUrl ? ` [${baseUrl}]` : ''}: `, baseUrl);
    } else {
      customUrl = askLine(ttyFd, `Full transcription endpoint URL${customUrl ? ` [${customUrl}]` : ''}: `, customUrl);
      model = askLine(ttyFd, `Model (optional unless URL contains {model})${model ? ` [${model}]` : ''}: `, model);
    }

    const envKey = env.OURS_STT_API_KEY?.trim();
    let apiKey = String(fromFile.apiKey || '').trim();
    if (!envKey) {
      const prompt = apiKey
        ? 'Provider API key [configured; Enter keeps it]: '
        : 'Provider API key (input hidden): ';
      let entered: string;
      try {
        entered = askLine(ttyFd, prompt, apiKey, true);
      } catch (error) {
        if (!(error instanceof PromptEnded) || error.reason !== 'unavailable') throw error;
        ttyWrite(ttyFd, '\nSecure hidden input is unavailable on this terminal.\n');
        ttyWrite(ttyFd, 'Visible fallback will echo the token on screen and may leave it in scrollback.\n');
        const consent = readCookedLine(ttyFd, 'Type SHOW to enter the token visibly, or press Enter to cancel: ');
        if (consent !== 'SHOW') throw new PromptEnded('cancel');
        entered = readCookedLine(ttyFd, 'Provider API key (VISIBLE): ', apiKey);
      }
      const validated = validateSecret(entered);
      if (!validated.ok) {
        line(`Voice setup was not saved: ${validated.reason}.`);
        return 1;
      }
      apiKey = validated.value;
    } else {
      line('API key: using OURS_STT_API_KEY from the environment; it will not be copied to config.');
    }

    const nextStt: SttUserConfig = {
      ...fromFile,
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(provider === 'custom' && customUrl
        ? { custom: { ...(fromFile.custom ?? {}), url: customUrl } }
        : {}),
    };
    const intended = sttStatus(effectiveStt(nextStt, env));
    if (!intended.ready) {
      line(`Voice setup was not saved: ${intended.reason}.`);
      return 1;
    }

    if (options.dryRun) {
      line(`voice transcription would be configured (${provider}); API key stays hidden.`);
      line('dry-run: config, daemon, and existing settings were not changed.');
      return 0;
    }

    const nextDocument = { ...document, stt: nextStt };
    if (daemonState === 'managed') {
      line('Restarting ours-mcp to apply and verify voice transcription…');
    }
    const transaction = await transactVoiceConfig(
      options.configFile,
      nextDocument,
      daemonState,
      options.apply,
    );
    if (!transaction.ok && transaction.stage === 'write') {
      line(`Could not write ${options.configFile}; the prior config is intact.`);
      return 1;
    }

    if (daemonState === 'stopped') {
      line(`voice transcription configured (${provider}); API key saved in mode-0600 config.`);
      line('The daemon is stopped; run `ours-mcp start` to apply it.');
      return 0;
    }
    if (daemonState === 'external') {
      line(`voice transcription configured (${provider}); API key saved in mode-0600 config.`);
      line('The daemon has no managed PID; restart its external launcher to apply the new settings.');
      return 0;
    }

    if (transaction.ok) {
      line(`voice transcription: ready (${provider}).`);
      line('API key saved in mode-0600 config and never displayed.');
      return 0;
    }

    if (!transaction.rolledBack) {
      line('Voice setup failed and automatic config rollback also failed; inspect the config before restarting.');
      return 2;
    }
    line('Voice readiness check failed; restored the exact prior config.');
    if (!transaction.daemonRestored) {
      line('The prior config is restored, but the daemon did not restart; run `ours-mcp status`.');
      return 2;
    }
    line('The prior config and daemon state were restored; voice setup was not changed.');
    return 2;
  } catch (error) {
    if (error instanceof PromptEnded) {
      if (error.reason === 'cancel') {
        line('');
        line('voice setup cancelled; no configuration changes were made.');
        return 130;
      }
      if (error.reason === 'eof') {
        line('');
        line('voice setup ended at EOF; no configuration changes were made.');
        return 1;
      }
      line('Secure interactive input is unavailable on this terminal; no changes made.');
      return 1;
    }
    line('voice setup failed unexpectedly; no credential was displayed.');
    return 1;
  } finally {
    if (ttyFd !== null) {
      try {
        closeSync(ttyFd);
      } catch {
        // Already closed.
      }
    }
  }
}

export const VOICE_SETUP_HELP = `ours-mcp voice-setup — configure voice transcription securely

Usage: ours-mcp voice-setup [--dry-run]

Interactively choose exactly one provider, collect provider-specific fields, and
read the provider API key with hidden input. The key is never accepted as a CLI
argument. Configuration is written atomically with mode 0600. When the managed
daemon is running, it is restarted and readiness-checked; a failure restores the
exact prior config.

  --dry-run  walk the prompts without writing config or restarting the daemon
  --help     show this help and exit

Headless automation remains environment-driven through OURS_STT_PROVIDER,
OURS_STT_API_KEY, OURS_STT_MODEL, OURS_STT_BASE_URL, and OURS_STT_LANGUAGE.
Exit 2 means restart/readiness failed after a write and rollback was attempted.`;
