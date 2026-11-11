// Trello engine adapter (S11): the only module that touches the trello-cli
// process (the sync-engine decision — mheap/trello-cli is the sync engine, DECISIONS #13
// rules the one-way direction). Everything above this layer (the sync-trello
// planner) plans actions; everything below is spawn + parse. The interface
// exists so a future engine (or a test double built into the CLI itself)
// can replace the subprocess without touching the plan/apply code.
//
// Contract notes verified live against trello-cli 2.0.0 (2026-11-10):
// - creds come from TRELLO_API_KEY/TRELLO_TOKEN env, checked BEFORE the
//   on-disk config — the hub inherits env and never reads credentials;
// - card:create / card:list resolve --board/--list through the local cache
//   (populated by `trello sync`), matching name OR id;
// - card:update / card:move (--id X --to LIST_ID) / card:archive take a raw
//   --card-id with no cache dependency;
// - every command accepts --format json (write commands are silent by
//   default, so parse stdout of the JSON form).
import { spawn } from 'node:child_process';
import { ENGINE_DEFAULT_PATH } from '../../core/constants.ts';
import type { TrelloConfig } from '../../core/config.ts';

/** One live card as `trello card:list --format json` reports it (ticket shape). */
export interface TrelloCard {
  id: string;
  name: string;
  description: string;
  due: string | null;
  closed: boolean;
  url: string;
  labels: string[];
}

/**
 * The engine surface the sync flow drives. Every method may throw:
 * ENOENT maps to the friendly install hint, non-zero exits carry the
 * engine's own stderr tail for debugging.
 */
export interface TrelloEngine {
  /** Warm the engine's name→id cache (trello sync). */
  syncCache(): Promise<void>;
  /** All cards currently on the board's given list (not-archived view as Trello serves it). */
  listCards(listRef: string): Promise<TrelloCard[]>;
  /** Create a card; returns the created card (id is what the caller stores). */
  createCard(input: {
    listRef: string;
    name: string;
    description?: string | null;
    due?: string | null;
  }): Promise<TrelloCard>;
  /** Patch a card's title/description/due by raw card id (no cache needed). */
  updateCard(cardId: string, patch: { name?: string; description?: string | null; due?: string | null }): Promise<void>;
  /** Move a card to a list by raw card id + list ref. */
  moveCard(cardId: string, listRef: string): Promise<void>;
  /** Archive (close) a card by raw card id. */
  archiveCard(cardId: string): Promise<TrelloCard>;
}

/**
 * Spawn one trello-cli command and collect its stdout. Errors follow the
 * adapter contract: ENOENT → the friendly install hint (the ticket-mandated
 * message); non-zero exit → Error carrying the engine's stderr tail (oclif
 * prints usage problems there, and API errors to stderr too).
 * @param enginePath - The command to spawn (config's enginePath).
 * @param args - Command + flags (e.g. ["card:list", "--format", "json"]).
 * @returns The process's stdout text ("" when the engine wrote nothing).
 */
async function runEngine(enginePath: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolveRun, reject) => {
    const child = spawn(enginePath, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            `hub: trello engine "${enginePath}" not found — install trello-cli (npm install -g trello-cli) or set --engine-path in hub trello-config`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout);
      else
        reject(
          new Error(
            `hub: trello engine "${enginePath}" ${args[0]} exited ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`,
          ),
        );
    });
  });
}

/**
 * Parse one engine JSON stdout payload. `--format json` may be followed by
 * oclif's ` ›` warning lines on stderr — stdout itself is expected to be a
 * single JSON value. A parse failure throws with the head of the payload so
 * a trello-cli version drift (shape change) is diagnosable, not silent.
 * @param stdout - Raw engine stdout.
 * @param context - What was being parsed (for the error message).
 * @returns The parsed JSON value.
 */
function parseEngineJson(stdout: string, context: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `hub: trello engine returned non-JSON output for ${context}: ${stdout.trim().slice(0, 120) || '(empty)'}`,
    );
  }
}

