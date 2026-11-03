# T3 到 Pi 的线程生命周期同步设计

## 目标

在 T3 删除线程时，将属于该线程且已确认归属的 Pi 原生会话文件一并删除，并保留可重试、可观察、不会误删共享会话的执行语义。

本设计是阶段 3“后端生命周期同步”的第一个 provider 增量。首轮只实现 `T3 -> Pi` 的删除同步，不实现 Pi 到 T3 的反向同步。

## 范围

第一版包含：

- T3 `thread.delete` 生成持久化的 Pi 原生会话删除 effect。
- 按保存的 provider instance 和 canonical session identity 执行删除。
- 删除前停止并确认 T3 管理的 Pi runtime 不再使用该文件。
- 保护被其他线程引用的共享 session file。
- 对文件不存在、进程重启、临时文件系统错误和重复执行提供幂等或重试语义。
- 保留 T3 删除记录和 deletion session tombstone，阻止后续扫描重新导入会话。
- 通过现有生命周期 cleanup 状态暴露 pending 和 failed 结果。

第一版不包含：

- Pi 原生 archive/unarchive。Pi 当前没有与 Codex 对等的原生接口，T3 归档和取消归档只改变 T3 状态并保留 session file。
- Pi CLI 或其他进程删除会话后反向更新 T3。
- Pi session 目录、settings、扩展、日志或其他文件的递归清理。
- Codex 或 Claude 的生命周期同步。
- T3 持久化数据回收和 Claude 持续会话同步。
- 新数据库迁移、自动保留窗口或后台垃圾回收 worker。

## 背景和现状

Pi 的 provider thread 使用 session file 路径作为原生身份：

- `nativeThreadRef.nativeId` 是 Pi session file 路径；
- `nativeStorage.canonicalRoot` 是经 canonicalize 后的 session 目录；
- `nativeStorage.canonicalFile` 是经 canonicalize 后的 session file；
- Pi adapter 通过 `switch_session` 和 `get_state` 恢复已有文件；
- Pi provider session 不支持多个 provider thread 共用同一个 runtime；
- 现有 T3 生命周期会生成 `provider-session.detach`，并在删除时保留 `orchestration_v2_thread_deletions` 和 `orchestration_v2_thread_deletion_sessions`。

Pi RPC 本身没有一个可以替代文件删除的稳定 `session/delete` 接口。因此 provider 操作必须由 Pi adapter 按已确认的 canonical file identity 执行，不能由通用生命周期计划直接进行文件系统 I/O。

## 设计原则

1. **事件先于副作用**：T3 删除事件和 effect outbox 意图先提交，文件删除在 effect worker 中执行。
2. **身份优先于路径**：只使用删除记录和 provider projection 中已保存的 canonical identity，不根据当前 Pi 配置、当前工作目录或当前选中的 provider 推断路径。
3. **删除不猜测**：无法证明文件、实例和线程归属时阻止删除。
4. **单文件边界**：只删除目标 regular file，不递归删除目录，不清理旁路文件。
5. **Tombstone 永久保留**：即使原生文件删除成功，T3 deletion record 和 deletion session 仍然保留；当前 native binding 行是否物理回收由阶段 2 决定，但不能先删除阻止重新导入所需的 deletion session。
6. **T3 状态不回滚**：provider 删除失败不会回滚 T3 的逻辑删除；失败通过生命周期 cleanup 状态暴露，并允许重新发起删除命令重试。
7. **效果可重放**：文件已不存在视为成功；进程重启后未完成的 effect 继续由 outbox 恢复。

## 方案比较

### 方案 A：在生命周期计划中直接删除文件

不采用。`ThreadLifecyclePlan` 必须保持纯规划，不能执行文件系统 I/O，也无法自然利用 effect worker 的租约和重试。

### 方案 B：增加通用 provider-thread delete effect，由 Pi adapter 执行

采用。生命周期计划只固化删除意图和身份快照；effect executor 按 provider instance 找到 Pi adapter，由 adapter 负责 provider-specific 的路径和文件操作。这样后续 Codex 或其他 provider 可以复用生命周期 effect 边界，而不会把 provider 路径逻辑放进 orchestration。

### 方案 C：由 Pi runtime 处理删除

不单独采用。Pi runtime 可能已经被 `provider-session.detach` 关闭，且删除必须在确认没有其他 T3 runtime 使用文件后执行。删除能力放在 adapter 的 provider-level native operation 上，runtime 只负责运行中的会话。

## 架构

### 1. 生命周期计划

扩展 `ThreadLifecyclePlan`：

