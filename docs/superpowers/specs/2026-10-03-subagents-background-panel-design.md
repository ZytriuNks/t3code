# 子代理与后台任务入口设计规格

## 背景

旧版侧边栏仍会把 `relationshipToParent === "subagent"` 的子代理线程作为普通对话展示。新侧边栏已经有隐藏子代理线程的逻辑，但入口不一致。当前右侧栏的 surface 启动器也没有子代理入口；仓库中虽保留过 `AgentsPanel`，但 `rightPanelStore` v14 已将 `agents` surface 移除，现有线程详情里的 `Lineage` 不能从右侧栏的 `+` 菜单进入。

## 目标

把子代理和当前线程的后台任务收拢到对话内入口：

1. 旧版侧边栏和新侧边栏都不直接列出子代理 child thread。
2. 当前对话可以从右侧栏空状态和 `+` 菜单添加 `Agents` surface。
3. `Agents` surface 列出当前对话的子代理和 `pendingBackgroundTasks`。
4. 点击子代理条目进入对应的 child thread 对话。
5. 后台任务条目回到当前对话上下文。后台任务本身只有 `taskId`、描述和类型，没有独立 `ThreadId`，因此不创建虚拟对话或新的线协议。
6. 输入框上方已有的后台任务等待提示和停止操作继续作为控制入口，`Agents` surface 只提供观察与导航。

## 非目标

- 不改变子代理派发、生命周期、后台任务派生或停止协议。
- 不为 `pendingBackgroundTasks` 创建新的 T3 thread、路由或持久化实体。
- 不删除现有对话时间线、线程详情 `Lineage` 或子代理 inline 入口。
- 不改变移动端独立导航模型；本规格针对共享 Web/桌面 Web UI，移动端是否采用相同 surface 需要单独评估。

## 用户体验

### 左侧边栏

`LegacySidebar` 和现有 `Sidebar` 使用同一条可见性规则：归档线程继续按既有规则处理，`lineage.relationshipToParent === "subagent"` 的线程从项目线程列表、搜索结果、排序和批量操作中排除。父线程和用户主动创建的 fork 继续显示。

若当前路由直接打开一个子代理线程，路由仍然可以正常渲染；它只是不会在左侧栏获得独立的普通对话条目。已有对话内的子代理链接仍然可以把用户带到该线程。

### 右侧栏入口

在右侧栏没有 surface 的 `Open a surface` 启动器中增加 `Agents`，在已有 surface 的 `+` 菜单中增加相同条目。该条目只有在当前存在可读取的 server thread 时启用；草稿线程或缺少线程详情时按现有禁用 surface 的模式显示原因。

增加 `Agents` 后，它成为普通右侧栏 tab：可以激活、关闭、通过中键关闭，并随当前线程的右侧栏状态保存。标题使用 `Agents`，图标使用现有 Bot 图标体系。

### Agents surface 内容

面板内容按两个区块展示：

- `Subagents`：使用当前线程 projection 的 subagent 记录与 child thread shell 合并展示。每行显示状态点、格式化标题、角色/模型等已有可用信息；child thread 存在时整个条目可点击，导航到 `/$environmentId/$threadId`。缺失 child shell 时保留状态但禁用导航，并显示不可用提示。
- `Background tasks`：使用当前线程 shell/projection 派生出的 `pendingBackgroundTasks`。每行显示任务描述，缺失描述时回退到 `taskId`，并以统一的 `Working` 状态表示它仍在 pending roster 中。点击该行回到当前线程上下文；不会产生新的路由或线程。面板必须保留输入框上方的 `Stop` 控制，不复制停止 mutation。

没有子代理和后台任务时，面板显示稳定的空状态；子代理或后台任务从 projection 更新时，列表应保持可读的顺序，不因为状态变化在列表中跳动。

## 数据与组件边界

### Right panel store

恢复 `agents` 为 singleton right-panel kind 和 surface：

