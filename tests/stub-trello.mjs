#!/usr/bin/env node
// Stub trello-cli (S11 tests): emulates the card commands the hub syncs
// with, state kept in a JSON file at $TRELLO_STUB_STATE. Supported: sync,
// card:list --board B --list L, card:create --board B --list L --name N
// [--description D] [--due ISO] --format json, card:update --id ... --format
// json, card:move --id --to, card:archive --id. Unknown commands exit 3 (the
// adapter's stderr-tail error path); missing ids exit 4. Write commands
// print their updated card as JSON (--format json), matching trello-cli 2.0.0.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const statePath = process.env.TRELLO_STUB_STATE ?? 'trello-state.json';
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

function loadState() {
  if (!existsSync(statePath)) return { nextId: 1, cards: [] };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
function saveState(s) {
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

const cmd = argv[0] ?? '';
const state = loadState();
const jsonOut = (v) => console.log(JSON.stringify(v));

if (cmd === 'sync') {
  saveState(state);
  process.exit(0);
}

if (cmd === 'card:list') {
  const list = flag('--list');
  jsonOut(state.cards.filter((c) => c.list === list && !c.closed));
  process.exit(0);
}

if (cmd === 'card:create') {
  const card = {
    id: `card${String(state.nextId).padStart(3, '0')}`,
    name: flag('--name'),
    description: flag('--description') ?? '',
    due: flag('--due') ?? null,
    closed: false,
    url: `https://stub.test/c/${state.nextId}`,
    labels: [],
    list: flag('--list'),
  };
  state.nextId += 1;
  state.cards.push(card);
  saveState(state);
  jsonOut(card);
  process.exit(0);
}

if (cmd === 'card:update') {
  const id = flag('--id');
  const card = state.cards.find((c) => c.id === id);
  if (!card) process.exit(4);
  if (argv.includes('--clear-due')) card.due = null;
  else if (flag('--due') !== undefined) card.due = flag('--due');
  if (flag('--name') !== undefined) card.name = flag('--name');
  if (flag('--description') !== undefined) card.description = flag('--description');
  saveState(state);
  jsonOut(card);
  process.exit(0);
}

if (cmd === 'card:move') {
  const card = state.cards.find((c) => c.id === flag('--id'));
  if (!card) process.exit(4);
  card.list = flag('--to');
  saveState(state);
  jsonOut(card);
  process.exit(0);
}

if (cmd === 'card:archive') {
  const card = state.cards.find((c) => c.id === flag('--id'));
  if (!card) process.exit(4);
  card.closed = true;
  saveState(state);
  jsonOut(card);
  process.exit(0);
}

process.stderr.write(`stub-trello: unknown command ${cmd}\n`);
process.exit(3);
