// trello-config: write/merge the trello block of the hub JSON config file
// (~/.hub/config.json, $HUB_CONFIG-overridable — S11). Deliberately OFFLINE:
// no engine call, no network — completeness is validated by sync-trello at
// run time. Merge semantics (the ticket's whole point): a partial invocation
// (--engine-path only, say) must never DELETE config values that already
// exist — only provided flags change fields. --json echoes the trello block.
import { loadHubConfig, saveHubConfig, type HubJsonConfig, type TrelloConfig } from '../../core/config.ts';
import { ENGINE_DEFAULT_PATH } from '../../core/constants.ts';
import type { CliValues, TrelloConfigStatus } from '../../core/types.ts';

/**
 * Read the existing trello block (or an empty default for a fresh config),
 * overlay every provided board/list/engine-path flag, and save the merged
 * document back — other top-level keys preserved verbatim. enginePath
 * defaults to "trello" when the whole block is new; when the block exists
 * with an enginePath, a partial invocation keeps it.
 * @param values - Parsed CLI flags: board, list-ready, list-in-progress,
 *   list-done, engine-path, plus the shared json/db passthrough.
 * @returns Process exit code (0 = saved; 1 = no flags given).
 */
export async function cmdTrelloConfig(values: CliValues): Promise<number> {
  const board = values.board as string | undefined;
  const listReady = values['list-ready'] as string | undefined;
  const listInProgress = values['list-in-progress'] as string | undefined;
  const listDone = values['list-done'] as string | undefined;
  const enginePath = values['engine-path'] as string | undefined;

  if (!board && !listReady && !listInProgress && !listDone && !enginePath) {
    console.error(
      'hub trello-config: usage: hub trello-config --board <id> --list-ready <id> --list-in-progress <id> --list-done <id> [--engine-path <cmd>]',
    );
    return 1;
  }

  // Merge over the CURRENT block, so a partial invocation never deletes
  // existing values (the ticket's merge semantics, tested explicitly).
  const existing: Partial<TrelloConfig> = loadHubConfig().trello ?? {};
  const existingLists = existing.lists ?? { ready: '', 'in-progress': '', done: '' };
  const trello: TrelloConfig = {
    enginePath: enginePath ?? existing.enginePath ?? ENGINE_DEFAULT_PATH,
    board: board ?? existing.board ?? '',
    lists: {
      ready: listReady ?? existingLists.ready,
      'in-progress': listInProgress ?? existingLists['in-progress'],
      done: listDone ?? existingLists.done,
    },
  };

  saveHubConfig({ trello } as HubJsonConfig);

  const status: TrelloConfigStatus = {
    verb: 'trello-config',
    trello,
    updated_fields: [
      ...(board ? ['board'] : []),
      ...(listReady ? ['lists.ready'] : []),
      ...(listInProgress ? ['lists.in-progress'] : []),
      ...(listDone ? ['lists.done'] : []),
      ...(enginePath ? ['enginePath'] : []),
    ],
  };
  if (values.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(
      `hub trello-config: updated ${status.updated_fields.join(', ')} (engine ${trello.enginePath}, board ${trello.board || '(unset)'})`,
    );
  }
  return 0;
}
