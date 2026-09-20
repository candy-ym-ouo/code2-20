import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { SingleSlotCoordinator } from './coordinator.js';
import { GameRuleError } from './engine.js';

function getAssignments(body) {
  if (body === undefined || body === null) {
    throw new GameRuleError('请求体必须是 JSON 对象，并提供 assignments 数组。');
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new GameRuleError('请求体必须是 JSON 对象。');
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'assignments')) {
    throw new GameRuleError('请求体必须提供 assignments 数组。');
  }
  if (!Array.isArray(body.assignments)) {
    throw new GameRuleError('assignments 必须是数组。');
  }
  return body.assignments;
}

function requestedSlot(request) {
  const slot = request.query?.slot;
  return typeof slot === 'string' && slot ? slot : undefined;
}

export function createApp({ store, coordinator, clientDist }) {
  const coord = coordinator || new SingleSlotCoordinator(store);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', async (request, response) => {
    const state = await coord.getState();
    response.json({
      ok: true,
      phase: state.phase,
      day: state.day,
      version: state.version
    });
  });

  // ---------- 多存档调度 ----------

  app.get('/api/saves', (request, response) => {
    response.json(coord.listSlots());
  });

  app.post('/api/saves', async (request, response) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body
      : {};
    const result = await coord.createSlot({ name: body.name, seed: body.seed });
    response.status(201).json(result);
  });

  app.post('/api/saves/:slotId/switch', async (request, response) => {
    response.json(await coord.switchSlot(request.params.slotId));
  });

  app.delete('/api/saves/:slotId', async (request, response) => {
    response.json(await coord.deleteSlot(request.params.slotId));
  });

  app.get('/api/saves/:slotId/versions', async (request, response) => {
    response.json({ versions: await coord.listVersions(request.params.slotId) });
  });

  app.get('/api/saves/:slotId/versions/:versionId', async (request, response) => {
    response.json({ version: await coord.getVersion(request.params.versionId, request.params.slotId) });
  });

  app.post('/api/saves/:slotId/restore', async (request, response) => {
    const state = await coord.restoreVersion(request.body?.versionId, request.params.slotId);
    response.json({ state });
  });

  // ---------- 当前（或指定）槽位的游戏操作 ----------

  app.get('/api/game', async (request, response) => {
    response.json({ state: await coord.getState(requestedSlot(request)) });
  });

  app.post('/api/game/plan/preview', async (request, response) => {
    response.json({ preview: await coord.preview(getAssignments(request.body), requestedSlot(request)) });
  });

  app.post('/api/game/day/advance', async (request, response) => {
    const { report, state } = await coord.advance(
      getAssignments(request.body),
      request.body?.expectedRevision,
      requestedSlot(request)
    );
    response.json({ report, state });
  });

  app.post('/api/game/reset', async (request, response) => {
    const requestedSeed = request.body?.seed;
    const seed = requestedSeed === undefined || requestedSeed === null || requestedSeed === ''
      ? Date.now()
      : String(requestedSeed);
    response.json({ state: await coord.reset(seed, requestedSlot(request)) });
  });

  app.use('/api', (request, response) => {
    response.status(404).json({ error: '接口不存在。' });
  });

  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next();
      response.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    response.status(statusCode).json({
      error: error.message || '服务器发生未知错误。',
      issues: error.issues || undefined,
      conflictId: error.conflictId || undefined
    });
  });

  return app;
}
