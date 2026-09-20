import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GameRuleError, advanceDay, previewPlan, publicGameState } from './engine.js';
import { GameStore, assertPlanningPhase } from './store.js';

const MANIFEST_FILE = 'index.json';
const MANIFEST_QUEUE_KEY = '__manifest__';
const DEFAULT_MAX_VERSIONS = 12;
const VERSION_ID_PATTERN = /^(snap|conflict)-[A-Za-z0-9-]+$/;

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // 临时文件清理失败不应覆盖原始写入错误。
      }
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function assertExpectedRevision(state, expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    throw new GameRuleError('提交游戏进度时必须提供整数 expectedRevision。');
  }
  if (state.revision !== expectedRevision) {
    throw new GameRuleError('游戏进度已在其他请求中更新，请刷新后再提交。', [], 409);
  }
}

/**
 * 键控串行队列：同一 key 的任务严格 FIFO 串行，不同 key 的任务互不阻塞。
 * 这是协调器的调度核心——同一存档槽位的操作串行化，跨槽位并发写入。
 */
export class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  schedule(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const run = previous.then(() => task());
    // 失败的任务不应阻断同 key 的后续任务，因此链上保存吞掉错误的版本。
    this.tails.set(key, run.catch(() => {}));
    return run;
  }
}

function summarizeVersion(record) {
  const base = {
    id: record.id,
    type: record.type,
    slotId: record.slotId,
    savedAt: record.savedAt
  };
  if (record.type === 'snapshot') {
    return {
      ...base,
      reason: record.reason,
      revision: record.revision,
      day: record.state?.day,
      phase: record.state?.phase,
      reputation: record.state?.reputation
    };
  }
  return {
    ...base,
    expectedRevision: record.expectedRevision,
    actualRevision: record.actualRevision
  };
}

/**
 * 多存档调度协调器。
 *
 * - 切换：activeSlotId 持久化于 index.json，切换经 manifest 队列原子落盘；
 * - 隔离：每个槽位独立的 GameStore 实例、状态文件与版本目录；
 * - 并发写入：槽位间队列互不相干，可并行推进；
 * - 同一局串行化：同一槽位的读写全部经 KeyedQueue 串行执行；
 * - 冲突保留可恢复版本：变更前留快照，版本冲突时被拒写入存为 conflict 记录，
 *   任何覆盖性操作都先有可恢复版本落盘，绝不裸覆盖。
 */
