// Linux keeps an exited process in /proc until its parent reaps it. kill(pid, 0)
// still succeeds for that zombie, so daemon-stop polling must also inspect the
// single-letter state in /proc/<pid>/stat. The command name is parenthesized and
// may itself contain spaces or parentheses; the state is the first field after
// the final ")" delimiter.
export function linuxProcState(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trimStart();
  return /^[A-Za-z](?:\s|$)/.test(rest) ? rest[0] : null;
}

export function linuxProcHasExited(stat: string): boolean {
  const state = linuxProcState(stat);
  return state === 'Z' || state === 'X' || state === 'x';
}
