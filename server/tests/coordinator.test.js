import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { KeyedQueue, SaveCoordinator } from '../coordinator.js';
import { GameStore } from '../store.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCoordinator(options = {}) {
  const directory = makeTempDir('sky-post-coordinator-');
  const coordinator = new SaveCoordinator(directory, { game: { seed: 'coordinator-seed' }, ...options });
  return { coordinator, directory };
}

function firstAssignment(state) {
  const letter = state.letters.find((item) => item.status === 'inbox');
  return {
    letterId: letter.id,
    courierId: 'comet',
    targetIslandId: letter.recipientIslandId,
    order: 0
  };
}

test('键控队列：同键严格串行，跨键并发，失败不阻断后续任务', async () => {
  const queue = new KeyedQueue();
  const order = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });

  const first = queue.schedule('a', async () => { await gateA; order.push('a1'); });
  const second = queue.schedule('a', async () => { order.push('a2'); });
  const other = queue.schedule('b', async () => { order.push('b1'); });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['b1']);

  releaseA();
  await Promise.all([first, second, other]);
  assert.deepEqual(order, ['b1', 'a1', 'a2']);

  await assert.rejects(queue.schedule('a', () => { throw new Error('boom'); }));
  const afterFailure = await queue.schedule('a', () => 'ok');
  assert.equal(afterFailure, 'ok');
});

