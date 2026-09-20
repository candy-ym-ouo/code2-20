"""
演示：多存档调度协调器的五项能力
  python3 demo.py
"""

import asyncio
import shutil
import time
from pathlib import Path

from savecoordinator import (
    SaveCoordinator, ConflictError, SlotInConflictError,
)

ROOT = Path(__file__).parent / "demo_data"


def log(t: str) -> None:
    print(f"  {t}")


def banner(t: str) -> None:
    print(f"\n=== {t} ===")


async def slow_save(session, snapshot, *, delay=0.3, message=""):
    """模拟带落盘延迟的写入，用于制造并发交错。"""
    await asyncio.sleep(delay)
    return await session.save(snapshot, message=message)


def print_history(coord, slot):
    log(f"slot[{slot}] 版本链：")
    for v in coord.history(slot):
        tag = {"save": "S", "restore": "R", "merge": "M"}.get(v.kind, "?")
        parents = ",".join(v.parents) or "-"
        print(f"      [{tag}] {v.id:>3}  parents=({parents})  "
              f"by={v.writer:<8} {v.message}")
    info = coord.conflict_info(slot)
    if info:
        log(f"  ⚠ 状态=CONFLICT  tip={info['tip']}  "
            f"可恢复分叉 candidate={info['candidate']}")
    else:
        log(f"  ✓ 状态=ACTIVE  tip={coord.store.read_manifest(slot).tip}")


async def main() -> None:
    if ROOT.exists():
        shutil.rmtree(ROOT)

    # ---------------------------------------------------------------- #
    banner("1. 建局 + 初始存档（局 A / 局 B，目录与版本链隔离）")
    # ---------------------------------------------------------------- #
    coord = await SaveCoordinator(ROOT).start()
    await coord.create_slot("gameA", snapshot={"chapter": 1, "hp": 100},
                            writer="alice")
    await coord.create_slot("gameB", snapshot={"chapter": 9, "hp": 30},
                            writer="bob", make_active=False)
    log(f"active = {coord.active_slot}")
    log(f"局 A 数据 = {coord.load('gameA')}")
    log(f"局 B 数据 = {coord.load('gameB')}（与 A 完全隔离）")

    # ---------------------------------------------------------------- #
    banner("2. 同局串行 + 冲突不覆盖：两个会话基于同一旧版本并发写")
    # ---------------------------------------------------------------- #
    s1 = coord.session("gameA", writer="alice")
    s2 = coord.session("gameA", writer="carol")
    base = s1.base_version
    log(f"两个会话都读到 base = {base}，随后并发提交……")

    r1, r2 = await asyncio.gather(
        slow_save(s1, {"chapter": 2, "hp": 90},
                  message="alice 推进到第2章"),
        slow_save(s2, {"chapter": 2, "hp": 10},
                  message="carol 的濒死分支"),
        return_exceptions=True,
    )
    log(f"alice 结果: {r1.id if not isinstance(r1, Exception) else r1}")
    if isinstance(r2, ConflictError):
        log(f"carol 结果: ConflictError —— {r2}")
        log(f"  → 主线未被覆盖，carol 的工作作为可恢复版本 "
            f"{r2.candidate} 保留")
    print_history(coord, "gameA")

    # ---------------------------------------------------------------- #
    banner("3. 异局并行：A 局写与 B 局写真正同时进行")
    # ---------------------------------------------------------------- #
    t0 = time.monotonic()
    sa = coord.session("gameA", writer="alice")   # A 仍在 CONFLICT，
    sb = coord.session("gameB", writer="bob")     # B 正常
    # A 处于 CONFLICT 时普通写入会被拒绝（防止在未决冲突上继续堆叠）
    try:
        await sa.save({"chapter": 3}, message="冲突未消解前的写入")
    except SlotInConflictError as e:
        log(f"A 局写入被拒（CONFLICT 保护）：{e}")

    # B 局不受 A 局冲突影响：两次 0.3s 的异局写并行完成
    b1, b2 = await asyncio.gather(
        slow_save(sb, {"chapter": 10, "hp": 25}, delay=0.3,
                  message="bob 第10章"),
        slow_save(coord.session("gameB", writer="dave"),
                  {"chapter": 10, "hp": 88}, delay=0.3,
                  message="dave 的并行分支"),
        return_exceptions=True,
    )
    # 注意 b2 是基于旧 base 的，也会冲突——异局并行、同局仍 OCC
    log(f"bob 提交 = {b1.id}")
    if isinstance(b2, ConflictError):
        log(f"dave 提交 = 冲突，保留分叉 {b2.candidate}（B 局同样不覆盖）")
    log(f"两次 0.3s 写入墙钟耗时 = {time.monotonic()-t0:.2f}s "
        f"（串行应为 ~0.6s，证明异局并行）")

    # ---------------------------------------------------------------- #
    banner("4. 切换：active A → B，旧局(A)不冻结")
    # ---------------------------------------------------------------- #
    await coord.switch_slot("gameB")
    log(f"active = {coord.active_slot}，load() 现在读到 = {coord.load()}")
    # 先消解 B 的冲突，演示 merge
    sb2 = coord.session("gameB", writer="bob")
    merged = await sb2.resolve(
        "merge", merged_snapshot={"chapter": 10, "hp": 56,
                                   "merged": ["bob", "dave"]},
        message="合并双方数据")
    log(f"B 局冲突已 merge 消解 -> {merged.id}（双父版本）")

    # 切回 A：A 的冲突与分叉在后台一直完好保留
    await coord.switch_slot("gameA")
    log(f"切回 A，冲突仍在：{coord.conflict_info('gameA')}")

    # ---------------------------------------------------------------- #
    banner("5. 可恢复版本：查看分叉内容，并选择恢复方式")
    # ---------------------------------------------------------------- #
    info = coord.conflict_info("gameA")
    cand_snapshot = coord.snapshot_of_version(info["candidate"], "gameA")
    log(f"分叉版本 {info['candidate']} 的内容仍可读取 = {cand_snapshot}")

    # restore 只能在冲突消解后进行（保证恢复目标唯一明确）
    # 正式消解 A：采用 carol 的分叉（mine），旧主线以父版本形式保留
    s3 = coord.session("gameA", writer="alice")
    resolved = await s3.resolve("mine", message="采用 carol 的濒死线")
    log(f"A 局 resolve(mine) -> {resolved.id}，当前数据 = {coord.load('gameA')}")
    print_history(coord, "gameA")

    # 现在可以自由 restore 到任意旧版本
    s4 = coord.session("gameA", writer="alice")
    rv = await s4.restore("v1", message="后悔了，回到第1章")
    log(f"restore -> {rv.id}（kind=restore，父链保留全部历史），"
        f"数据 = {coord.load('gameA')}")
    print_history(coord, "gameA")

    await coord.aclose()

    # ---------------------------------------------------------------- #
    banner("6. 崩溃恢复：重启协调器，状态全部从磁盘重建")
    # ---------------------------------------------------------------- #
    coord2 = await SaveCoordinator(ROOT).start()
    for line in coord2.recovery_log:
        log(f"恢复: {line}")
    log(f"重启后 active = {coord2.active_slot}")
    log(f"A 局 tip = {coord2.store.read_manifest('gameA').tip}，"
        f"版本数 = {len(coord2.history('gameA'))}")
    log(f"B 局 tip = {coord2.store.read_manifest('gameB').tip}，"
        f"数据 = {coord2.load('gameB')}")
    await coord2.aclose()

    banner("完成")
    print(f"  数据目录: {ROOT}")


if __name__ == "__main__":
    asyncio.run(main())