- 只对 `thread.delete` 生成 Pi 删除 effect；
- 从被删除成员的 provider thread 记录读取 `driver`、`providerInstanceId`、`providerThreadId`、`nativeThreadRef` 和 `nativeStorage`；
- 只把 Pi provider thread 纳入 Pi effect；
- 对同一个 canonical file 在一个生命周期命令中去重；
- effect payload 固化目标线程集合和原生身份快照，避免后续 projection 变化后无法确定删除对象；
- effect 使用 operation root thread 作为 outbox thread scope，确保级联删除的 Pi file cleanup 可以由同一个生命周期命令观察；
- 现有 `provider-session.detach` 仍由每个成员线程生成，Pi 文件删除 effect 在其后加入计划。执行器还必须重新检查 runtime 状态，不能只依赖 effect 入队顺序。

如果 provider thread 没有 native identity：

- 没有可删除的原生会话时不生成删除 effect；
- 如果存在 native id 但 storage 未解析，生成一个带 blocked identity 的删除 effect，使失败进入现有 cleanup 统计，而不是静默声称 provider 已同步。

### 2. Outbox effect

新增 `provider-thread.delete` effect request。payload 至少包含：

- `driver: "pi"`；
- `providerInstanceId`；
- `providerThreadId`；
- 删除闭包内的 `threadIds`；
- `nativeId`；
- `nativeStorage`，包括 `canonicalRoot` 和 `canonicalFile` 或 unresolved reason；
- 生命周期 revision/source；
- operation root thread id。

该 effect：

- 加入 `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS`；
- 加入 `listLifecycleCleanup` 查询；
- 受生命周期 outbox prune 保护，直到对应生命周期操作不再需要诊断；
- 使用 deterministic effect id，避免相同命令重复生成同一文件删除操作；
- 复用现有 worker 的 lease、retry、failed 和 succeeded 状态；
- 不新增表或迁移。

### 3. 执行服务和 adapter 边界

新增一个 orchestration 层的 provider thread lifecycle 执行入口，由 effect executor 调用。它负责：

1. 按 payload 中的 `providerInstanceId` 从 `ProviderAdapterRegistryV2` 获取 adapter；
2. 验证当前 T3 线程和删除闭包仍满足生命周期 revision；
3. 从 projection 和 native binding 表重新检查目标 file 的所有引用；
4. 检查所有关联的 T3 provider session 是否仍有 live runtime；
5. 将已确认的 native identity 传给 Pi adapter 的 provider-level delete 能力；
6. 将 provider-specific 错误区分为可重试错误和安全阻塞错误。

扩展 `ProviderAdapterV2`，增加可选的 provider-level native delete 能力。Pi adapter 实现该能力，通用 adapter 默认不提供。

Pi adapter 的删除能力只接受已经 canonicalize 的 identity，并执行以下检查：

- canonical file 非空且为绝对路径；
- canonical file 位于 canonical root 下；
- canonical file 不是 root 本身；
- 目标路径当前是 regular file，或已经不存在；
- 不接受目录递归删除；
- 文件不存在时返回成功；
- 权限、I/O 或路径状态不确定时返回错误，不记录原始路径或文件内容到用户可见错误。

### 4. runtime 停止顺序

现有删除生命周期会先提交并执行 `provider-session.detach`。Pi provider session 不支持多个 provider thread，因此正常情况下最后一个绑定解除后 Pi 进程会被关闭。

文件删除 effect 仍不假设 detach 一定完成。执行前必须检查：

- 目标 provider session 不再 live；
- 没有其他目标线程绑定同一个 live Pi session；
- 没有 active turn、pending background work 或正在恢复的 attachment。

如果 runtime 仍 live，effect 不进行文件删除，并进入可重试或阻塞结果。

## 共享和归属检查

删除文件前，服务必须检查以下数据来源：

- `orchestration_v2_native_session_bindings`；
- `orchestration_v2_thread_deletion_sessions`；
- `orchestration_v2_projection_provider_threads`；
- provider session projection 和 session binding；
- 当前生命周期闭包内的删除记录。

允许删除的条件是：

- 所有已知引用都属于本次删除闭包；
- 不存在存活线程引用同一个 `driver + providerInstanceId + canonicalRoot + canonicalFile`；
- 不存在闭包外的 pending context transfer 或 native binding；
- 所有关联 T3 runtime 已停止；
- identity 没有 unresolved 或 unknown provenance。

发现闭包外存活线程、未知 provenance 或共享文件时，不能删除。该结果必须保留在 effect 状态中，不能当作成功吞掉。

## 生命周期竞态

每个 effect 携带创建时的 lifecycle revision/source。执行前重新读取 T3 shell：

- 线程不再匹配删除 revision：effect 被视为 stale，不执行文件删除，并作为无副作用的已处理结果结束，不计入 provider cleanup failure；
- 线程仍是当前删除状态：继续安全检查；
- 新的生命周期操作已经提交：旧 effect 不得删除新的 incarnation；
- 线程已被删除但文件已不存在：按幂等成功处理；
- 删除命令重复发送：通过 deletion record、native binding 和 deterministic effect id 避免重复危险操作。

对于 archive/unarchive，不生成 Pi file effect，因此它们不会改变 session file，也不会触发物理删除。

