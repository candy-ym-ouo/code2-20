import { useEffect, useMemo, useRef, useState } from 'react';
import { gameApi, savesApi } from './api.js';
import FleetPanel from './components/FleetPanel.jsx';
import LetterCard from './components/LetterCard.jsx';
import MapPanel from './components/MapPanel.jsx';
import RelationsPanel from './components/RelationsPanel.jsx';
import ReportDialog from './components/ReportDialog.jsx';
import SaveSlotBar from './components/SaveSlotBar.jsx';
import WeatherPanel from './components/WeatherPanel.jsx';

function App() {
  const [game, setGame] = useState(null);
  const [saves, setSaves] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [previewState, setPreviewState] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previewRequest = useRef(0);

  useEffect(() => {
    let active = true;
    Promise.all([gameApi.getState(), savesApi.list().catch(() => null)])
      .then(([{ state }, saveList]) => {
        if (!active) return;
        setGame(state);
        if (saveList) setSaves(saveList);
        if (state.recovery?.reason) setError(`存档已恢复：${state.recovery.reason}`);
        if (state.lastReport && state.phase !== 'planning') setReport(state.lastReport);
      })
      .catch((requestError) => active && setError(requestError.message))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  function refreshSaves() {
    savesApi.list().then(setSaves).catch(() => {});
  }

  const assignmentsKey = useMemo(() => JSON.stringify(assignments), [assignments]);
  const previewKey = game
    ? `${game.seed}:${game.revision ?? game.day}:${assignmentsKey}`
    : null;
  const preview = previewState?.key === previewKey ? previewState.data : null;

  useEffect(() => {
    if (!game || game.phase !== 'planning' || !previewKey) {
      setPreviewState(null);
      return undefined;
    }

    let active = true;
    const requestId = previewRequest.current + 1;
    previewRequest.current = requestId;
    const timer = window.setTimeout(() => {
      gameApi.preview(assignments)
        .then(({ preview: nextPreview }) => {
          if (active && previewRequest.current === requestId) {
            setPreviewState({ key: previewKey, data: nextPreview });
          }
        })
        .catch((requestError) => {
          if (!active || previewRequest.current !== requestId) return;
          setPreviewState({ key: previewKey, data: null });
          setError(requestError.message);
        });
    }, 120);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assignments, game, previewKey]);

  const openLetters = useMemo(() => {
    if (!game) return [];
    return game.letters
      .filter((letter) => letter.status === 'inbox' || letter.status === 'backlog')
      .sort((first, second) => (
        second.urgency - first.urgency ||
        first.deadlineDay - second.deadlineDay ||
        first.deadlineHour - second.deadlineHour
      ));
  }, [game]);

  const assignedIds = useMemo(() => new Set(assignments.map((assignment) => assignment.letterId)), [assignments]);
  const unassignedLetters = openLetters.filter((letter) => !assignedIds.has(letter.id));

  function assignLetter(letter, courierId) {
    setAssignments((current) => {
      const courierOrders = current
        .filter((assignment) => assignment.courierId === courierId)
        .map((assignment) => assignment.order);
      const nextOrder = courierOrders.length ? Math.max(...courierOrders) + 1 : 0;
      return [
        ...current.filter((assignment) => assignment.letterId !== letter.id),
        {
          letterId: letter.id,
          courierId,
          targetIslandId: letter.recipientIslandId,
          order: nextOrder
        }
      ];
    });
  }

  function unassignLetter(letterId) {
    setAssignments((current) => current.filter((assignment) => assignment.letterId !== letterId));
  }

  function changeTarget(letterId, targetIslandId) {
    setAssignments((current) => current.map((assignment) => (
      assignment.letterId === letterId ? { ...assignment, targetIslandId } : assignment
    )));
  }

  function moveLetter(letterId, direction) {
    setAssignments((current) => {
      const target = current.find((assignment) => assignment.letterId === letterId);
      if (!target) return current;
      const lane = current
        .filter((assignment) => assignment.courierId === target.courierId)
        .sort((first, second) => first.order - second.order);
      const index = lane.findIndex((assignment) => assignment.letterId === letterId);
      const adjacent = lane[index + direction];
      if (!adjacent) return current;

      return current.map((assignment) => {
        if (assignment.letterId === target.letterId) return { ...assignment, order: adjacent.order };
        if (assignment.letterId === adjacent.letterId) return { ...assignment, order: target.order };
        return assignment;
      });
    });
  }

  async function advanceDay() {
    if (!preview?.valid) return;
    setBusy(true);
    setError('');
    try {
      const result = await gameApi.advance(assignments, game.revision ?? 0);
      setGame(result.state);
      setReport(result.report);
      setAssignments([]);
      setPreviewState(null);
      refreshSaves();
    } catch (requestError) {
      if (requestError.status === 409) {
        try {
          const { state } = await gameApi.getState();
          setGame(state);
          setAssignments([]);
          setPreviewState(null);
        } catch {
          // 保留原始冲突提示；下一次操作或刷新会重新同步。
        }
      }
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetGame() {
    if (!window.confirm('重新开局会覆盖当前存档，确定继续吗？')) return;
    setBusy(true);
    setError('');
    try {
      const { state } = await gameApi.reset();
      setGame(state);
      setAssignments([]);
      setPreviewState(null);
      setReport(null);
      refreshSaves();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function switchSave(slotId) {
    if (!slotId || slotId === saves?.activeSlotId) return;
    setBusy(true);
    setError('');
    try {
      const saveList = await savesApi.switch(slotId);
      const { state } = await gameApi.getState();
      setSaves(saveList);
      setGame(state);
      setAssignments([]);
      setPreviewState(null);
      setReport(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function createSave() {
    const name = window.prompt('新存档的名称：', `航线 ${(saves?.slots.length ?? 0) + 1}`);
    if (name === null) return;
    setBusy(true);
    setError('');
    try {
      const created = await savesApi.create({ name: name.trim() || undefined });
      const saveList = await savesApi.switch(created.slot.id);
      const { state } = await gameApi.getState();
      setSaves(saveList);
      setGame(state);
      setAssignments([]);
      setPreviewState(null);
      setReport(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <div className="loading-orbit"><i /><i /><i /></div>
        <h1>正在接收高空电报</h1>
        <p>邮政署正在校准风向与航线数据...</p>
      </main>
    );
  }

  if (!game) {
    return (
      <main className="error-screen">
        <h1>调度台离线</h1>
        <p>{error || '无法连接到 Node.js 服务。'}</p>
        <button type="button" onClick={() => window.location.reload()}>重新连接</button>
      </main>
    );
  }

  const projection = preview?.projection;
  const deliveredCount = assignments.length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-emblem">✦</div>
          <div>
            <span>SKY ISLAND POST</span>
            <h1>浮空岛邮政调度员</h1>
          </div>
        </div>

        <div className="campaign-status">
          <div className="day-counter">
            <span>今日</span>
            <b>{String(game.day).padStart(2, '0')}</b>
            <small>/ {game.days} 日</small>
          </div>
          <div className="metric">
            <span>邮政信誉</span>
            <strong>{game.reputation}</strong>
            <div className="metric-track"><i style={{ width: `${Math.max(0, Math.min(100, game.reputation))}%` }} /></div>
          </div>
          <div className="metric">
            <span>可用邮资</span>
            <strong>{game.credits}</strong>
            <small>枚</small>
          </div>
          <div className="metric compact-metric">
            <span>连续无差错</span>
            <strong>{game.streak}</strong>
            <small>日</small>
          </div>
        </div>

        <SaveSlotBar saves={saves} busy={busy} onSwitch={switchSave} onCreate={createSave} />

        <button type="button" className="reset-button" onClick={resetGame} disabled={busy}>重新开局</button>
      </header>

      {error && (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>关闭</button>
        </div>
      )}

      <main className="dashboard">
        <div className="overview-column">
          <MapPanel game={game} preview={preview} />
          <div className="overview-split">
            <WeatherPanel wind={game.wind} />
            <RelationsPanel game={game} relationChanges={projection?.relationChanges} />
          </div>
        </div>

        <div className="planning-column">
          <section className="panel inbox-panel" aria-labelledby="inbox-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">待处理电报</p>
                <h2 id="inbox-title">今日邮件 <b>{openLetters.length}</b></h2>
              </div>
              <span className="inbox-progress">{deliveredCount} 封已装载</span>
            </div>

            <div className="inbox-list">
              {unassignedLetters.length === 0 ? (
                <div className="inbox-empty">
                  <span>✓</span>
                  <h3>所有邮件都已装载</h3>
                  <p>检查下方航线并执行当日调度。</p>
                </div>
              ) : unassignedLetters.map((letter) => (
                <LetterCard key={letter.id} letter={letter} islands={game.islands}>
                  {letter.status === 'backlog' && <span className="backlog-tag">已积压 {Math.max(0, game.day - letter.day)} 日</span>}
                  <div className="assign-buttons">
                    {game.couriers.map((courier) => (
                      <button key={courier.id} type="button" disabled={busy} onClick={() => assignLetter(letter, courier.id)}>
                        <i style={{ background: courier.color }} />
                        {courier.name}
                      </button>
                    ))}
                  </div>
                </LetterCard>
              ))}
            </div>
          </section>

          <FleetPanel
            game={game}
            assignments={assignments}
            preview={preview}
            busy={busy}
            onMove={moveLetter}
            onUnassign={unassignLetter}
            onChangeTarget={changeTarget}
          />
        </div>
      </main>

      <aside className="dispatch-dock">
        <div className="dock-projection">
          <div>
            <span>预计信誉</span>
            <b className={(projection?.reputationDelta || 0) >= 0 ? 'positive' : 'negative'}>
              {(projection?.reputationDelta || 0) > 0 ? '+' : ''}{projection?.reputationDelta || 0}
            </b>
          </div>
          <div>
            <span>预计邮资</span>
            <b className={(projection?.creditsDelta || 0) >= 0 ? 'positive' : 'negative'}>
              {(projection?.creditsDelta || 0) > 0 ? '+' : ''}{projection?.creditsDelta || 0}
            </b>
          </div>
          <div>
            <span>延误 / 误投</span>
            <b>{projection?.late || 0} / {projection?.wrong || 0}</b>
          </div>
          <div>
            <span>未安排</span>
            <b>{unassignedLetters.length}</b>
          </div>
        </div>
        <div className="dock-actions">
          <button type="button" className="clear-button" disabled={busy || assignments.length === 0} onClick={() => setAssignments([])}>
            清空方案
          </button>
          <button
            type="button"
            className="dispatch-button"
            disabled={busy || !preview?.valid}
            onClick={advanceDay}
          >
            {busy ? '航线结算中...' : '执行当日调度'}
            <span>{preview?.valid ? '所有航线检查通过' : '先修正调度方案'}</span>
          </button>
        </div>
      </aside>

      <ReportDialog report={report} onClose={() => setReport(null)} />

      {!report && game.ending && (
        <div className="ending-screen">
          <div className={`ending-card ${game.ending.type}`}>
            <p className="eyebrow">十四日航线总报</p>
            <span className="ending-rank">{game.ending.rank}</span>
            <h2>{game.ending.title}</h2>
            <p>{game.ending.message}</p>
            <div className="ending-stats">
              <div><b>{game.reputation}</b><span>最终信誉</span></div>
              <div><b>{game.credits}</b><span>剩余邮资</span></div>
              <div><b>{game.averageRelation}</b><span>关系均值</span></div>
            </div>
            <button type="button" onClick={resetGame} disabled={busy}>开启新一轮</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