/**
 * Format an ISO calendar date (YYYY-MM-DD) for the engine's --due flag.
 * trello-cli 2.0.0 feeds --due through chrono; the exact-UTC-midnight ISO
 * string parses deterministically and Trello stores the timestamp as given
 * (calendar-date drift stays 0 because the hub's contract for due_date is
 * UTC-anchored YYYY-MM-DD — see parseIsoDate).
 * @param iso - Calendar date, or null/undefined for no due.
 * @returns The engine argument value, or undefined when unset.
 */
function dueArg(iso: string | null | undefined): string | undefined {
  return iso ? `${iso}T12:00:00.000Z` : undefined;
}

/**
 * The spawn-based engine over trello-cli (the ticket's single shipped
 * implementation). All spawns inherit `process.env` — the credentials ride
 * TRELLO_API_KEY/TRELLO_TOKEN and are never read, stored, or logged here.
 * Flags go through argv (never a shell), so card titles cannot inject.
 */
export class TrelloCliEngine implements TrelloEngine {
  private readonly enginePath: string;
  private readonly boardRef: string;

  /**
   * @param config - The configured trello block: enginePath + board (every
   *   board-scoped command needs the board alongside --list; trello-cli
   *   validates the pair). List refs arrive per-call so the caller stays the
   *   single place that interprets the status→list mapping.
   */
  constructor(config: TrelloConfig) {
    this.enginePath = config.enginePath || ENGINE_DEFAULT_PATH;
    this.boardRef = config.board;
  }

  /** @inheritdoc Warm the engine's name→id cache (trello sync). */
  async syncCache(): Promise<void> {
    await runEngine(this.enginePath, ['sync', '--format', 'json']);
  }

  /** @inheritdoc List the cards on one list (trello card:list --format json). */
  async listCards(listRef: string): Promise<TrelloCard[]> {
    const raw = parseEngineJson(
      // `--list` requires `--board` in the same invocation (trello-cli
      // validates the pair), so the configured board rides along.
      await runEngine(this.enginePath, ['card:list', '--board', this.boardRef, '--list', listRef, '--format', 'json']),
      'card:list',
    );
    if (!Array.isArray(raw)) {
      throw new Error(`hub: trello engine card:list returned ${typeof raw}, expected an array`);
    }
    return raw.map((c) => c as TrelloCard);
  }

  /** @inheritdoc Create a card (trello card:create --format json). */
  async createCard(input: {
    listRef: string;
    name: string;
    description?: string | null;
    due?: string | null;
  }): Promise<TrelloCard> {
    const args = [
      'card:create',
      '--board',
      this.boardRef,
      '--list',
      input.listRef,
      '--name',
      input.name,
      '--format',
      'json',
    ];
    if (input.description) args.push('--description', input.description);
    const due = dueArg(input.due);
    if (due) args.push('--due', due);
    return (await runEngine(this.enginePath, args).then((out) => parseEngineJson(out, 'card:create'))) as TrelloCard;
  }

  /** @inheritdoc Patch a card's fields (trello card:update --format json). */
  async updateCard(
    cardId: string,
    patch: { name?: string; description?: string | null; due?: string | null },
  ): Promise<void> {
    const args = ['card:update', '--id', cardId, '--format', 'json'];
    if (patch.name !== undefined) args.push('--name', patch.name);
    if (patch.description !== undefined) args.push('--description', patch.description ?? '');
    const due = dueArg(patch.due);
    if (due) args.push('--due', due);
    else if (patch.due === null) args.push('--clear-due');
    await runEngine(this.enginePath, args);
  }

  /** @inheritdoc Move a card (trello card:move --id X --to LIST_ID). */
  async moveCard(cardId: string, listRef: string): Promise<void> {
    await runEngine(this.enginePath, ['card:move', '--id', cardId, '--to', listRef, '--format', 'json']);
  }

  /** @inheritdoc Archive a card (trello card:archive --format json). */
  async archiveCard(cardId: string): Promise<TrelloCard> {
    return (await runEngine(this.enginePath, ['card:archive', '--id', cardId, '--format', 'json']).then((out) =>
      parseEngineJson(out, 'card:archive'),
    )) as TrelloCard;
  }
}