## 错误和可观察性

### 可重试错误

以下错误允许现有 worker 重试：

- Pi provider instance 暂时不可用；
- provider session 尚未完成停止；
- 文件系统暂时拒绝访问；
- 数据库读取或锁竞争暂时失败。

### 安全阻塞

以下情况禁止文件删除：

- storage unresolved；
- canonical file 不在 canonical root 内；
- 目标路径是目录或类型不确定；
- 共享 live thread 或闭包外 binding；
- 当前仍有 T3-managed Pi runtime 使用该文件。

共享 live thread、闭包外 binding、unknown provenance 和 unresolved identity 属于安全阻塞。它们不会被当作成功，也不会通过猜测删除；在依赖消失后，重新发起 T3 删除命令才能重新生成该 provider cleanup effect。

安全阻塞不能转换为成功。需要根据现有 effect worker 语义保留为 failed 状态，客户端通过现有 `cleanup.pendingCount/failedCount` 得到反馈。失败详情只记录稳定的类别和计数，不把完整路径、session 内容或凭据放入日志和 wire response。

T3 删除命令本身仍返回已提交的生命周期结果，不等待 Pi 文件删除；provider cleanup 的 pending/failed 状态通过现有生命周期 cleanup 查询显示。

## 重启、重复和导入

- effect worker 进程丢失后，`provider-thread.delete` 可安全重新入队；
- 删除已完成后再次执行不产生错误；
- 删除 record 和 deletion session 永久保留；
- `NativeSessionBindings.checkImport` 继续把已删除的 Pi identity 判定为 deleted；
- Pi 文件重新出现在 session 目录时，也不能被扫描器导入为新线程；
- Projection rebuild 不需要 Pi 文件存在才能恢复已删除 T3 shell。

## 测试设计

### 生命周期计划测试

覆盖：

- Pi delete 生成一个文件删除 effect；
- archive/unarchive 不生成文件删除 effect；
- 同一 canonical file 在级联成员中只生成一个 effect；
- 未解析 storage 生成 blocked cleanup intent；
- Codex/Claude provider thread 不生成 Pi effect；
- lifecycle revision 和 operation root 正确写入 payload。

### adapter 文件操作测试

使用隔离临时目录，覆盖：

- 删除正确 canonical file；
- 文件不存在时幂等成功；
- 删除目录被拒绝；
- canonical file 越出 canonical root 被拒绝；
- symlink/path 状态不确定时不删除目标目录；
- 权限错误保留为可观察失败；
- 不触碰同目录其他 session file。

### 执行器和 outbox 测试

覆盖：

- effect 被正确 claim 和执行；
- Pi runtime live 时不删除；
- 共享 live thread、unknown provenance 和 unresolved identity 进入 failed cleanup；依赖变化后由再次发起的 T3 删除命令重试；
- 闭包外存活线程阻止删除；
- 旧 lifecycle effect 不覆盖新状态；
- worker 重启后 effect 可以继续；
- 重复 effect 幂等；
- pending/failed cleanup 统计包含 Pi 删除 effect。

### 集成测试

使用隔离数据库和临时 Pi session 文件，验证完整链路：

1. 创建带 Pi provider thread 的 T3 线程；
2. 执行 T3 delete；
3. drain effect worker；
4. 断言 session file 被删除；
5. 断言 deletion record 和 deletion session 保留；
6. 执行 importer 检查，确认不会重新导入；
7. 模拟文件删除失败，确认 T3 删除状态保留且 cleanup failed 可见；
8. 清除故障后重新发起删除，确认最终幂等完成。

测试不得连接开发者真实 Pi 数据目录，也不得启动使用真实用户配置的 Pi 进程。

## 验收标准

1. 删除 T3 Pi 线程后，唯一且已解析的 canonical session file 最终被删除。
2. archive/unarchive 保留文件，后续仍可恢复同一个 Pi session。
3. 共享 session file、未知 provenance、未解析路径和活动 runtime 不会被删除。
4. 删除 effect 具有持久化意图、重试、重启恢复和重复执行幂等性。
5. T3 deletion records、deletion sessions 和 native tombstone 不被物理文件删除影响。
6. 文件不存在视为成功，目录和越界路径始终失败。
7. provider 删除失败不会回滚 T3 逻辑删除，但会在生命周期 cleanup 状态中可观察。
8. Pi 文件删除不会影响同一目录中的其他 session、配置或扩展文件。
9. Codex、Claude 及现有非 Pi 生命周期行为保持不变。

## 后续扩展

- 为 Codex 增加原生 archive/unarchive/delete 协议同步；
- 为 Claude 增加经过 SDK 能力确认的原生删除；
- 增加手动重试 provider lifecycle cleanup 的明确入口；
- 增加 provider -> T3 外部删除同步；
- 在阶段 4 的持续同步中处理扫描、去重和删除 tombstone 的长期策略。
