# Strict cancelled lifecycle reclamation fix

## 实施摘要

- 根因：取消 cleanup blocker 的成功替代子查询仅核对 thread、`lifecycle.rootThreadId` 和 `lifecycle.revision`，没有核对 `effect_type`。因此同代的 `provider-session.detach` 会错误替代 `attachment.cleanup`。
- 修复：在 `ThreadDataReclamation.ts` 中要求 `succeeded_cleanup.effect_type = cleanup.effect_type`。物理删除谓词、lifecycle barrier 保留和 receipt 引用保护均未修改。
- 测试：保留 standalone cancelled blocker、同 root/revision/effect 成功替代正例、revision 负例；新增 rootThreadId、effect_type 负例，以及携带 accepted deletion receipt、但无 lifecycle payload 的 cancelled deletion barrier 保护用例。既有大 closure 与其他回收覆盖保留。

## 验证

- Focused 测试：尝试 `cd apps/server && vp test run src/orchestration-v2/ThreadDataReclamation.test.ts`，未能启动：环境中没有 `vp`（`vp: command not found`），依赖目录缺失；未安装依赖。
- Node TS 语法检查：`node --experimental-strip-types --check apps/server/src/orchestration-v2/ThreadDataReclamation.ts` 与对应 `.test.ts` 均退出码 0。
- SQLite predicate smoke check：通过。相同 root/revision/effect 的 succeeded 行解除 blocker；不同 root、revision、effect，以及 standalone cancelled 行均阻塞；无 lifecycle payload 的 cancelled 行在关联 accepted deletion receipt 存在时仍阻塞，即使存在同代同类型的 lifecycle succeeded 行。
- `git diff --check`：通过。

## 范围与注意事项

仅修改 `ThreadDataReclamation.ts`、`ThreadDataReclamation.test.ts` 和本报告；未安装依赖，未修改 hook 配置，未扩展物理删除范围。Focused Vitest 未运行，因此测试文件只完成 Node 语法检查及等价 SQLite 谓词 smoke 验证。
