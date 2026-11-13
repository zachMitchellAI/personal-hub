// Factory smoke tests — every fixture/arg-builder in tests/helpers.ts, proven
// against the real CLI in one throwaway DB. Not per-verb acceptance (those
// live in the S* files); this file confirms the factories compose: a person
// gets channels, an interaction references that channel, a task gets
// subtasks, an entity links to the person AND the task, a file indexes
// against the person, a trackable takes an event. CLI-level per DECISIONS #15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  channelArgs,
  entityArgs,
  fileArgs,
  fixtureChannel,
  fixtureEntity,
  fixtureFile,
  fixtureInteraction,
  fixturePerson,
  fixtureTask,
  fixtureTrackable,
  interactionArgs,
  makeTmp,
  personArgs,
  runHub,
  slugFor,
  taskArgs,
  trackableArgs,
} from './helpers.ts';

interface AddStatus {
  verb: string;
  id?: number;
  slug?: string;
}

/** Parse one add-verb --json payload (exit 0 + valid JSON is the contract). */
function added(args: string[], env: Record<string, string>): AddStatus {
  const r = runHub([...args, '--json'], env);
  assert.equal(r.status, 0, `${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as AddStatus;
}

test('factories: person → channel → interaction chain builds through the CLI', (t) => {
  const tmp = makeTmp('hub-factory-');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db'), HUB_FILES: join(tmp, 'files') };

  const person = fixturePerson(0);
  assert.equal(runHub(personArgs(person), env).status, 0);

  const channel = fixtureChannel(0);
  const channelStatus = added(channelArgs(slugFor(person.name), channel), env);
  assert.equal(channelStatus.verb, 'add-channel');

  // The interaction references the channel VALUE, not an id — factory must
  // line up with the channel the person got.
  const interaction = fixtureInteraction(0);
  assert.equal(interaction.channel, channel.value);
  const interactionStatus = added(interactionArgs({ ...interaction, channel: channel.value }), env);
  assert.equal(interactionStatus.verb, 'add-interaction');

  // Both landed on the person: list-channels shows the factory email.
  const channels = runHub(['list-channels', slugFor(person.name), '--json'], env);
  assert.equal(channels.status, 0);
  assert.ok(channels.stdout.includes(channel.value));
});

test('factories: task → subtask, entity → links, file → person, trackable → event', (t) => {
  const tmp = makeTmp('hub-factory-');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db'), HUB_FILES: join(tmp, 'files') };

  const person = fixturePerson(1);
  added(personArgs(person), env);
  const personSlug = slugFor(person.name);

  // Task + subtask (subtask needs the task id the factory run produced).
  const task = fixtureTask(0);
  const taskStatus = added(taskArgs(task), env);
  const sub = runHub(['add-subtask', String(taskStatus.id), '--label', 'Fixture subtask 1', '--json'], env);
  assert.equal(sub.status, 0, sub.stderr);

  // Entity + two links: → person (slug) and → task (id).
  const entity = fixtureEntity(0);
  const entityStatus = added(entityArgs(entity), env);
  const linkPerson = runHub(
    ['link-entity', String(entityStatus.slug), '--target-type', 'person', '--target', personSlug, '--json'],
    env,
  );
  assert.equal(linkPerson.status, 0, linkPerson.stderr);
  const linkTask = runHub(
    ['link-entity', String(entityStatus.slug), '--target-type', 'task', '--target', String(taskStatus.id), '--json'],
    env,
  );
  assert.equal(linkTask.status, 0, linkTask.stderr);

  // File indexed against the person.
  const file = fixtureFile(0);
  const fileStatus = added([...fileArgs(file), '--person', personSlug], env);
  assert.equal(fileStatus.verb, 'add-file');

  // Trackable + event.
  const trackable = fixtureTrackable(0);
  const trackableStatus = added(trackableArgs(trackable), env);
  const event = runHub(['add-trackable-event', String(trackableStatus.id), '--type', 'applied', '--json'], env);
  assert.equal(event.status, 0, event.stderr);

  // The whole graph resolves: person_full lists the interaction channel and
  // list-files ties the factory path to the person slug.
  const files = runHub(['list-files', '--person', personSlug, '--json'], env);
  assert.equal(files.status, 0);
  assert.ok(files.stdout.includes(file.path));

  // Entity links resolve to both targets (labels, not nulls).
  const links = runHub(['list-entity-links', String(entityStatus.slug), '--json'], env);
  assert.equal(links.status, 0);
  assert.ok(links.stdout.includes(person.name));
  assert.ok(links.stdout.includes(task.title));
});
