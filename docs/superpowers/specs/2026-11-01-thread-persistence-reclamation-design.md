# T3 删除线程持久化数据回收设计

## 目标

在用户显式执行离线数据库压缩时，回收已经完成阶段 1 删除流程的 T3 线程的大型持久化数据，降低数据库占用，同时保证删除标记、旧游标同步、投影重建、跨线程引用和原生会话认领规则继续正确。

## 背景

阶段 1 已经建立以下生命周期记录：

- `orchestration_v2_thread_deletions` 保存线程删除记录和删除命令身份。
- `orchestration_v2_thread_deletion_sessions` 保存被删除线程关联的原生会话身份。
- 删除流程会取消未完成运行、清理生命周期资源，并通过 `thread.deleted` 事件传播删除状态。

当前 [DatabaseMaintenance](../../apps/server/src/persistence/DatabaseMaintenance.ts) 的离线 `compact` 会独占数据库，调用 [ProjectionMaintenance](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts) 压缩冗余事件和命令回执，然后执行 `VACUUM`。现有压缩不会按已删除线程清理投影、turn-item positions、outbox 或线程历史。

本设计只处理 T3 数据库内的回收。provider 原生 transcript 的删除、归档和取消归档属于阶段 3；命令和工具输出的单条大小控制属于独立支线。

## 已选方案

扩展现有离线 `compact` 流程，增加删除线程回收步骤。

候选方案比较：

1. **离线压缩回收**：复用现有独占数据库和 `VACUUM` 流程，批次边界明确，能够在服务器停止时安全执行。选用此方案。
2. **运行中的后台回收 worker**：可以自动执行，但会与事件写入、投影读取、provider 恢复和附件清理并发，第一版需要额外的锁、租约和恢复协议。
3. **一次性数据库迁移**：适合固定历史数据迁移，但不能自然处理后续删除线程，也不具备按批次恢复能力。

第一版不设置自动时间窗口。只有用户显式执行离线 `compact` 才触发不可逆数据回收。删除记录、删除会话记录、线程 shell 和删除事件永久保留；线程正文及大型从属数据在依赖检查通过后回收。

## 持久化保留边界

以下数据永久保留：

- `orchestration_v2_thread_deletions`。
- `orchestration_v2_thread_deletion_sessions`。
- 已删除线程的 `orchestration_events` 锚点事件：`thread.created` 和 `thread.deleted`。
- 已删除线程在 `orchestration_v2_projection_threads` 中的 shell 行及 `deleted_at` 删除状态。
- 保护仍被其他线程引用的共享 provider session、native binding、附件和跨线程上下文记录。

保留 `thread.created` 与 `thread.deleted` 有两个目的：

- 旧客户端从删除前的 sequence 继续同步时，仍能收到 `thread.deleted`，不会因为历史行被删而继续显示或恢复线程。
- 投影重建可以从两个锚点恢复一个已删除线程的 shell 和删除状态，且不需要新增事件类型。

以下数据在满足回收条件后删除：

- 删除线程的非锚点 `orchestration_events`。
- 删除线程的非删除命令回执；删除命令回执及仍被保留 outbox 引用的回执继续保留。
- `orchestration_v2_projection_runs`。
- `orchestration_v2_projection_run_attempts`。
- `orchestration_v2_projection_nodes`。
- `orchestration_v2_projection_provider_threads` 和 `orchestration_v2_projection_provider_turns`。
- 未被共享 provider session 引用的删除线程 provider session 投影及 session binding 行。
- `orchestration_v2_projection_runtime_requests`。
- `orchestration_v2_projection_messages`。
- `orchestration_v2_projection_plans`。
- `orchestration_v2_projection_turn_items`。
- `orchestration_v2_projection_checkpoint_scopes` 和 `orchestration_v2_projection_checkpoints`。
- `orchestration_v2_projection_context_handoffs`。
- 只连接回收线程集合内部的 `orchestration_v2_projection_context_transfers`。
- `orchestration_v2_turn_item_positions`。
- 已 settled 的 `orchestration_v2_effect_outbox` 行。
- 仅属于回收线程且已完成生命周期清理的其他线程关联投影行。

附件文件仍由阶段 1 的 `attachment.cleanup` effect 负责删除。阶段 2 在删除消息投影前检查对应生命周期清理已经成功或明确完成，不直接复用文件系统路径进行删除。

## 回收资格

删除记录是候选线程的来源。一个线程只有同时满足以下条件才进入回收：

- 存在 `scope = 't3_only'` 的删除记录。
- 线程仍属于可识别的删除投影或删除线程闭包；只有孤立删除记录而没有可验证投影的记录不会被猜测处理。
- 该线程及其待处理的子代理删除成员不存在 `pending`、`running` 或 `failed` 的生命周期清理 outbox。
- 不存在仍需重试的 provider session detach、附件清理、terminal cleanup、preview cleanup 或 scheduled task cleanup。
- 不存在仍处于活动状态的 provider turn、runtime request、run 或 attempt。
- 所有跨线程依赖都能归入同一个待回收闭包，或者已经完成必要的上下文固化。
- 所有会被删除的 native binding、provider session 和附件都没有被存活线程引用。