export class SaveCoordinator {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.gameOptions = options.game || {};
    this.legacyFile = options.legacyFile || null;
    this.maxVersions = Number.isInteger(options.maxVersions) && options.maxVersions > 0
      ? options.maxVersions
      : DEFAULT_MAX_VERSIONS;
    this.queue = new KeyedQueue();
    this.stores = new Map();
    this.manifest = null;
  }

  get manifestPath() {
    return path.join(this.directory, MANIFEST_FILE);
  }

  slotFile(slotId) {
    return path.join(this.directory, `${slotId}.json`);
  }

  versionsDir(slotId) {
    return path.join(this.directory, `${slotId}.versions`);
  }

  load() {
    return this.queue.schedule(MANIFEST_QUEUE_KEY, () => this.loadManifest());
  }

  loadManifest() {
    fs.mkdirSync(this.directory, { recursive: true });

    if (fs.existsSync(this.manifestPath)) {
      try {
        const parsed = readJson(this.manifestPath);
        if (!parsed || typeof parsed !== 'object' || !parsed.slots || typeof parsed.slots !== 'object') {
          throw new Error('存档清单结构不完整');
        }
        this.manifest = { activeSlotId: parsed.activeSlotId ?? null, slots: parsed.slots };
      } catch (error) {
        const backupPath = `${this.manifestPath}.corrupt-${timestampToken()}`;
        fs.renameSync(this.manifestPath, backupPath);
        this.manifest = this.rebuildManifestFromDisk();
      }
    } else {
      this.manifest = { activeSlotId: null, slots: {} };
    }

    if (Object.keys(this.manifest.slots).length === 0) {
      if (this.legacyFile && fs.existsSync(this.legacyFile)) {
        // 兼容旧的单存档文件：迁移为默认槽位，原文件保留不删。
        const slotId = 'default';
        fs.copyFileSync(this.legacyFile, this.slotFile(slotId));
        this.manifest.slots[slotId] = {
          id: slotId,
          name: '继承存档',
          createdAt: new Date().toISOString()
        };
        this.manifest.activeSlotId = slotId;
      } else {
        this.createSlotLocked({ name: '航线一' });
      }
    }

    if (!this.manifest.activeSlotId || !this.manifest.slots[this.manifest.activeSlotId]) {
      this.manifest.activeSlotId = Object.keys(this.manifest.slots)[0];
    }
    this.saveManifest();
    return this.listSlots();
  }

  rebuildManifestFromDisk() {
    const slots = {};
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json') || name === MANIFEST_FILE) continue;
      if (name.includes('.corrupt-') || name.endsWith('.tmp')) continue;
      const slotId = name.slice(0, -'.json'.length);
      slots[slotId] = {
        id: slotId,
        name: slotId === 'default' ? '航线一' : slotId,
        createdAt: new Date().toISOString()
      };
    }
    return { activeSlotId: null, slots };
  }

  saveManifest() {
    writeJsonAtomic(this.manifestPath, this.manifest);
  }

  hasSlot(slotId) {
    return Object.prototype.hasOwnProperty.call(this.manifest.slots, slotId);
  }

  resolveSlotId(slotId) {
    const id = slotId ?? this.manifest.activeSlotId;
    if (typeof id !== 'string' || !this.hasSlot(id)) {
      throw new GameRuleError(
        slotId ? `存档槽位不存在：${slotId}` : '当前没有可用的存档槽位。',
        [],
        404
      );
    }
    return id;
  }

  storeFor(slotId) {
    let store = this.stores.get(slotId);
    if (!store) {
      store = new GameStore(this.slotFile(slotId), this.gameOptions);
      store.load();
      this.stores.set(slotId, store);
    }
    return store;
  }

  peekState(slotId) {
    const cached = this.stores.get(slotId);
    if (cached) return cached.getState();
    try {
      return readJson(this.slotFile(slotId));
    } catch {
      return null;
    }
  }

  listSlots() {
    const slots = Object.values(this.manifest.slots).map((slot) => {
      const state = this.peekState(slot.id);
      return {
        ...slot,
        active: slot.id === this.manifest.activeSlotId,
        day: state?.day ?? null,
        phase: state?.phase ?? null,
        revision: state?.revision ?? null,
        seed: state?.seed ?? null,
        updatedAt: state?.updatedAt ?? null
      };
    });
    return { activeSlotId: this.manifest.activeSlotId, slots };
  }

  createSlotLocked({ name, seed } = {}) {
    const slotId = `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const store = new GameStore(this.slotFile(slotId), {
      ...this.gameOptions,
      seed: seed ?? this.gameOptions.seed ?? `${Date.now()}`
    });
    store.load();
    this.stores.set(slotId, store);
    const slot = {
      id: slotId,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : `航线 ${Object.keys(this.manifest.slots).length + 1}`,
      createdAt: new Date().toISOString()
    };
    this.manifest.slots[slotId] = slot;
    if (!this.manifest.activeSlotId) this.manifest.activeSlotId = slotId;
    this.saveManifest();
    return slot;
  }

  createSlot(options = {}) {
    return this.queue.schedule(MANIFEST_QUEUE_KEY, () => {
      const slot = this.createSlotLocked(options);
      return { slot, ...this.listSlots() };
    });
  }

  switchSlot(slotId) {
    return this.queue.schedule(MANIFEST_QUEUE_KEY, () => {
      if (!this.hasSlot(slotId)) {
        throw new GameRuleError(`存档槽位不存在：${slotId}`, [], 404);
      }
      this.manifest.activeSlotId = slotId;
      this.saveManifest();
      return this.listSlots();
    });
  }

  deleteSlot(slotId) {
    return this.queue.schedule(MANIFEST_QUEUE_KEY, () => {
      if (!this.hasSlot(slotId)) {
        throw new GameRuleError(`存档槽位不存在：${slotId}`, [], 404);
      }
      // 删除同样是可恢复的：槽位文件与版本目录整体归档到 .trash，而非直接抹除。
      const trashDir = path.join(this.directory, '.trash', `${slotId}-${timestampToken()}`);
      fs.mkdirSync(trashDir, { recursive: true });
      const stateFile = this.slotFile(slotId);
      if (fs.existsSync(stateFile)) {
        fs.renameSync(stateFile, path.join(trashDir, `${slotId}.json`));
      }
      const versionsDir = this.versionsDir(slotId);
      if (fs.existsSync(versionsDir)) {
        fs.renameSync(versionsDir, path.join(trashDir, `${slotId}.versions`));
      }
      delete this.manifest.slots[slotId];
      this.stores.delete(slotId);
      if (this.manifest.activeSlotId === slotId) {
        this.manifest.activeSlotId = Object.keys(this.manifest.slots)[0] || null;
        if (!this.manifest.activeSlotId) {
          this.createSlotLocked({ name: '航线一' });
        }
      }
      this.saveManifest();
      return this.listSlots();
    });
  }

  // ---------- 版本快照与冲突记录 ----------

  recordSnapshot(slotId, state, reason) {
    const revision = Number.isInteger(state?.revision) ? state.revision : 0;
    const id = `snap-${timestampToken()}-r${revision}-${crypto.randomBytes(2).toString('hex')}`;
    const record = {
      id,
      type: 'snapshot',
      slotId,
      reason,
      revision,
      savedAt: new Date().toISOString(),
      state
    };
    writeJsonAtomic(path.join(this.versionsDir(slotId), `${id}.json`), record);
    this.pruneVersions(slotId, 'snap-');
    return id;
  }

  recordConflict(slotId, { expectedRevision, actualRevision, payload }) {
    const expected = Number.isInteger(expectedRevision) ? expectedRevision : 'x';
    const id = `conflict-${timestampToken()}-r${expected}-${crypto.randomBytes(2).toString('hex')}`;
    const record = {
      id,
      type: 'conflict',
      slotId,
      expectedRevision,
      actualRevision,
      payload,
      savedAt: new Date().toISOString()
    };
    writeJsonAtomic(path.join(this.versionsDir(slotId), `${id}.json`), record);
    this.pruneVersions(slotId, 'conflict-');
    return id;
  }

  pruneVersions(slotId, prefix) {
    const dir = this.versionsDir(slotId);
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .map((name) => {
        try {
          return { name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((first, second) => second.mtimeMs - first.mtimeMs);
    for (const stale of entries.slice(this.maxVersions)) {
      try {
        fs.unlinkSync(path.join(dir, stale.name));
      } catch {
        // 清理失败不影响主流程。
      }
    }
  }

  readVersionIndex(slotId) {
    const dir = this.versionsDir(slotId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return summarizeVersion(readJson(path.join(dir, name)));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((first, second) => String(second.savedAt).localeCompare(String(first.savedAt)));
  }

  listVersions(slotId) {
    const id = this.resolveSlotId(slotId);
    return this.queue.schedule(id, () => this.readVersionIndex(id));
  }

  readVersion(slotId, versionId) {
    if (typeof versionId !== 'string' || !VERSION_ID_PATTERN.test(versionId)) {
      throw new GameRuleError('版本标识无效。', [], 400);
    }
    const file = path.join(this.versionsDir(slotId), `${versionId}.json`);
    if (!fs.existsSync(file)) {
      throw new GameRuleError('版本不存在或已被清理。', [], 404);
    }
    return readJson(file);
  }

  getVersion(versionId, slotId) {
    const id = this.resolveSlotId(slotId);
    return this.queue.schedule(id, () => this.readVersion(id, versionId));
  }

  restoreVersion(versionId, slotId) {
    const id = this.resolveSlotId(slotId);
    // 注意：队列任务内部不得再 schedule 同一槽位，否则会自我等待，这里直接用 readVersion。
    return this.queue.schedule(id, () => {
      const version = this.readVersion(id, versionId);
      if (version.type !== 'snapshot') {
        throw new GameRuleError('冲突记录不能直接恢复，请取出其中的方案后重新提交。', [], 400);
      }
      const store = this.storeFor(id);
      const before = store.getState();
      const restored = structuredClone(version.state);
      // revision 单调递增、绝不回退：旧客户端持有的 expectedRevision 必然失配，
      // 恢复动作不会给过期请求留下写入窗口。
      restored.revision = (Number.isInteger(before.revision) ? before.revision : 0) + 1;
      const state = store.replace(restored);
      this.recordSnapshot(id, before, 'restore');
      return publicGameState(state);
    });
  }

  // ---------- 游戏操作（默认作用于当前槽位，全部经槽位队列串行化） ----------

  getState(slotId) {
    const id = this.resolveSlotId(slotId);
    return this.queue.schedule(id, () => {
      const store = this.storeFor(id);
      const state = publicGameState(store.getState());
      const recovery = store.getRecovery?.();
      return recovery ? { ...state, recovery } : state;
    });
  }

  preview(assignments, slotId) {
    const id = this.resolveSlotId(slotId);
    return this.queue.schedule(id, () => {
      const state = this.storeFor(id).getState();
      assertPlanningPhase(state);
      return previewPlan(state, assignments);
    });
  }

  advance(assignments, expectedRevision, slotId) {
    const id = this.resolveSlotId(slotId);
    return this.queue.schedule(id, () => {
      const store = this.storeFor(id);
      const before = store.getState();
      let report;
      try {
        report = store.mutate((state) => {
          assertPlanningPhase(state);
          assertExpectedRevision(state, expectedRevision);
          return advanceDay(state, assignments);
        });
      } catch (error) {
        if (error.statusCode === 409) {
          // 冲突不覆盖：被拒的写入落盘为可恢复版本，调用方可凭 conflictId 取回方案。
          error.conflictId = this.recordConflict(id, {
            expectedRevision,
            actualRevision: store.getState().revision,
            payload: { assignments }
          });
        }
        throw error;
      }
      this.recordSnapshot(id, before, 'advance');
      return { report, state: publicGameState(store.getState()) };
    });
  }

  reset(seed, slotId) {
    const id = this.resolveSlotId(slotId);
    return this.queue.schedule(id, () => {
      const store = this.storeFor(id);
      const before = store.getState();
      const state = store.reset(seed);
      this.recordSnapshot(id, before, 'reset');
      return publicGameState(state);
    });
  }
}

/**
 * 单存档适配器：包住既有的 GameStore，暴露与 SaveCoordinator 相同的接口，
 * 供 createApp({ store }) 的旧用法与测试继续工作。多存档与版本能力不可用。
 */
export class SingleSlotCoordinator {
  constructor(store) {
    this.store = store;
    this.queue = new KeyedQueue();
  }

  listSlots() {
    const state = this.store.getState();
    return {
      activeSlotId: 'default',
      slots: [{
        id: 'default',
        name: '本地存档',
        active: true,
        day: state.day,
        phase: state.phase,
        revision: state.revision,
        seed: state.seed,
        updatedAt: state.updatedAt
      }]
    };
  }

  unsupported() {
    throw new GameRuleError('当前为单存档模式，多存档与版本恢复不可用。', [], 404);
  }

  createSlot() { return this.unsupported(); }
  switchSlot() { return this.unsupported(); }
  deleteSlot() { return this.unsupported(); }
  getVersion() { return this.unsupported(); }
  restoreVersion() { return this.unsupported(); }
  listVersions() { return Promise.resolve([]); }

  getState() {
    return this.queue.schedule('default', () => {
      const state = publicGameState(this.store.getState());
      const recovery = this.store.getRecovery?.();
      return recovery ? { ...state, recovery } : state;
    });
  }

  preview(assignments) {
    return this.queue.schedule('default', () => {
      const state = this.store.getState();
      assertPlanningPhase(state);
      return previewPlan(state, assignments);
    });
  }

  advance(assignments, expectedRevision) {
    return this.queue.schedule('default', () => {
      const report = this.store.mutate((state) => {
        assertPlanningPhase(state);
        assertExpectedRevision(state, expectedRevision);
        return advanceDay(state, assignments);
      });
      return { report, state: publicGameState(this.store.getState()) };
    });
  }

  reset(seed) {
    return this.queue.schedule('default', () => publicGameState(this.store.reset(seed)));
  }
}
