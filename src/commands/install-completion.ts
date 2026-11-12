// install-completion verb: wire `hub` shell completion the standard way —
// bash: drop the script into bash-completion's lazy-load dir so it is sourced
// automatically on first `hub <TAB>` (no rc edit). zsh: drop it under
// ~/.hub/completion and tell the user the one source line to add (zsh's fpath
// autoload expects a `#compdef`-style file, which the generated script is not).
// The verb copies a shipped artifact; it never edits rc files or runs SQL.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { CompletionInstallStatus } from '../core/types.ts';

/** Resolve the generated completion script shipped inside the package. */
function sourceScriptPath(): string {
  return join(import.meta.dirname, '..', '..', 'completion', 'hub-completion.sh');
}

/** Resolve the bash target: bash-completion's per-user lazy-load directory. */
function bashTargetPath(): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(dataHome, 'bash-completion', 'completions', 'hub');
}

/** Resolve the zsh target: a neutral copy under ~/.hub (never fpath). */
function zshTargetPath(): string {
  return join(homedir(), '.hub', 'completion', 'hub-completion.sh');
}

/**
 * Resolve where the script goes for a shell, with an explicit --dest override
 * (tests and unusual setups point the copy somewhere specific). A --dest with
 * no --shell is inferred: a `_hub` filename means zsh, anything else bash.
 * @param shellFlag - The `--shell` value, if provided.
 * @param destFlag - The `--dest` value, if provided.
 * @returns Target file path and the effective shell for messaging/status.
 */
function resolveTarget(shellFlag: string | undefined, destFlag: string | undefined): { path: string; shell: string } {
  if (shellFlag !== undefined && shellFlag !== 'bash' && shellFlag !== 'zsh') {
    throw new Error(`install-completion: unknown shell "${shellFlag}" (expected bash or zsh)`);
  }
  if (destFlag) {
    const destination = isAbsolute(destFlag) ? destFlag : join(homedir(), destFlag);
    const shell = shellFlag ?? (destination.endsWith('/_hub') ? 'zsh' : 'bash');
    return { path: destination, shell };
  }
  if (shellFlag === 'zsh') return { path: zshTargetPath(), shell: 'zsh' };
  return { path: bashTargetPath(), shell: 'bash' };
}

/**
 * `hub install-completion`: copy the generated completion script into the
 * standard location for the target shell and print what to do next. bash
 * needs no further wiring (bash-completion lazy-loads the file); zsh needs
 * one `source` line in ~/.zshrc (printed, not written). Idempotent — an
 * existing file at the target is overwritten.
 * @param values - Parsed CLI flags (shell, dest, json, db).
 * @returns Process exit code (0 on success; failures throw to top level).
 */
export async function cmdInstallCompletion(values: {
  shell?: string;
  dest?: string;
  json?: boolean;
  db?: string;
}): Promise<number> {
  const source = sourceScriptPath();
  const { path: target, shell } = resolveTarget(values.shell, values.dest);
  const script = readFileSync(source, 'utf8');
  if (!script.includes('complete -F _hub_completion hub')) {
    throw new Error(`install-completion: ${source} does not look like a generated hub completion script`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);

  // zsh wiring is manual by design: the script must be sourced AFTER compinit,
  // and only the user knows where that happens in their ~/.zshrc.
  const note =
    shell === 'zsh'
      ? 'add `source ~/.hub/completion/hub-completion.sh` to ~/.zshrc after compinit, then re-source or exec a new shell'
      : 'sourced automatically on first `hub <TAB>` by bash-completion';

  const status: CompletionInstallStatus = {
    verb: 'install-completion',
    shell,
    source,
    destination: target,
    note,
    ok: true,
  };
  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(`hub install-completion: ${shell} completion installed at ${target} — ${note}`);
  }
  return 0;
}
