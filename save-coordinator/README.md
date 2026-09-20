# 多存档调度协调器（Multi-Save Scheduling Coordinator）

支持**切换、隔离、并发写入**的多存档协调器。核心承诺：

> 指向同一局的写操作严格串行；任何冲突都不会覆盖旧数据——输的一方
> 产生一条可恢复的分叉版本，直到玩家/系统显式消解。

仅依赖 Python 标准库（≥3.9），单文件参考实现：[`savecoordinator.py`](savecoordinator.py)。

## 一分钟速览

```python
coord = await SaveCoordinator("./saves").start()
await coord.create_slot("gameA", snapshot=initial, writer="alice")
await coord.create_slot("gameB", snapshot=initial, writer="bob",
                        make_active=False)

s1 = coord.session("gameA", writer="alice")   # 两个会话基于同一版本
s2 = coord.session("gameA", writer="carol")
await s1.save({"chapter": 2})                 # 正常提交
try:
    await s2.save({"chapter": 2, "hp": 10})   # 过期 base
except ConflictError as e:
    e.candidate    # -> 分叉版本 id：carol 的工作被完整保留，主线未动

await coord.switch_slot("gameB")              # 切换；gameA 不冻结
v = await s2.resolve("mine")                  # 或 "theirs" / "merge"
await s1.restore("v1")                        # 任意历史版本，只追加
```

运行演示：`python3 demo.py`；边界测试（含跨进程）：`python3 test_edge.py`。

## 设计模型

| 概念 | 含义 |
|---|---|
| **slot（局）** | 一个独立存档线，拥有独立目录、版本链、写队列、文件锁 |
| **session（会话）** | 一个写入者的 OCC 句柄，记住自己读到的 `base_version` |
| **version（版本）** | 不可变节点，含 `parents` 构成版本 DAG（线性链或分叉链） |
| **tip / candidate** | 主线最新版本 / 冲突时被保留的分叉版本 |
| **ACTIVE / CONFLICT** | slot 状态；CONFLICT 下拒绝普通写入，只能 `resolve` |

### 磁盘布局（slot 目录级完全隔离）

```
saves/
├── registry.json                 # active slot 指针 + slot 列表
└── slots/
    └── gameA/
        ├── manifest.json         # 版本 DAG、tip、candidate、epoch（单写者）
        ├── head.json             # 当前检出快照（读路径，原子替换）
        ├── lock                  # flock：进程间同局串行
        ├── objects/<ab>/<sha>    # 内容寻址 blob（slot 内去重）
        └── quarantine/           # 崩溃恢复发现的游离对象（隔离不删除）
```

## 五项需求如何落地

### 1. 切换（switch）

`switch_slot` 只做两件事：对目标 slot 的队列做一次 **barrier**（确保待决写已
落盘），然后原子更新 `registry.json` 的 active 指针。

- 切换**不阻塞、不冻结**旧 slot：它的 actor 继续消费队列，后台写照常提交。
- active 指针持久化，崩溃重启后自动回到上次的局。

### 2. 隔离（isolation）

- **目录隔离**：每个 slot 的 manifest、blob、锁、head、隔离区全部在
  `slots/<slot>/` 下，一个 slot 的 GC 永远碰不到另一个 slot 的数据
  （早期版本曾用全局对象库，导致跨 slot 误回收——见提交历史中的修正）。
- **版本链隔离**：版本 id（`v1, v2…`）在各 slot 内独立编号。
- **调度隔离**：每 slot 一个单消费者队列 + 一把独立 flock。
- **冲突隔离**：一个 slot 处于 CONFLICT 不影响任何其他 slot。

### 3. 并发写入 + 同局串行

```
不同 slot：  actor(A) ──to_thread── flock(A) ──┐  真正并行
             actor(B) ──to_thread── flock(B) ──┘
同一 slot：  job1 ──► job2 ──► job3             队列严格 FIFO
```

- 每个 slot 一个 asyncio actor（单消费者队列），同局写天然**全序**；
- 阻塞 IO 经 `asyncio.to_thread` 进入线程池，不同 slot 的临界区可同时执行
  （演示中两次 0.3s 异局写墙钟仅 0.31s）；
- 临界区由 `fcntl.flock` 保护，**跨进程**同样串行（见 `test_edge.py` 第 2 组）；
- 读操作直接读 `head.json`（原子 rename），不进入写队列，读写不互斥。

### 4. 冲突不覆盖——OCC + 只追加版本 DAG

提交时携带会话读取时的 `base_version`：

| base | 含义 |
|---|---|
| 具体版本 id（会话默认） | 必须等于当前 tip，否则冲突 |
| `BASE_CURRENT` | 盲写，续在 tip 后（协调器直写/系统自动存档） |
| `BASE_EMPTY` | 断言空局，仅首个版本合法 |

冲突路径（`on_conflict="fork"`，默认）：

1. 输方的快照照常写入不可变 blob，生成新版本挂在**它自己看到的 base** 之下；
2. 主线 `tip` **不动**，新版本记入 `candidate`，slot 转 CONFLICT；
3. 向输方抛 `ConflictError(candidate=…, current_tip=…)`；
4. CONFLICT 期间一切普通写入/恢复都被拒绝（防止在未决冲突上继续堆叠）。

因此"覆盖"在物理上不可能发生：所有版本只追加，blob 内容寻址不可变。

### 5. 可恢复版本（resolve / restore）

`resolve(decision, merged_snapshot=…)` 消解冲突，三种决策都产生**新**节点：

- `"mine"` —— 采用 candidate 分叉；
- `"theirs"` —— 保留主线（分叉仍在历史中）；
- `"merge"` —— 调用方提供三方合并结果，生成双父 merge 节点。

`restore(version_id)` 把任意历史版本重新检出为新版本（`kind=restore`），
父链保留全部经过，"读旧档"和"改写历史"被严格区分开。

## 崩溃一致性

- blob：临时文件写完 `fsync` 后 `rename`，原子且内容寻址——重复提交天然幂等；
- manifest / head：同目录 tmp + fsync + `os.replace` 原子替换；
- 启动 `bootstrap()` 扫描本 slot 对象库：manifest 引用之外的 blob 移入
  `quarantine/`（**从不删除**，可人工捞回）；
- 生产强化建议：在 actor 临界区增加 WAL（prepare 写日志 → 提交 manifest →
  checkpoint 清除），把"写 blob / 写 manifest"两步崩溃窗也补上；
  `manifest.epoch` 是 fencing token 雏形，可用于拒绝旧 lease 持有者的迟到提交。

## 不变量（测试覆盖）

1. 同一 slot 的提交是全序的（进程内队列 + 跨进程 flock）；
2. 任何成功提交都使 tip 沿版本 DAG 前进，历史节点不可变；
3. 冲突时输方版本必然可通过 `candidate` 找回，主线 tip 不变；
4. slot 之间无共享可变状态，单 slot 故障/冲突不外溢；
5. 重启后 registry、各 slot 的 tip/candidate/DAG 全部可重建。

## 文件说明

| 文件 | 内容 |
|---|---|
| `savecoordinator.py` | 全部实现：数据模型 / VersionStore / SlotScheduler / Coordinator / Session |
| `demo.py` | 六个场景的端到端演示 |
| `test_edge.py` | 崩溃恢复、跨进程同局冲突、跨进程异局并行 |
