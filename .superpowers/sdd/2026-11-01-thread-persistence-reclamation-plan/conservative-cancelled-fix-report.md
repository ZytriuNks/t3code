# Conservative cancelled lifecycle cleanup fix

## 修改

- `ThreadDataReclamation.ts`：pending/running/failed cleanup 继续阻塞；cancelled cleanup 仅在同一 thread 上存在成功的 lifecycle cleanup，且 `lifecycle.rootThreadId` 与 `lifecycle.revision` 均匹配时解除阻塞。不同 revision、不同 root 或无匹配成功行仍阻塞。
- `ThreadDataReclamation.test.ts`：保留原有 `reclaims cancelled settled outbox rows but preserves lifecycle barriers`，让 cancelled 与 succeeded 行具有相同 lifecycle root/revision，并验证 thread 可回收而 lifecycle barrier 行仍保留；保留 standalone cancelled blocker 覆盖；新增不同 revision 的 succeeded 行不能解除 blocker 的测试。
- 未修改 outbox 物理删除 SQL。当前 HEAD 的大 closure 测试只覆盖分块失败/恢复，未包含 cancelled cleanup fixture；该测试保持不变，cancelled 覆盖保留在专门的 lifecycle 测试中。

## 验证

- `vp test run apps/server/src/orchestration-v2/ThreadDataReclamation.test.ts`：未能启动，环境无 `vp`（`vp: command not found`）。`pnpm` 与本地 `node_modules` 也缺失；按要求未安装依赖。
- `node --experimental-strip-types --check apps/server/src/orchestration-v2/ThreadDataReclamation.ts`：通过。
- `node --experimental-strip-types --check apps/server/src/orchestration-v2/ThreadDataReclamation.test.ts`：通过。
- Node 内置 SQLite 对 standalone cancelled、不同 revision、不同 root、同 root/revision、非 lifecycle cleanup succeeded 五种条件进行直接 SQL 检查：全部通过。
- `git diff --check`：通过。

## 自审说明

改动只涉及指定实现、对应测试与本报告。focused Vitest 结果因工具缺失未验证；其余可用检查和最终 diff 已在提交前复核。
