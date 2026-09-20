import fs from 'node:fs';
import path from 'node:path';
import { GameRuleError, createInitialState, GAME_VERSION } from './engine.js';

const VALID_PHASES = new Set(['planning', 'completed', 'failed']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUniqueIds(items) {
  const ids = items.map((item) => item?.id);
  return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
}

function hasValidReport(report) {
  if (report == null) return true;
  if (!isPlainObject(report)) return false;
  if (!Number.isInteger(report.day)) return false;
  if (!Number.isFinite(report.reputationBefore) || !Number.isFinite(report.reputationAfter)) return false;
  if (!Number.isFinite(report.reputationDelta) || !Number.isFinite(report.creditsDelta)) return false;
  if (!Number.isFinite(report.creditsBefore) || !Number.isFinite(report.creditsAfter)) return false;
  if (!Number.isInteger(report.streak)) return false;
  if (report.generatedNextDay !== null && !Number.isInteger(report.generatedNextDay)) return false;
  if (!Array.isArray(report.routes) || !Array.isArray(report.unassignedLetterIds) || !Array.isArray(report.relationChanges)) return false;
  if (!report.unassignedLetterIds.every((letterId) => typeof letterId === 'string')) return false;
  if (!report.routes.every((route) => (
    typeof route?.courierId === 'string' &&
    typeof route.courierName === 'string' &&
    Number.isInteger(route.letterCount) &&
    Number.isFinite(route.totalDistance) &&
    Array.isArray(route.letters) &&
    route.letters.every((letter) => (
      typeof letter?.letterId === 'string' &&
      typeof letter.targetName === 'string' &&
      ['on-time', 'late', 'wrong', 'wrong-late'].includes(letter.outcome) &&
      Number.isFinite(letter.arrivalHour) &&
      typeof letter.wrong === 'boolean' &&
      typeof letter.late === 'boolean'
    ))
  ))) return false;
  return report.relationChanges.every((change) => (
    typeof change?.key === 'string' &&
    typeof change.firstIslandName === 'string' &&
    typeof change.secondIslandName === 'string' &&
    Number.isFinite(change.delta) &&
    Array.isArray(change.reasons) &&
    change.reasons.every((reason) => typeof reason === 'string')
  ));
}

function hasValidEnding(ending) {
  if (ending == null) return true;
  if (!isPlainObject(ending)) return false;
  return (
    ['completed', 'failed'].includes(ending.type) &&
    typeof ending.title === 'string' &&
    typeof ending.message === 'string' &&
    typeof ending.rank === 'string'
  );
}

function hasValidStateShape(state) {
  if (!isPlainObject(state)) return false;
  if (state.version !== GAME_VERSION) return false;
  if (typeof state.seed !== 'string') return false;
  if (!Number.isInteger(state.day) || !Number.isInteger(state.days)) return false;
  if (state.day < 1 || state.days < 1 || state.day > state.days) return false;
  if (!VALID_PHASES.has(state.phase)) return false;
  if (!Number.isFinite(state.reputation) || state.reputation < 0 || state.reputation > 100) return false;
  if (!Number.isFinite(state.credits) || state.credits < 0) return false;
  if (!Number.isInteger(state.streak) || state.streak < 0) return false;
  if (!Number.isInteger(state.revision) || state.revision < 0) return false;
  if (!Array.isArray(state.islands) || !Array.isArray(state.couriers)) return false;
  if (!Array.isArray(state.letters) || !Array.isArray(state.history)) return false;
  if (!isPlainObject(state.wind) || !isPlainObject(state.relations)) return false;
  if (!hasValidReport(state.lastReport)) return false;
  if (!hasValidEnding(state.ending)) return false;
  if (state.phase === 'planning' && state.ending != null) return false;
  if (state.phase !== 'planning' && !hasValidEnding(state.ending)) return false;

  if (!hasUniqueIds(state.islands) || !hasUniqueIds(state.couriers) || !hasUniqueIds(state.letters)) return false;
  if (!state.islands.every((island) => (
    typeof island.name === 'string' &&
    typeof island.code === 'string' &&
    typeof island.color === 'string' &&
    isPlainObject(island.position) &&
    Number.isFinite(island.position.x) &&
    Number.isFinite(island.position.y)
  ))) return false;
  if (!state.islands.some((island) => island.id === 'skyport')) return false;
  if (!state.couriers.every((courier) => (
    typeof courier.name === 'string' &&
    typeof courier.callSign === 'string' &&
    typeof courier.color === 'string' &&
    typeof courier.description === 'string' &&
    Number.isFinite(courier.capacity) &&
    courier.capacity > 0 &&
    Number.isInteger(courier.maxLetters) &&
    courier.maxLetters > 0 &&
    Number.isFinite(courier.baseSpeed) &&
    courier.baseSpeed > 0
  ))) return false;

  const islandIds = new Set(state.islands.map((island) => island.id));
  if (!state.letters.every((letter) => (
    islandIds.has(letter.originIslandId) &&
    islandIds.has(letter.recipientIslandId) &&
    letter.originIslandId !== 'skyport' &&
    letter.recipientIslandId !== 'skyport' &&
    letter.originIslandId !== letter.recipientIslandId &&
    Number.isFinite(letter.weight) &&
    letter.weight > 0 &&
    Number.isInteger(letter.urgency) &&
    letter.urgency >= 1 &&
    letter.urgency <= 3 &&
    Number.isInteger(letter.deadlineDay) &&
    Number.isInteger(letter.deadlineHour) &&
    typeof letter.sender === 'string' &&
    typeof letter.subject === 'string' &&
    ['inbox', 'backlog', 'delivered'].includes(letter.status)
  ))) return false;

  if (!Number.isInteger(state.wind.directionIndex) || state.wind.directionIndex < 0 || state.wind.directionIndex > 7) return false;
  if (typeof state.wind.direction !== 'string' || typeof state.wind.note !== 'string') return false;
  if (!Number.isFinite(state.wind.angle) || !Number.isFinite(state.wind.strength) || state.wind.strength < 0) return false;
  if (!Object.entries(state.relations).every(([key, value]) => {
    const [firstId, secondId] = key.split(':');
    return (
      firstId !== secondId &&
      firstId !== 'skyport' &&
      secondId !== 'skyport' &&
      islandIds.has(firstId) &&
      islandIds.has(secondId) &&
      Number.isFinite(value)
    );
  })) return false;
  return true;
}

function normalizeStoredState(parsed) {
  if (!isPlainObject(parsed) || parsed.version !== GAME_VERSION) {
    return { state: parsed, changed: false };
  }

  let changed = false;
  if (!Number.isInteger(parsed.revision)) {
    parsed.revision = 0;
    changed = true;
  }
  if (Number.isFinite(parsed.reputation)) {
    const reputation = Math.min(100, Math.max(0, parsed.reputation));
    if (reputation !== parsed.reputation) {
      parsed.reputation = reputation;
      changed = true;
    }
  }
  if (Number.isFinite(parsed.credits) && parsed.credits < 0) {
    parsed.credits = 0;
    changed = true;
  }
  if (isPlainObject(parsed.relations)) {
    for (const [key, value] of Object.entries(parsed.relations)) {
      if (!Number.isFinite(value)) continue;
      const relation = Math.min(100, Math.max(-100, value));
      if (relation !== value) {
        parsed.relations[key] = relation;
        changed = true;
      }
    }
  }
  return { state: parsed, changed };
}

export class GameStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
    this.state = null;
    this.recovery = null;
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.recovery = null;
      const initialState = createInitialState(this.options);
      try {
        this.state = initialState;
        this.save();
      } catch (error) {
        this.state = null;
        throw error;
      }
      return this.getState();
    }

    const rawState = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    let needsSave = false;
    try {
      parsed = JSON.parse(rawState);
      const normalized = normalizeStoredState(parsed);
      parsed = normalized.state;
      needsSave = normalized.changed;
      if (!hasValidStateShape(parsed)) {
        throw new Error('存档结构不完整或版本不受支持');
      }
    } catch (error) {
      return this.recoverCorruptState(error);
    }

    this.state = parsed;
    this.recovery = null;
    if (needsSave) this.save();
    return this.getState();
  }

  recoverCorruptState(error) {
    let backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = `${this.filePath}.corrupt-${Date.now()}-${suffix}`;
      suffix += 1;
    }

    fs.renameSync(this.filePath, backupPath);
    const recoveredState = createInitialState(this.options);
    this.recovery = {
      reason: `存档无法读取，已备份为 ${path.basename(backupPath)}：${error.message}`
    };
    try {
      this.state = recoveredState;
      this.save();
    } catch (saveError) {
      this.state = null;
      throw saveError;
    }
    return {
      ...this.getState(),
      recovery: structuredClone(this.recovery)
    };
  }

  getState() {
    if (!this.state) this.load();
    return structuredClone(this.state);
  }

  getRecovery() {
    return this.recovery ? structuredClone(this.recovery) : null;
  }

  mutate(mutator) {
    if (!this.state) this.load();
    const previousState = this.state;
    const nextState = structuredClone(this.state);
    const result = mutator(nextState);
    nextState.updatedAt = new Date().toISOString();
    try {
      this.state = nextState;
      this.save();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    return structuredClone(result);
  }

  replace(nextState) {
    if (!this.state) this.load();
    const previousState = this.state;
    const candidate = structuredClone(nextState);
    candidate.updatedAt = new Date().toISOString();
    try {
      this.state = candidate;
      this.save();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    return this.getState();
  }

  reset(seed = Date.now()) {
    if (!this.state) this.load();
    const previousState = this.state;
    const previousRecovery = this.recovery;
    const nextState = createInitialState({ ...this.options, seed });
    nextState.revision = Number.isInteger(previousState.revision) ? previousState.revision + 1 : 1;
    try {
      this.state = nextState;
      this.save();
      this.recovery = null;
    } catch (error) {
      this.state = previousState;
      this.recovery = previousRecovery;
      throw error;
    }
    return this.getState();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
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
}

export function assertPlanningPhase(state) {
  if (state.phase !== 'planning') {
    throw new GameRuleError('本局已结束，请重新开始一局。');
  }
}