如果无法证明某个依赖安全，跳过该线程及其依赖闭包，并把阻塞原因放入本次 compact 结果。第一版不通过猜测删除来换取更高回收率。

## 跨线程依赖规则

回收前建立线程引用图，至少覆盖：

- fork 的 `sourceThreadId` 和 `lineage.relationshipToParent = 'fork'`。
- 子代理父子线程关系。
- `orchestration_v2_projection_context_transfers` 的 source、target 和 pending 状态。
- promptSequence 指向的事件锚点。
- provider session、provider thread 和 native session binding 的共享身份。
- 消息和 dynamic tool turn item 中的附件引用。

独立用户 fork 仍然存活时，源线程的历史被视为外部依赖。除非已有记录证明目标线程不再读取该历史，源线程进入阻塞状态；阶段 2 不删除可能被其读取的历史数据。

一个删除闭包内的子代理线程可以与父线程一起回收。独立 fork 不因源线程删除而自动纳入回收闭包。

跨越回收边界的 context transfer 保留；source 和 target 都属于同一待回收闭包且 transfer 已终止时，transfer 行可以删除。pending transfer 会阻止涉及线程的回收。

## 执行模型

新增回收操作由 `ProjectionMaintenance` 提供，并由 `DatabaseMaintenance.compact` 调用。第一版不新增运行时 worker，也不新增持久化进度表；删除记录和现存行本身提供幂等恢复依据。

执行过程如下：

1. 在开始压缩时固定事件、命令回执和删除记录的读取上界，避免本次运行处理新写入的边界数据。
2. 分页读取删除候选，解析父子关系、引用关系和生命周期 cleanup 状态。
3. 生成通过依赖检查的回收闭包，并记录被跳过线程的阻塞原因。
4. 对每个有限大小的线程批次开启事务，按外键和引用关系要求的顺序删除从属投影、回执、outbox、positions 和非锚点事件。
5. 提交批次后释放事务；下一批继续执行。单批失败回滚该批，之前已提交的批次保留。
6. 再次执行时按相同候选规则检查剩余行，已经完成的删除不会重复产生副作用。
7. 回收完成后执行现有投影校验和 `VACUUM`，把可回收页归还给数据库文件。

单批事务必须保留锚点、删除记录和共享依赖。事务提交前不能删除能阻止重新导入的记录，也不能删除另一个存活线程仍使用的行。

## 重建和同步语义

`ProjectionMaintenance.rebuild` 需要继续支持只剩线程锚点的已删除线程：

- `thread.created` 重新建立线程 shell。
- `thread.deleted` 将 shell 标记为已删除。
- 没有从属事件时，从属投影保持为空。
- 已保留的 deletion record 和 deletion session 继续阻止 native session importer 把原生会话重新导入成新线程。
- `verify` 仍能识别保留 shell 的已删除线程，且 projection sequence 与事件高水位一致。

事件回收不得改变 sequence 的单调性。删除中间 sequence 后，旧 cursor 读取到的内容可能出现间隔，但只要 cursor 位于删除事件之前，就必须能读到 `thread.deleted`；已处理删除事件的客户端不会因缺少更早历史而重新创建线程。

## 错误和可观察性

`DatabaseMaintenance.compact` 的结果增加线程回收统计，至少包括：

- 回收线程数量。
- 删除的事件、回执、投影行、positions 和 outbox 行数量。
- 跳过线程数量。
- 按线程或依赖类别归类的阻塞原因。
- 回收后可 reclaim 的数据库字节数。

阻塞是可观察的正常结果，不把它当作数据库错误。数据库读写、事务或投影校验失败仍然终止当前 compact，并保留未提交批次的数据。

离线 compact 继续拒绝服务器或桌面应用持有数据库的情况。阶段 2 不直接针对开发者正在使用的真实用户数据库执行清理；生产清理需要单独的操作授权。

## 验收标准

1. 已删除且无外部依赖的线程，其大型投影、非锚点事件、positions、settled outbox 和非必要回执都会减少；归档线程、未删除线程和其他项目不受影响。
2. 重复执行 compact 不重复删除、不破坏统计一致性，也不会改变 deletion records。
3. 在批次之间中断后重新执行，剩余数据可以继续回收；单批事务失败不会留下半批删除状态。
4. 投影重建后，已删除线程只恢复 shell 和删除状态，不恢复已清除的消息、turn items、runs 或 provider turns。
5. 从删除前 sequence 继续同步的旧 cursor 能收到 `thread.deleted`；删除后的线程不会因重放、重启或导入扫描重新出现。
6. 存活 fork、pending context transfer、共享 provider session、共享附件和失败生命周期 cleanup 会阻止对应数据被删除，并产生明确阻塞结果。
7. `VACUUM` 或 incremental auto_vacuum 能观察到数据库文件或 freelist 的实际空间收益。
8. 现有归档语义不触发回收；归档线程只保留在既有压缩规则中。

## 不在本阶段解决的问题

- provider 原生 transcript 的物理删除、归档和取消归档。
- Claude CLI 与 T3 的持续增量同步。
- 命令和工具输出的单条持久化大小上限。
- 运行中的自动垃圾回收 worker。
- 为删除数据提供恢复或撤销能力。
