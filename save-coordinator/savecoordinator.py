"""
多存档调度协调器 (Multi-Save Scheduling Coordinator)
=====================================================

能力：
  1. 切换     —— 多个"局"(slot) 之间切换 active slot，旧局不冻结，仍可后台写入
  2. 隔离     —— slot 之间目录 / 版本链 / 串行化队列完全隔离
  3. 并发写入 —— 不同 slot 的写操作真并行（每 slot 一个 actor + 一把文件锁）
  4. 同局串行 —— 指向同一 slot 的全部写操作进入同一队列，按序提交
  5. 冲突不覆盖 —— 乐观并发控制：base 过期时不覆盖旧版本，而是产生一条
                  可恢复的分叉版本，slot 进入 CONFLICT，直到显式 resolve

仅依赖 Python 标准库 (>=3.9)。
"""

from __future__ import annotations

import asyncio
import dataclasses
import fcntl
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional


# --------------------------------------------------------------------------- #
# 数据模型
# --------------------------------------------------------------------------- #

@dataclasses.dataclass(frozen=True)
class Version:
    """一个不可变版本。版本之间通过 parents 形成 DAG（线性链或分叉链）。"""
    id: str
    slot: str
    parents: tuple[str, ...]
    blob: str                      # 内容寻址存储中的对象 id
    kind: str                      # 'save' | 'restore' | 'merge'
    writer: str
    timestamp: float
    message: str = ""

    def to_dict(self) -> dict:
        d = dataclasses.asdict(self)
        d["parents"] = list(self.parents)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Version":
        return cls(
            id=d["id"], slot=d["slot"],
            parents=tuple(d.get("parents", [])),
            blob=d["blob"], kind=d.get("kind", "save"),
            writer=d.get("writer", "anon"),
            timestamp=d["timestamp"], message=d.get("message", ""),
        )