- `RightPanelKind` 增加 `agents`。
- `RightPanelSurface` 增加 `{ id: "agents"; kind: "agents" }`。
- `singletonSurface`、surface 标题、图标、添加入口和关闭/激活逻辑支持该 kind。
- 存储版本递增；迁移逻辑不再把历史 `agents` surface 丢弃。对于旧版本已经丢弃的记录不需要恢复，新的 surface 从用户添加动作开始建立。
- `files`、`terminal`、`pull-request` 等既有 surface 行为保持不变。

### Web UI

新增一个专注于当前线程的面板组件，建议放在 `apps/web/src/components/chat/`，职责只包括：读取当前线程的 projection/shell、组合子代理与后台任务行、呈现列表和触发导航回调。它不负责修改线程状态。

`ChatView` 负责：

- 根据 `renderedRightPanelSurface.kind === "agents"` 渲染该面板。
- 将当前线程的环境、线程 id 和打开 child thread 的导航回调传入。
- 继续由现有后台任务 banner 提供 stop mutation。

`RightPanelTabs` 负责：

- 在启动器与加号菜单中提供 `Agents` action。
- 渲染 tab 标题和图标。
- 通过统一的 `onAddAgents`/surface 激活路径打开面板。

`ThreadRelationshipsPanel` 和 `V2LifecycleRow` 的现有对话内入口保留；可以复用其标题格式、状态视觉和导航辅助逻辑，但不要让 `Agents` surface 依赖详情面板是否打开。

### 旧版侧栏

将 `LegacySidebar` 的线程集合在进入项目分组、排序和状态聚合前通过共享的子代理过滤函数处理，避免只在渲染层隐藏导致搜索、计数、空状态或批量操作仍包含子代理。

## 状态与错误处理

- projection 尚未加载时，`Agents` surface 显示加载状态或空状态，不抛出异常。
- 子代理 projection 有记录但 child shell 缺失时显示条目并禁用导航。
- 后台任务描述为空时使用 `taskId`，避免出现空行。
- 当前线程没有可用的子代理或后台任务时，surface 仍可打开并显示空状态。
- Surface 从当前线程切换到另一个线程时，列表自动读取新线程数据；不跨线程复用上一个线程的行。
- 现有持久化状态若包含未知或已经删除的 surface，仍按当前迁移规则过滤；新增 `agents` 不影响其他 surface 的恢复。

## 验证标准

1. 单元逻辑测试证明旧版侧栏和新侧栏都排除子代理线程，同时保留根线程、fork 和普通线程。
2. Right panel store 测试证明 `agents` 可以添加、激活、关闭、持久化恢复，并且迁移不会误删新版本的 agents surface。
3. RightPanelTabs 测试证明空状态与 `+` 菜单都暴露 `Agents`，并正确使用可用性和禁用原因。
4. Agents surface 组件测试证明：
   - 子代理按当前线程 projection 展示并能导航到 child thread；
   - child shell 缺失时不可导航；
   - 后台任务按描述/taskId 展示；
   - 无数据时显示空状态；
   - 后台任务行不触发新的 stop mutation。
5. ChatView 的 surface 分支测试证明 `agents` surface 使用当前线程数据渲染。
6. 通过受影响 Web 测试文件、Web 类型检查和格式检查。
7. 用户授权浏览器验证后，在右侧栏空状态和 `+` 菜单分别打开 `Agents`，确认旧版侧栏不显示子代理、子代理条目可进入 child thread、后台任务条目回到当前线程上下文。

## 方案取舍

选择恢复独立 `Agents` right-panel surface，而不是继续扩展 `Lineage`，因为用户明确要求从右侧栏的 surface 启动器和 `+` 菜单进入。选择直接读取现有 projection/shell，而不是添加新的 server contract，因为子代理关系和后台任务已经通过现有数据流同步到客户端。后台任务保持当前线程资源语义，避免为没有独立对话身份的 provider task 人为创建线程。
