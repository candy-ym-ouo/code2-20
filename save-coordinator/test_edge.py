"""边界验证：崩溃遗留对象恢复 + 跨进程文件锁串行化"""
import asyncio
import json
import shutil
import subprocess
import sys
import textwrap
import time
from pathlib import Path

from savecoordinator import SaveCoordinator, ConflictError

ROOT = Path(__file__).parent / "edge_data"


def banner(t):
    print(f"\n=== {t} ===")


async def main():
    if ROOT.exists():
        shutil.rmtree(ROOT)

    coord = await SaveCoordinator(ROOT).start()
    await coord.create_slot("s1", snapshot={"x": 1}, writer="p")
    await coord.create_slot("s2", snapshot={"x": 1}, writer="p",
                            make_active=False)
    v = await coord.save({"x": 2}, slot="s1", writer="p")
    await coord.aclose()

    # ---- 1. 模拟崩溃：在对象库里塞一个未被 manifest 引用的游离 blob ----
    banner("1. 崩溃遗留游离对象 -> 隔离区，正式数据不受影响")
    bad_dir = ROOT / "slots" / "s1" / "objects" / "ff"
    bad_dir.mkdir(parents=True, exist_ok=True)
    (bad_dir / ("f" * 64)).write_bytes(b'{"x": 999}')
    coord = await SaveCoordinator(ROOT).start()
    assert any("游离对象" in line for line in coord.recovery_log), \
        "应检测到游离对象"
    assert coord.load("s1") == {"x": 2}, "正式数据必须完好"
    quar = list((ROOT / "slots" / "s1" / "quarantine").iterdir())
    assert len(quar) == 1 and quar[0].name.startswith("ff"), quar
    print(f"  ✓ 游离对象已隔离: {quar[0].name}，s1 数据仍为 {{'x': 2}}")
    assert coord.load("s2") == {"x": 1}
    print("  ✓ s2 的对象库完全不受 s1 GC 影响")
    await coord.aclose()

    # ---- 2. 跨进程：两个进程对同一 slot、同一 base 并发提交 ----
    banner("2. 跨进程同局并发 -> flock 串行 + OCC 保留分叉")
    worker = textwrap.dedent(f"""
        import asyncio, sys
        from savecoordinator import SaveCoordinator, ConflictError
        async def run():
            c = await SaveCoordinator({str(ROOT)!r}).start()
            s = c.session("s1", writer=sys.argv[1])
            await asyncio.sleep(float(sys.argv[2]))   # 对齐并发窗口
            try:
                v = await s.save({{"x": int(sys.argv[3])}}, message="proc")
                print("OK " + v.id)
            except ConflictError as e:
                print("CONFLICT " + e.candidate)
            await c.aclose()
        asyncio.run(run())
    """)
    t0 = time.monotonic()
    ps = [
        subprocess.Popen([sys.executable, "-c", worker, "procA", "0.2", "100"],
                          stdout=subprocess.PIPE, cwd=Path(__file__).parent),
        subprocess.Popen([sys.executable, "-c", worker, "procB", "0.2", "200"],
                          stdout=subprocess.PIPE, cwd=Path(__file__).parent),
    ]
    outs = sorted(p.communicate()[0].decode().strip() for p in ps)
    dt = time.monotonic() - t0
    print(f"  进程输出: {outs}  (墙钟 {dt:.2f}s)")
    assert any(o.startswith("OK ") for o in outs) and \
           any(o.startswith("CONFLICT ") for o in outs), outs
    coord = await SaveCoordinator(ROOT).start()
    m = coord.store.read_manifest("s1")
    assert m.candidate is not None, "分叉版本必须被保留"
    print(f"  ✓ 一个提交成功，另一个的工作保留为 candidate={m.candidate}，"
          f"主线 tip={m.tip} 未被覆盖")
    print(f"  ✓ 版本总数={len(m.versions)}（含全部历史，可恢复）")
    await coord.aclose()

    # ---- 3. 跨进程异局写不互相阻塞 ----
    banner("3. 跨进程异局并发 -> 各自独立锁，并行完成")
    # 注意：s1 在上一步处于 CONFLICT，普通写入会被快速拒绝；s2 正常提交。
    # 两者锁文件不同，即使都占用 0.3s 也应并行完成。
    worker2 = textwrap.dedent(f"""
        import asyncio, sys
        from savecoordinator import (
            SaveCoordinator, ConflictError, SlotInConflictError)
        async def run():
            c = await SaveCoordinator({str(ROOT)!r}).start()
            s = c.session(sys.argv[1], writer=sys.argv[1])
            await asyncio.sleep(0.3)
            try:
                await s.save({{"by": sys.argv[1]}})
            except (ConflictError, SlotInConflictError):
                pass
            await c.aclose()
        asyncio.run(run())
    """)
    t0 = time.monotonic()
    ps = [
        subprocess.Popen([sys.executable, "-c", worker2, "s2"],
                          cwd=Path(__file__).parent),
        subprocess.Popen([sys.executable, "-c", worker2, "s1"],
                          cwd=Path(__file__).parent),
    ]
    for p in ps:
        p.wait()
    dt = time.monotonic() - t0
    print(f"  异局两进程墙钟 {dt:.2f}s（各自 sleep 0.3s）")
    assert dt < 0.55, "异局写应并行"
    print("  ✓ 不同 slot 的进程没有互相阻塞")

    print("\n全部边界验证通过 ✓")


asyncio.run(main())