test('多槽位：创建、切换与状态隔离', async () => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();

  const initial = coordinator.listSlots();
  assert.equal(initial.slots.length, 1);
  const firstSlotId = initial.activeSlotId;

  const created = await coordinator.createSlot({ name: '第二航线', seed: 'slot-b' });
  assert.equal(created.slots.length, 2);
  const secondSlotId = created.slot.id;
  assert.equal(coordinator.listSlots().activeSlotId, firstSlotId);

  const before = await coordinator.getState();
  await coordinator.advance([firstAssignment(before)], before.revision);
  assert.equal((await coordinator.getState()).day, 2);

  await coordinator.switchSlot(secondSlotId);
  const secondState = await coordinator.getState();
  assert.equal(secondState.day, 1);
  assert.equal(secondState.seed, 'slot-b');

  await coordinator.switchSlot(firstSlotId);
  const firstState = await coordinator.getState();
  assert.equal(firstState.day, 2);

  const listed = coordinator.listSlots();
  assert.equal(listed.activeSlotId, firstSlotId);
  assert.equal(listed.slots.find((slot) => slot.id === secondSlotId).name, '第二航线');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('同一槽位并发写入被串行化，冲突方保留为可恢复版本而非覆盖', async () => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();

  const state = await coordinator.getState();
  const assignment = firstAssignment(state);

  const results = await Promise.allSettled([
    coordinator.advance([assignment], state.revision),
    coordinator.advance([assignment], state.revision)
  ]);

  const succeeded = results.filter((result) => result.status === 'fulfilled');
  const failed = results.filter((result) => result.status === 'rejected');
  assert.equal(succeeded.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.statusCode, 409);
  assert.ok(failed[0].reason.conflictId);

  const after = await coordinator.getState();
  assert.equal(after.day, 2);
  assert.equal(after.revision, state.revision + 1);

  const versions = await coordinator.listVersions();
  const conflicts = versions.filter((version) => version.type === 'conflict');
  const snapshots = versions.filter((version) => version.type === 'snapshot');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].id, failed[0].reason.conflictId);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].revision, state.revision);

  const conflictDetail = await coordinator.getVersion(conflicts[0].id);
  assert.equal(conflictDetail.expectedRevision, state.revision);
  assert.equal(conflictDetail.actualRevision, state.revision + 1);
  assert.deepEqual(conflictDetail.payload.assignments, [assignment]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('不同槽位的并发写入互不阻塞、各自生效', async () => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();
  const firstSlotId = coordinator.listSlots().activeSlotId;
  const { slot: secondSlot } = await coordinator.createSlot({ name: '并行航线', seed: 'parallel-b' });

  const [firstState, secondState] = await Promise.all([
    coordinator.getState(firstSlotId),
    coordinator.getState(secondSlot.id)
  ]);

  const [firstResult, secondResult] = await Promise.all([
    coordinator.advance([firstAssignment(firstState)], firstState.revision, firstSlotId),
    coordinator.advance([firstAssignment(secondState)], secondState.revision, secondSlot.id)
  ]);

  assert.equal(firstResult.state.day, 2);
  assert.equal(secondResult.state.day, 2);
  assert.equal((await coordinator.getState(firstSlotId)).day, 2);
  assert.equal((await coordinator.getState(secondSlot.id)).day, 2);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('快照可恢复，恢复本身也留下可恢复版本，revision 单调递增', async () => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();

  const dayOne = await coordinator.getState();
  await coordinator.advance([firstAssignment(dayOne)], dayOne.revision);
  const dayTwo = await coordinator.getState();
  assert.equal(dayTwo.day, 2);

  const firstVersions = await coordinator.listVersions();
  const dayOneSnapshot = firstVersions.find((version) => version.type === 'snapshot' && version.day === 1);
  assert.ok(dayOneSnapshot);

  const restored = await coordinator.restoreVersion(dayOneSnapshot.id);
  assert.equal(restored.day, 1);
  assert.ok(restored.revision > dayTwo.revision);

  const secondVersions = await coordinator.listVersions();
  const restoreSnapshot = secondVersions.find((version) => version.type === 'snapshot' && version.reason === 'restore');
  assert.ok(restoreSnapshot);
  assert.equal(restoreSnapshot.day, 2);

  const restoredAgain = await coordinator.restoreVersion(restoreSnapshot.id);
  assert.equal(restoredAgain.day, 2);
  assert.ok(restoredAgain.revision > restored.revision);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('重新开局与删除槽位同样先留档：reset 有快照，delete 归档到 .trash', async () => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();

  const before = await coordinator.getState();
  await coordinator.reset('reset-seed');
  const versions = await coordinator.listVersions();
  assert.ok(versions.some((version) => version.type === 'snapshot' && version.reason === 'reset'));

  const { slot: doomed } = await coordinator.createSlot({ name: '待删除', seed: 'doomed' });
  await coordinator.deleteSlot(doomed.id);
  assert.equal(coordinator.listSlots().slots.some((slot) => slot.id === doomed.id), false);

  const trash = path.join(directory, '.trash');
  const archived = fs.readdirSync(trash).filter((name) => name.startsWith(doomed.id));
  assert.equal(archived.length, 1);
  assert.ok(fs.existsSync(path.join(trash, archived[0], `${doomed.id}.json`)));

  fs.rmSync(directory, { recursive: true, force: true });
});

test('删除当前槽位后自动切换；删光后自动建立新槽位', async () => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();
  const firstSlotId = coordinator.listSlots().activeSlotId;
  const { slot: secondSlot } = await coordinator.createSlot({ name: '备用', seed: 'backup' });

  await coordinator.deleteSlot(firstSlotId);
  assert.equal(coordinator.listSlots().activeSlotId, secondSlot.id);

  await coordinator.deleteSlot(secondSlot.id);
  const after = coordinator.listSlots();
  assert.equal(after.slots.length, 1);
  assert.equal(after.activeSlotId, after.slots[0].id);
  assert.equal((await coordinator.getState()).day, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('旧的单存档文件会自动迁移为默认槽位，原文件保留', async () => {
  const directory = makeTempDir('sky-post-legacy-');
  const legacyFile = path.join(directory, 'game-state.json');
  const legacyStore = new GameStore(legacyFile, { seed: 'legacy-seed', days: 14 });
  legacyStore.load();

  const coordinator = new SaveCoordinator(path.join(directory, 'saves'), {
    game: { days: 14 },
    legacyFile
  });
  await coordinator.load();

  const { slots, activeSlotId } = coordinator.listSlots();
  assert.equal(slots.length, 1);
  assert.equal(activeSlotId, 'default');
  assert.equal(slots[0].name, '继承存档');
  assert.equal((await coordinator.getState()).seed, 'legacy-seed');
  assert.ok(fs.existsSync(legacyFile));

  fs.rmSync(directory, { recursive: true, force: true });
});

test('HTTP 多存档闭环：列表、创建、切换、冲突记录与恢复', async (context) => {
  const { coordinator, directory } = makeCoordinator();
  await coordinator.load();
  const server = createApp({ coordinator, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options) => {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return { status: response.status, body: await response.json() };
  };

  const savesResponse = await request('/api/saves');
  assert.equal(savesResponse.status, 200);
  assert.equal(savesResponse.body.slots.length, 1);
  const firstSlotId = savesResponse.body.activeSlotId;

  const createResponse = await request('/api/saves', {
    method: 'POST',
    body: JSON.stringify({ name: '云端航线', seed: 'http-slot-b' })
  });
  assert.equal(createResponse.status, 201);
  const secondSlotId = createResponse.body.slot.id;

  const switchResponse = await request(`/api/saves/${secondSlotId}/switch`, { method: 'POST', body: '{}' });
  assert.equal(switchResponse.status, 200);
  assert.equal(switchResponse.body.activeSlotId, secondSlotId);

  const gameResponse = await request('/api/game');
  assert.equal(gameResponse.body.state.seed, 'http-slot-b');

  const explicitResponse = await request(`/api/game?slot=${firstSlotId}`);
  assert.equal(explicitResponse.body.state.seed, 'coordinator-seed');

  const state = gameResponse.body.state;
  const assignment = firstAssignment(state);
  const advanceBody = JSON.stringify({ assignments: [assignment], expectedRevision: state.revision });
  const advanceResponse = await request('/api/game/day/advance', { method: 'POST', body: advanceBody });
  assert.equal(advanceResponse.status, 200);
  assert.equal(advanceResponse.body.state.day, 2);

  const conflictResponse = await request('/api/game/day/advance', { method: 'POST', body: advanceBody });
  assert.equal(conflictResponse.status, 409);
  assert.ok(conflictResponse.body.conflictId);

  const versionsResponse = await request(`/api/saves/${secondSlotId}/versions`);
  assert.equal(versionsResponse.status, 200);
  const conflictVersion = versionsResponse.body.versions.find((version) => version.type === 'conflict');
  const snapshotVersion = versionsResponse.body.versions.find((version) => version.type === 'snapshot');
  assert.equal(conflictVersion.id, conflictResponse.body.conflictId);
  assert.ok(snapshotVersion);

  const conflictDetail = await request(`/api/saves/${secondSlotId}/versions/${conflictVersion.id}`);
  assert.equal(conflictDetail.status, 200);
  assert.deepEqual(conflictDetail.body.version.payload.assignments, [assignment]);

  const restoreResponse = await request(`/api/saves/${secondSlotId}/restore`, {
    method: 'POST',
    body: JSON.stringify({ versionId: snapshotVersion.id })
  });
  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreResponse.body.state.day, 1);

  const missingSlot = await request('/api/saves/no-such-slot/switch', { method: 'POST', body: '{}' });
  assert.equal(missingSlot.status, 404);
});