@dataclasses.dataclass
class Manifest:
    """每个 slot 的可变状态（单写者：该 slot 的 actor）。"""
    slot: str
    tip: Optional[str] = None             # 主线最新版本
    candidate: Optional[str] = None       # 冲突时保留的分叉版本（可恢复）
    versions: dict = dataclasses.field(default_factory=dict)  # id -> Version
    epoch: int = 0                        # 每次提交自增（ fencing token 雏形）

    def to_dict(self) -> dict:
        return {
            "slot": self.slot,
            "tip": self.tip,
            "candidate": self.candidate,
            "epoch": self.epoch,
            "versions": {vid: v.to_dict() for vid, v in self.versions.items()},
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Manifest":
        m = cls(slot=d["slot"], tip=d.get("tip"),
                candidate=d.get("candidate"), epoch=d.get("epoch", 0))
        m.versions = {vid: Version.from_dict(vd)
                      for vid, vd in d.get("versions", {}).items()}
        return m


class SlotState:
    ACTIVE = "ACTIVE"
    CONFLICT = "CONFLICT"


# 特殊 base 标记：
#   BASE_CURRENT —— 不做乐观并发检查，直接续在当前 tip 之后
#   BASE_EMPTY   —— 断言该 slot 为空（首个版本），否则冲突
BASE_CURRENT = object()
BASE_EMPTY = None


class CommitError(Exception):
    """提交期错误的公共基类。"""


class ConflictError(CommitError):
    """base_version 已过期：主线已有更新版本。分叉版本已被保留。"""
    def __init__(self, msg: str, candidate: str, current_tip: str):
        super().__init__(msg)
        self.candidate = candidate
        self.current_tip = current_tip


class SlotInConflictError(CommitError):
    """slot 处于 CONFLICT 状态，普通写入被拒绝（必须先 resolve）。"""
    def __init__(self, msg: str, candidate: str):
        super().__init__(msg)
        self.candidate = candidate


# --------------------------------------------------------------------------- #
# 工具函数
# --------------------------------------------------------------------------- #

def _now() -> float:
    return time.time()


def atomic_write_text(path: Path, text: str) -> None:
    """同目录 tmp + fsync + rename，保证原子落盘。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _dir_lock(lock_path: Path):
    """返回一把以 flock 支撑的进程间互斥锁（阻塞获取）。"""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    f = open(lock_path, "a+")
    fcntl.flock(f.fileno(), fcntl.LOCK_EX)
    return f


# --------------------------------------------------------------------------- #
# 存储层：内容寻址 blob + 每 slot 清单 + 隔离区
# --------------------------------------------------------------------------- #

class VersionStore:
    """
    磁盘布局（slot 之间目录级完全隔离）：
      <root>/registry.json                        {active, slots:[...]}
      <root>/slots/<slot>/manifest.json           该 slot 的版本 DAG 与 tip/candidate
      <root>/slots/<slot>/lock                    进程间串行化锁
      <root>/slots/<slot>/head.json               当前检出快照（读取走这里）
      <root>/slots/<slot>/objects/<ab>/<sha>      内容寻址 blob（slot 内去重）
      <root>/slots/<slot>/quarantine/<sha>        崩溃恢复时发现的游离 blob
    """

    def __init__(self, root: os.PathLike | str):
        self.root = Path(root)
        self.slots_dir = self.root / "slots"
        self.registry_path = self.root / "registry.json"

    # ---- 初始化 / 恢复 --------------------------------------------------- #

    def bootstrap(self) -> list[str]:
        """确保目录存在并执行崩溃恢复，返回恢复日志。"""
        log: list[str] = []
        self.slots_dir.mkdir(parents=True, exist_ok=True)
        if not self.registry_path.exists():
            atomic_write_text(
                self.registry_path, json.dumps({"active": None, "slots": []})
            )
            log.append("初始化空注册表")
        # 启动扫描（每个 slot 只扫自己的对象库，跨 slot 互不影响）：
        # manifest 引用之外的 blob 移入本 slot 隔离区（不删除，可手工捞回）
        for slot in self.list_slots():
            manifest = self.read_manifest(slot)
            referenced = {v.blob for v in manifest.versions.values()}
            for blob in self._all_blobs(slot):
                if blob not in referenced:
                    log.append(f"slot[{slot}] 游离对象 {blob.split('/')[-1][:10]}"
                               f"… -> 隔离区")
                    self._quarantine(slot, blob)
        return log

    def _all_blobs(self, slot: str) -> list[str]:
        base = self.objects_dir(slot)
        if not base.exists():
            return []
        out = []
        for sub in base.iterdir():
            if sub.is_dir():
                out.extend(f"{sub.name}/{p.name}" for p in sub.iterdir()
                           if not p.name.startswith("."))
        return out

    def _quarantine(self, slot: str, blob: str) -> None:
        qdir = self.slot_dir(slot) / "quarantine"
        qdir.mkdir(parents=True, exist_ok=True)
        src = self.objects_dir(slot) / blob
        if src.exists():
            shutil.move(str(src), str(qdir / blob.replace("/", "_")))

    # ---- 注册表 ---------------------------------------------------------- #

    def read_registry(self) -> dict:
        return json.loads(self.registry_path.read_text(encoding="utf-8"))

    def write_registry(self, data: dict) -> None:
        atomic_write_text(self.registry_path, json.dumps(data, indent=2))

    def list_slots(self) -> list[str]:
        if not self.slots_dir.exists():
            return []
        return sorted(p.name for p in self.slots_dir.iterdir() if p.is_dir())

    # ---- manifest / head ------------------------------------------------- #

    def slot_dir(self, slot: str) -> Path:
        return self.slots_dir / slot

    def manifest_path(self, slot: str) -> Path:
        return self.slot_dir(slot) / "manifest.json"

    def read_manifest(self, slot: str) -> Manifest:
        path = self.manifest_path(slot)
        if not path.exists():
            return Manifest(slot=slot)
        return Manifest.from_dict(json.loads(path.read_text(encoding="utf-8")))

    def _write_manifest(self, manifest: Manifest) -> None:
        """单写者：调用前必须已持有该 slot 的 flock。"""
        manifest.epoch += 1
        atomic_write_text(self.manifest_path(manifest.slot),
                          json.dumps(manifest.to_dict(), indent=2))

    def read_head(self, slot: str) -> Optional[dict]:
        path = self.slot_dir(slot) / "head.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_head(self, slot: str, version: Version, snapshot: dict) -> None:
        payload = {"version": version.id, "epoch_version": version.id,
                   "writer": version.writer, "timestamp": version.timestamp,
                   "snapshot": snapshot}
        atomic_write_text(self.slot_dir(slot) / "head.json",
                          json.dumps(payload, indent=2))

    # ---- blob（每 slot 独立的内容寻址库） ------------------------------- #

    def objects_dir(self, slot: str) -> Path:
        return self.slot_dir(slot) / "objects"

    def put_blob(self, slot: str, data: bytes) -> str:
        import hashlib
        sha = hashlib.sha256(data).hexdigest()
        base = self.objects_dir(slot)
        sub = base / sha[:2]
        sub.mkdir(parents=True, exist_ok=True)
        obj = sub / sha
        if not obj.exists():
            fd, tmp = tempfile.mkstemp(dir=str(sub), prefix=".tmp-")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, obj)
        return f"{sha[:2]}/{sha}"

    def get_blob_bytes(self, slot: str, blob: str) -> bytes:
        return (self.objects_dir(slot) / blob).read_bytes()

    def snapshot_of(self, version: Version) -> dict:
        return json.loads(
            self.get_blob_bytes(version.slot, version.blob).decode("utf-8"))

    # ---- 提交（均在 actor 线程 + flock 临界区内执行） -------------------- #

    def _next_vid(self, manifest: Manifest) -> str:
        return f"v{len(manifest.versions) + 1}"

    def commit_save(self, slot: str, snapshot: dict, *,
                    base_version, writer: str, message: str,
                    on_conflict: str) -> Version:
        """
        乐观并发提交。base_version 三种取值：
          BASE_CURRENT : 不检查，直接续在当前 tip 之后（无 OCC 的盲写）
          BASE_EMPTY   : 断言 slot 为空（仅首版本合法）
          具体版本 id   : 必须等于当前 tip，否则判定冲突

        冲突时：
          * 'fork'（默认）: 新版本挂在过期 base 之下，作为 candidate 保留，
                            主线 tip 不动 —— 旧数据永不被覆盖，随时可恢复
          * 'discard': 拒绝提交（不产生任何新版本）
        """
        lock = _dir_lock(self.slot_dir(slot) / "lock")
        try:
            m = self.read_manifest(slot)
            if m.candidate is not None:
                raise SlotInConflictError(
                    f"slot[{slot}] 处于 CONFLICT，请先 resolve(candidate="
                    f"{m.candidate})", candidate=m.candidate)

            if base_version is not BASE_CURRENT and base_version is not BASE_EMPTY:
                if base_version not in m.versions:
                    raise CommitError(f"未知的 base_version: {base_version}")

            if base_version is BASE_CURRENT:
                conflict = False
                parents = (m.tip,) if m.tip else ()
            elif base_version is BASE_EMPTY:
                conflict = m.tip is not None
                if conflict:
                    # 等价于对空局断言失败
                    base_for_fork = m.tip
                parents = ()
            else:
                conflict = m.tip is not None and base_version != m.tip
                parents = (base_version,)

            if conflict and on_conflict == "discard":
                raise ConflictError(
                    f"提交冲突：base={base_version} 已过期，当前 tip={m.tip}",
                    candidate=m.tip, current_tip=m.tip)

            blob = self.put_blob(slot, json.dumps(
                snapshot, ensure_ascii=False, sort_keys=True).encode("utf-8"))
            v = Version(id=self._next_vid(m), slot=slot,
                        parents=parents,
                        blob=blob, kind="save", writer=writer,
                        timestamp=_now(), message=message)
            m.versions[v.id] = v

            if conflict:
                m.candidate = v.id          # 保留分叉，不覆盖 tip
                self._write_manifest(m)
                raise ConflictError(
                    f"提交冲突：base=EMPTY 已过期；分叉版本 {v.id} 已保留，"
                    f"主线仍为 {m.tip}",
                    candidate=v.id, current_tip=m.tip)

            m.tip = v.id
            self._write_manifest(m)
            self._write_head(slot, v, snapshot)
            return v
        finally:
            lock.close()

    def commit_resolve(self, slot: str, *, decision: str,
                       writer: str, merged_snapshot: Optional[dict] = None,
                       message: str = "") -> Version:
        """
        消解 CONFLICT：
          decision='mine'      采用分叉 candidate（旧 tip 仍在版本链里）
          decision='theirs'    放弃分叉，直接指向当前 tip
          decision='merge'     以调用方提供的合并快照产生 merge 版本（双父）
        """
        lock = _dir_lock(self.slot_dir(slot) / "lock")
        try:
            m = self.read_manifest(slot)
            if m.candidate is None:
                raise CommitError(f"slot[{slot}] 没有待消解的冲突")
            cand, tip = m.versions[m.candidate], m.versions[m.tip]

            if decision == "theirs":
                chosen = tip
                snapshot = self.snapshot_of(tip)
                parents = (tip.id, cand.id)
            elif decision == "mine":
                chosen = cand
                snapshot = self.snapshot_of(cand)
                parents = (tip.id, cand.id)
            elif decision == "merge":
                if merged_snapshot is None:
                    raise CommitError("merge 需要提供 merged_snapshot")
                blob = self.put_blob(slot, json.dumps(
                    merged_snapshot, ensure_ascii=False, sort_keys=True
                ).encode("utf-8"))
                chosen = None
                snapshot = merged_snapshot
                parents = (tip.id, cand.id)
            else:
                raise CommitError(f"未知 decision: {decision}")

            v = Version(id=self._next_vid(m), slot=slot, parents=parents,
                        blob=chosen.blob if chosen else blob,
                        kind="merge" if decision == "merge" else "save",
                        writer=writer, timestamp=_now(),
                        message=message or f"resolve:{decision}")
            m.versions[v.id] = v
            m.tip = v.id
            m.candidate = None
            self._write_manifest(m)
            self._write_head(slot, v, snapshot)
            return v
        finally:
            lock.close()

    def commit_restore(self, slot: str, version_id: str, *,
                       writer: str, message: str = "") -> Version:
        """检出任意历史版本为新版本（仅追加，原版本链不动）。"""
        lock = _dir_lock(self.slot_dir(slot) / "lock")
        try:
            m = self.read_manifest(slot)
            if m.candidate is not None:
                raise SlotInConflictError(
                    "CONFLICT 状态下禁止 restore，请先 resolve",
                    candidate=m.candidate)
            if version_id not in m.versions:
                raise CommitError(f"未知版本: {version_id}")
            src = m.versions[version_id]
            snapshot = self.snapshot_of(src)
            v = Version(id=self._next_vid(m), slot=slot,
                        parents=(m.tip,), blob=src.blob, kind="restore",
                        writer=writer, timestamp=_now(),
                        message=message or f"restore {version_id}")
            m.versions[v.id] = v
            m.tip = v.id
            self._write_manifest(m)
            self._write_head(slot, v, snapshot)
            return v
        finally:
            lock.close()


# --------------------------------------------------------------------------- #
# 调度层：每 slot 一个单消费者 actor（同局串行 / 异局并行）
# --------------------------------------------------------------------------- #

class _Job:
    def __init__(self, kind: str, kwargs: dict):
        self.kind = kind
        self.kwargs = kwargs
        self.fut: asyncio.Future = asyncio.get_event_loop().create_future()


class SlotScheduler:
    """同一 slot 的所有写操作在此队列上严格串行；阻塞 IO 在线程中执行，
    不同 slot 的线程可同时运行（异局并行）。"""

    def __init__(self, slot: str, store: VersionStore):
        self.slot = slot
        self.store = store
        self._queue: asyncio.Queue[_Job] = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self._closed = False

    def start(self) -> None:
        self._task = asyncio.create_task(self._consume(),
                                         name=f"slot-{self.slot}")

    async def _consume(self) -> None:
        while True:
            job = await self._queue.get()
            try:
                result = await asyncio.to_thread(self._dispatch, job)
                if not job.fut.done():
                    job.fut.set_result(result)
            except BaseException as exc:  # 包含 ConflictError，原样回传
                if not job.fut.done():
                    job.fut.set_exception(exc)
            finally:
                self._queue.task_done()

    def _dispatch(self, job: _Job):
        s, slot = self.store, self.slot
        if job.kind == "save":
            return s.commit_save(slot, **job.kwargs)
        if job.kind == "resolve":
            return s.commit_resolve(slot, **job.kwargs)
        if job.kind == "restore":
            return s.commit_restore(slot, **job.kwargs)
        raise RuntimeError(f"未知作业类型: {job.kind}")

    async def submit(self, kind: str, **kwargs):
        if self._closed:
            raise RuntimeError(f"slot[{self.slot}] 调度器已关闭")
        job = _Job(kind, kwargs)
        await self._queue.put(job)
        return await job.fut

    async def barrier(self) -> None:
        """等待此前提交的全部写操作完成（切换时的栅栏）。"""
        await self._queue.join()

    async def close(self) -> None:
        await self.barrier()
        self._closed = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


# --------------------------------------------------------------------------- #
# 协调器：创建 / 切换 / 会话
# --------------------------------------------------------------------------- #

class SaveCoordinator:
    def __init__(self, root: os.PathLike | str):
        self.store = VersionStore(root)
        self._schedulers: dict[str, SlotScheduler] = {}
        self.active_slot: Optional[str] = None
        self.recovery_log: list[str] = []

    # ---- 生命周期 -------------------------------------------------------- #

    async def start(self) -> "SaveCoordinator":
        self.recovery_log = self.store.bootstrap()
        reg = self.store.read_registry()
        self.active_slot = reg.get("active")
        for slot in self.store.list_slots():
            sch = SlotScheduler(slot, self.store)
            sch.start()
            self._schedulers[slot] = sch
        return self

    async def aclose(self) -> None:
        for sch in self._schedulers.values():
            await sch.close()

    # ---- slot 管理与切换 ------------------------------------------------- #

    async def create_slot(self, slot: str, *, snapshot: Optional[dict] = None,
                          writer: str = "system",
                          make_active: bool = True) -> Optional[Version]:
        if slot in self._schedulers:
            raise ValueError(f"slot 已存在: {slot}")
        self.store.slot_dir(slot).mkdir(parents=True, exist_ok=True)
        sch = SlotScheduler(slot, self.store)
        sch.start()
        self._schedulers[slot] = sch
        reg = self.store.read_registry()
        reg["slots"].append(slot)
        if make_active or reg.get("active") is None:
            reg["active"] = slot
            self.active_slot = slot
        self.store.write_registry(reg)
        if snapshot is not None:
            return await self.save(snapshot, slot=slot, writer=writer,
                                   base_version=BASE_EMPTY,
                                   message="slot 初始化")
        return None

    async def switch_slot(self, slot: str) -> None:
        """切换 active slot。旧 slot 不冻结：其队列继续消费，后台写照常提交。"""
        if slot not in self._schedulers:
            raise KeyError(f"未知 slot: {slot}")
        await self._schedulers[slot].barrier()   # 确保切换前新局已落盘
        reg = self.store.read_registry()
        reg["active"] = slot
        self.store.write_registry(reg)
        self.active_slot = slot

    # ---- 会话（OCC 句柄） ------------------------------------------------ #

    def session(self, slot: Optional[str] = None, *,
                writer: str = "player") -> "SaveSession":
        slot = slot or self.active_slot
        if slot is None:
            raise RuntimeError("尚无任何 slot")
        return SaveSession(self, slot, writer)

    async def save(self, snapshot: dict, *, slot: Optional[str] = None,
                   writer: str = "player",
                   base_version=BASE_CURRENT,
                   message: str = "",
                   on_conflict: str = "fork") -> Version:
        slot = slot or self.active_slot
        return await self._schedulers[slot].submit(
            "save", snapshot=snapshot, base_version=base_version,
            writer=writer, message=message, on_conflict=on_conflict)

    # ---- 只读视图（直接读文件，不占写队列） ------------------------------ #

    def load(self, slot: Optional[str] = None) -> Optional[dict]:
        slot = slot or self.active_slot
        head = self.store.read_head(slot)
        return head["snapshot"] if head else None

    def history(self, slot: Optional[str] = None) -> list[Version]:
        slot = slot or self.active_slot
        m = self.store.read_manifest(slot)
        return sorted(m.versions.values(), key=lambda v: v.timestamp)

    def conflict_info(self, slot: Optional[str] = None) -> Optional[dict]:
        slot = slot or self.active_slot
        m = self.store.read_manifest(slot)
        if m.candidate is None:
            return None
        return {"state": SlotState.CONFLICT, "tip": m.tip,
                "candidate": m.candidate}

    def snapshot_of_version(self, version_id: str,
                            slot: Optional[str] = None) -> dict:
        slot = slot or self.active_slot
        m = self.store.read_manifest(slot)
        return self.store.snapshot_of(m.versions[version_id])


class SaveSession:
    """
    每会话记录自己读到的版本号作为 OCC base。
    save() 时若主线已被别的会话推进，触发 ConflictError；
    默认策略 fork —— 协调器保留你的分叉版本，绝不覆盖主线。
    """

    def __init__(self, coord: SaveCoordinator, slot: str, writer: str):
        self._coord = coord
        self.slot = slot
        self.writer = writer
        head = coord.store.read_head(slot)
        self._last_version = head["version"] if head else None
        self.last_candidate: Optional[str] = None

    @property
    def base_version(self) -> Optional[str]:
        return self._last_version

    def load(self) -> Optional[dict]:
        return self._coord.load(self.slot)

    async def save(self, snapshot: dict, *, message: str = "",
                   on_conflict: str = "fork",
                   base_version: Optional[str] = "__use_cached__") -> Version:
        base = self._last_version if base_version == "__use_cached__" \
            else base_version
        try:
            v = await self._coord.save(
                snapshot, slot=self.slot, writer=self.writer,
                base_version=base, message=message,
                on_conflict=on_conflict)
            self._last_version = v.id
            self.last_candidate = None
            return v
        except ConflictError as e:
            # 记住被保留的分叉版本，便于上层展示"可恢复版本"
            self.last_candidate = e.candidate
            self._last_version = e.current_tip
            raise

    async def resolve(self, decision: str, *,
                      merged_snapshot: Optional[dict] = None,
                      message: str = "") -> Version:
        v = await self._coord._schedulers[self.slot].submit(
            "resolve", decision=decision, writer=self.writer,
            merged_snapshot=merged_snapshot, message=message)
        self._last_version = v.id
        self.last_candidate = None
        return v

    async def restore(self, version_id: str, *, message: str = "") -> Version:
        v = await self._coord._schedulers[self.slot].submit(
            "restore", version_id=version_id, writer=self.writer,
            message=message)
        self._last_version = v.id
        return v
