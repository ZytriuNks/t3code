# PR-A/B-Alpha 提交流程（本地开发偏好）

> 本文件是 fork 维护者的本地扩展，被 `.git/info/exclude` 排除，仅在本地工作树里存在。
> 它与 `AGENTS-local/build-and-install.md` 第 6 节配套，按"构建前审验 /
> 候选打包与审验 / PR 提交合并 / 按需构建 Alpha"组织维护者的工作流。

本 fork 的三 build (`Alpha` / `Experimental` / `Dev`) 在构建时机与
源码来源上有明确区分——见 `AGENTS-local/build-and-install.md` 第 1 节
"三 build 的角色"。本文件专门描述 **PR 从开发到合入主用基线** 的
完整流程。

构建产物统一目录、Pre-release 关联 tag 命名、英文发布说明和保留策略，以
[build-and-install.md](build-and-install.md) 第 4.1、6.4 节为准。所有 worktree
共用主工作区的 `installer/`。已授权的安装包构建包含完成后的测验用 Pre-release
归档和符合规则的本地清理；仅当用户明确要求 release 时才使用正常 Release。
发布均面向 fork，构建归档不额外授权安装应用、创建或合并 PR。
安装包归档只需保留在 Pre-release 附件中；PR 所需图像、视频等证据放在对应
PR 正文或评论中，不发布到 Pre-release。关联 tag 仅用于 GitHub 发布的源码定位。

---

## 1. 工作流总览

```
① 同步上游
   ↓
② 新建分支(fork `main` 为基点)
   ↓
③ 分支内开发 → 定向检查 → 按改动类型进行构建前审验
   ↓
④ 候选稳定后构建 exp → 检查与 Pre-release 归档 → 安装包审验
   A/B 对照使用已核对的 Dev 基线包；基线变化或无可用包时再构建 Dev
   ↓
⑤ (任选其一)
   ├─ 返工 → 回到 ③
   └─ 审验通过 → PR 到 fork 仓库并合并
                  ↓
                  (可能构建 alpha) → 进入下一轮开发
```

**关键不变量**:

- **PR 目标永远是 fork 自己的仓库**,即 `origin = ZytriuNks/t3code`。
  永远 **不** 直接 PR 到上游 `pingdotgg/t3code`。上游同步只在 ① 阶段
  由 `AGENTS-local/upstream-sync.md` 处理。
- ④ 阶段构建 **Experimental**，按需构建或复用 **Dev**，不构建 Alpha。
  Alpha 仅在 ⑤ 阶段审验通过、经用户决定合并后，按明确请求构建。
- dev / exp 构建 **不** 关 Alpha 进程(详见 `AGENTS-local/build-and-install.md`
  第 5 节"日常安装流程" + 本文件第 3 节)。
- 多个 PR 一次性构建 A/B 时,可使用 **临时 build 分支**;审验完成后
  **必须删除**(本文件第 4 节)。

---

## 2. 阶段详解

### 2.1 阶段 ① 同步上游

读取 `AGENTS-local/upstream-sync.md`,按其第 2 节"同步前确定范围" +
第 3 节"合并策略" + 第 8 节"推送后的最终核对与交付" 执行。

**产出**:fork `main` 与上游 `main` 之间的 behind 归零(若有)。**注意
ahead 保留是正常状态**:`AGENTS-local/upstream-sync.md` 第 1 节明确
"fork 相对上游有 ahead commit 是正常状态,不以 `ahead = 0` 为目标"。
PR 基点更新到最新 fork `main` HEAD(基于本地 fork `main`,**不** 基于
上游 `main`)。

**跳过条件**:若 `git rev-list --left-right --count origin/main...
upstream/main` 输出 `behind = 0`(**注意是 `behind` 不是 `ahead`**),
可直接跳过阶段 ①,进入阶段 ②。这种情况通常出现在 PR 合并后的"空档
期":fork main 与 upstream main 同步且无新上游 commit。

### 2.2 阶段 ② 新建分支

在 fork `main`(或当前 fork 主用分支) 上新建 PR 分支:

```powershell
git switch main
git pull origin main  # 同步到 fork origin/main HEAD
git switch -c '<type>/<scope>-<short-desc>-<date>'
```

**分支命名约定**(本 fork 维护者偏好):

- `fix/<scope>-<short-desc>-<date>` — Bug 修复
- `feat/<scope>-<short-desc>-<date>` — 新功能
- `docs/<scope>-<short-desc>-<date>` — 文档/诊断
- `sync/<purpose>-<date>` — 上游同步专用
- `build/<purpose>-<date>` — **临时 build 分支**(本文件第 4 节)

### 2.3 阶段 ③ 分支内开发

在 PR 分支上做修改,按 `AGENTS.md` 第 4 节"目标驱动执行" 把每个
变更落到可验证的小单元。

**Commit 风格**:见 `AGENTS.md` 第 4 节 + `AGENTS-T3.md` 提交风格
(Conventional Commit + 平实语言)。

**本地验证**(本阶段按受影响范围执行,不依赖安装包构建):

- 跑受影响文件的单测:`vp test run <files>`
- 类型检查(改动点):`tsc --noEmit -p <package>/tsconfig.json`
- `vp fmt`(若修改格式)

不在此阶段跑全仓 `vp check` 或全量 typecheck，遵循 `AGENTS-T3.md` 的
"smallest proof"原则。后端行为修改须有对应定向测试；简单 UI 样式修改优先
使用现有测试及真实页面审验，不添加只复述实现的测试。

#### 2.3.1 构建前审验：按改动类型选择入口

| 改动类型 | 构建前验证 | 需要补充的客户端验证 |
|----------|------------|----------------------|
| 共享前端 UI | 默认先在 Web 开发态验证受影响入口、边界状态和交互，利用热更新迭代 | 候选稳定后的 Exp 实际窗口表现 |
| 纯后端逻辑 | 先做定向测试，再按需使用隔离的真实服务验证命令、回执、事件及持久化 | 没有可见 UI 变化时无需强制打开 Web；检查受桌面打包影响的运行路径 |
| 前后端联动 | Web 连接修改后的真实后端，核对操作、回执、事件和最终界面状态 | 受影响的桌面流程；共享契约影响原生移动端时补充移动端验证 |
| Electron / 操作系统能力 | 尽早使用 `vp run dev:desktop` 验证 IPC、预加载桥接、窗口、原生菜单等实际路径 | Exp 中对应的桌面行为 |
| 打包 / 安装 / 更新 | 按复现需要提前构建实际包，不强制 Web 先行 | 包内资源、原生依赖、渠道身份、安装与升级流程 |

- Web 审验使用 `test-t3-app` 和隔离数据。仅在实际调用 Web 审验时读取
  [web-ui-review.md](web-ui-review.md)，其中包含启动、配对、工具调用和证据保存方法。
- 按 `AGENTS-T3.md` 执行浏览器操作授权；已有的本任务授权持续有效，不反复确认。
  规则调整本身不等于授权所有未来任务使用浏览器。
- 纯后端测试等待 typed receipts / worker drains，不能以固定 sleep、HTTP 200 或
  页面能打开替代业务验证。直接写投影数据只适用于 UI 夹具，不能证明业务路径正确。
- 普通浏览器及 Electron CSS 模拟不能证明真实桌面桥接或窗口命中范围正确。
- 记录每层实际验证的源码提交、未提交改动和场景；源码变化后补测受影响部分，
  不把旧结果套用到新候选。过程记录留在任务记录或忽略的工作文件，不写进本规则。
- 用户明确要求“构建 exp”等时直接执行已授权构建及必要检查，不增加 Web 审验的
  额外确认关卡。打包故障也可提前构建复现。

### 2.4 阶段 ④ 候选稳定后构建 Exp，按需进行 Dev 对照

按 `AGENTS-local/build-and-install.md` 第 4 节"日常构建流程"及第 6.1 节
"候选稳定后构建 Experimental，按需构建或复用 Dev"。

**核心原则**(维护者实际工作流):

1. 先在开发态完成主要迭代，候选稳定后、PR 合并之前构建 Experimental。
   Dev 不含待审验 PR；源码基线、构建配置、工具链 / 依赖和平台架构匹配时可复用已有完整包，
   不匹配或没有可用包时才构建。核对依据包含源码提交，不只看版本名。
2. **不**构建 Alpha — Alpha 是 ⑤ 阶段 PR 审验通过、merge 之后才构建。
3. dev / exp 构建 **不** 关 Alpha 进程(详见本文件第 3 节)。
4. **不**直接修改 fork `main` — 本阶段完全不触碰主用分支。
5. 多 PR 共建时,使用 **临时 build 分支**(本文件第 4 节)。

**单 PR 情形**(最常见):

```
git switch '<pr-branch>'           # 切到 PR 分支
Build-Stage Experimental -OutputDir $experimentalOutputDir # 当前 PR 分支对应目录
```

仅在没有可复用的 Dev 基线包时另行执行：

```
git switch '<baseline-commit>'      # PR 合并之前的 commit,通常是 fork main HEAD
Build-Stage Dev -OutputDir (Join-Path $installerRoot 'dev') # 不含待审验 PR 的基线
```

**多 PR 情形**:见本文件第 4 节"临时 build 分支"。

上述 `Build-Stage` 使用构建指南第 4 节的函数和目录变量。每次切换 Experimental
源码分支后，重新确定该分支的 `$experimentalOutputDir`。打包结束后继续完成
构建指南第 6.4 节的校验、上传、远端核对和本地清理；Pre-release 归档不表示
A/B 审验已通过，发布说明只记录实际验证结果。

开发态可用两个隔离检出先做候选与基线对照；最终仍检查 Exp 包内身份和受影响的
打包运行行为。已验收候选的运行代码或打包配置变化后，补测并重新构建；单纯新增
PR 描述或证据不触发重打包。不承诺每个任务只构建一次。

**安装 + 启动 + 审验**:

`$experimentalInstallerPath`、`$devInstallerPath` 必须是主工作区统一目录中已核对
渠道、版本、哈希且实际存在的安装包绝对路径，不能回退到 `release/` 自动选包。

```
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Experimental -InstallerPath $experimentalInstallerPath   # 只装 exp
# 如需安装 Dev，另行调用 -Stage Dev
# 不带 -Force,因为可能误关 alpha;若 exp 在跑,手动关 exp 后再装
```

启动 Experimental 与 Dev(用户决策),跑 ③ 阶段未覆盖的"运行时"行为
对比,观察稳定性 + 用户线程 `fcde77ac-...` 之类的复现场景。

### 2.5 阶段 ⑤ 审验通过 → PR 合并

#### 2.5.1 返工

开发态或安装包审验发现问题时，回到 ③ 修复，先补充受影响的开发态验证，再在
候选稳定或用户要求时构建，不因每次细微 UI 调整都重打包。审验未通过时不推送
用于提审的 PR 分支、不创建 PR。已构建测验包仍按构建指南归档到 Pre-release，
英文说明如实记录已知问题；关联 tag 仅定位源码。再次进行安装包 / A/B 审验时，
复用本文件第 4 节临时 build 分支或单 PR 路径，并重新核对 Dev 基线是否可复用。

#### 2.5.2 审验通过

适用的开发态验证、安装包 / A/B 审验、代码评审与稳定性观察通过后：

提交最终改动或推送 PR 分支前，先按第 2.5.5 节更新 fork 功能清单。

1. **Push PR 分支到 fork `origin`**:

   ```
   git push origin <pr-branch>
   ```

2. **在 fork 仓库开 PR**(`https://github.com/ZytriuNks/t3code`):

   - **默认立场**:**不**主动开 PR。`AGENTS.md` 第 1 节"本次任务是否
     允许创建 PR、推送主分支或安装应用,以用户请求和已有授权为准;
     这些步骤不能互相推定授权" — 由用户在 fork 仓库 UI 手动开 PR
     是默认流程。
   - **用户主动授权时可由 agent 帮用户开 PR**:用户在同一会话中
     明确给出授权(例如"帮我开 PR"、"把 PR-1 开到 fork main"、
     "draft PR 提给 fork"等),agent **可以**通过 `gh pr create`
     或 fork 仓库 API 完成开 PR。按 `AGENTS.md` 第 1 节"已有授权
     应持续适用,不重复要求用户确认相同步骤",授权过一次开 PR 流程
     后,后续同类型开 PR 按相同步骤执行,不再追问。
   - **`gh` CLI 认证假设**:agent 直接调用 `gh pr create` / `gh pr
     merge` 时,**默认**用户已经在 `gh` CLI 上登录(`gh auth status`
     返回 OK,token 有效,默认仓库 `origin = ZytriuNks/t3code` 已
     `gh repo set-default`)。agent **不** 在调用前显式跑 `gh auth
     login` / `gh auth refresh` / `gh repo set-default`,也不在调用
     前主动询问"是否已登录"。**仅在** `gh` 命令返回认证错误(如
     `HTTP 401: Bad credentials`、`gh: not logged into any GitHub
     hosts`、`You are not authorized to push to this repository` 等)
     时,agent 把错误原文(含 `gh` 输出)返回给用户处理,**不** 自己
     重试登录或重新授权。按 `AGENTS.md` 第 1 节"已有授权应持续
     适用",假设用户已登录是默认;反复追问会让流程停滞。
   - **目标 base** 永远选 **fork `main`**,**不**选上游 `main`
     (`pingdotgg/t3code`)。
   - PR 标题用 Conventional Commit 风格。
   - PR body 按 `AGENTS-T3.md` 提交流程写(含验证证据)。
   - UI 修改的前后截图，以及动画 / 时序修改的短视频，直接上传到对应 PR 的
     正文或评论附件，并在 PR 正文说明场景及实际验证版本。使用 GitHub 的附件上传
     能力或 PR 编辑器上传后，核对附件可访问；不能把本地文件路径当作已上传证据。
   - PR 图像、视频等证据不存入 Pre-release / Release，也不建立证据专用发布或
     tag，不提交 PR 专用媒体到仓库。尚未创建 PR 时先保存在本次本地工作文件中。
     当前工具无法上传 PR 附件时，如实报告该步骤未完成并保留文件，不改用发布页
     代存、不声称证据已交付。构建 Pre-release 只保存安装包及构建、校验附件。
   - **不** 提交到上游 `pingdotgg/t3code`。上游同步只在阶段 ① 由
     `AGENTS-local/upstream-sync.md` 处理,阶段 ②-⑤ **不** 直接
     PR 到上游。

3. **PR 合并**:
   - **默认立场**:**不**主动 merge。`AGENTS-local/build-and-install.md`
     §6.3 节"手动合并(仅在审验通过之后)" 与 §8 节"Agent 不要自动
     合并 PR" — 由用户在 fork 仓库 UI 手动 merge 是默认流程。
   - **用户主动授权时可由 agent 帮用户 merge**:用户在同一会话中
     明确给出授权(例如"帮我 merge 这个 PR"、"按 Create a merge commit 走"、
     "以 Rebase 合并 PR-1"等),agent **可以**
     通过 `gh pr merge` 或 fork 仓库 API 完成 merge。按 `AGENTS.md`
     第 1 节"已有授权应持续适用,不重复要求用户确认相同步骤",
     授权过一次 merge 流程后,后续同类型 PR合并按相同步骤执行,
     不再追问。
   - **`gh` CLI 认证假设**(与开 PR 同一假设,见第 2 步):agent 直接
     调用 `gh pr merge` 时,**默认**用户已登录;**仅在** `gh` 命令
     返回认证错误时把错误原文返回给用户处理,**不** 自己重试登录
     或重新授权。
   - merge 方式:`Create a merge commit` / `Squash and merge` /
     `Rebase and merge`,由用户决策。Agent 在拿到授权时按用户指定
     方式 merge;若用户只说"帮我 merge"未指定方式,**默认**
     `Create a merge commit`(本 fork 维护者偏好,保留完整提交历史)。
   - merge 后，fork 的**远端** `main` 前进，本地 `main` 不会自动更新。
     下一次构建前先 `git fetch origin main`；若使用本地 `main`，在适合切换的
     干净工作区中执行 `git switch main`、`git merge --ff-only origin/main`，
     再核对 HEAD。也可以使用绑定已批准合并提交的构建工作区。
   - 对比已验收构建的源码与合并后的文件树：相同则记录等价关系；有差异则按
     实际差异补验证。CI 的 queued / pending 不能记作通过；把本地检查、用户
     验收和 CI 状态在交付说明中分别列出，不将迭代结果写入构建指导文档。

#### 2.5.3 临时 build 分支清理

若本轮使用了临时 build 分支(如 `build/exp-pi-fix-20260929`):

1. PR 全部 merge 到 fork `main` 后,临时 build 分支 **失去作用**。
2. **必须删除本地临时 build 分支**:

   ```
   git branch -D build/<purpose>-<date>
   ```

3. **不** push 临时 build 分支名到 origin，也不合入 main。构建包只归档到
   Pre-release 附件，关联 tag 定位构建源码；删除本地分支不得删除关联 tag 或附件。
4. 若临时 build 分支意外被 push,可在 fork UI 删掉:Settings →
   Branches → Delete branch。

#### 普通开发分支与安装包清理

普通开发分支的 PR 已合并，或用户明确结束、放弃该分支时，检查
`installer/experimental/<分支标识>/` 中的产物是否全部完成远端归档。
满足条件后清理该分支本地产物；存在未归档产物时保留并报告，不能因删除分支
丢失唯一安装包。临时集成分支须等待其包含的 PR 均完成且不再用于审验。
关闭对话、切换分支或分支在本地不存在，均不是清理触发条件。
Alpha / Dev 的仅留最新规则、正在进行的 Dev 对照例外及路径核对要求，统一见
构建指南第 6.4.4 节。上述清理始终保留 Pre-release、附件和其必要关联 tag。

#### 2.5.4 Alpha 构建(可选,可能跳过)

按 `AGENTS-local/build-and-install.md` 第 1 节"Alpha = 主用 baseline,
代表已审验通过、已合并、已批准的代码基线" + 第 8 节"Agent 不要自动
调用 Build-Stage Alpha",Alpha 构建 **仅在** 用户明确请求时进行。

- **构建前核对**：以用户批准的已合并提交为基线。GitHub 合并不自动更新本地
  `main`；先同步或明确绑定所选提交，再按构建指南第 4 节选择 Alpha 的独立
  版本号并设置 `T3CODE_DESKTOP_VERSION`。

  在适合切换分支的干净工作区中：

  ```powershell
  git fetch origin main
  git switch main
  git merge --ff-only origin/main
  git rev-parse HEAD
  Build-Stage Alpha -OutputDir (Join-Path $installerRoot 'alpha')
  # 产物:installer/alpha/T3-Code-T3CodeAlpha-<version>-x64.exe
  ```

  若使用独立构建工作区，核对该工作区的 HEAD 即可。快进失败或出现预期之外的
  新提交时先核对差异，不强制重置。不要通过重命名 Exp 安装包制作 Alpha。

- **包内验收**：窗口名必须为 `T3 Code (Alpha)`，应用 ID、协议及数据路径均匹配
  Alpha。侧栏在“图案”/“版本标签”模式显示 `Alpha`，“无”模式隐藏。
  Exp 审验通过不等于 Alpha 新包已验收；用户仍需在 Alpha 安装后确认。
  完整检查项见 `AGENTS-local/build-and-install.md` 第 7 节“派生表检查与产物验收”。

- **归档收尾**：按构建指南第 6.4 节发布英文测验用 Pre-release，核对远端附件后
  才清理旧 Alpha 产物。构建 Alpha 本身不授权正常 Release；仅在用户明确要求
  release 时按正常发布流程处理。

- **安装命令**:**不** 由 agent 调用 `install-fork.ps1`(原因见本文件
  第 3 节与第 5 节)。agent 仅按本文件第 5 节"Alpha 安装流程(用户
  手动)"执行:清注册表卸载项 + 提供 `.exe` 路径 + 告知用户,**用户**
  手动装入 alpha。
- **绝对禁止**:`install-fork.ps1 -Force`(模式匹配停所有 `T3 Code*`,
  会误关 alpha)。alpha 安装**绝不**走 `install-fork.ps1`。

#### 2.5.5 分支收尾：更新 fork 功能清单

新增日期：2026-10-23。

每个开发分支收尾时，**必须**核对相对 fork 主用基线新增的独立功能，并将已实现的
fork 自身功能、功能扩展及用户可感知的改进写入
[fork 功能清单](../docs/fork-features.md)。无论本轮是否创建 PR，都应完成此项；
准备提交或推送时，清单更新应包含在同一分支的最终改动中。

1. **来源与内容**：先核对功能来源，**不得**将同步上游主分支或开发分支得到的
   功能计入 fork 新增。若 fork 对上游功能另作改进，只记录这部分独立增量，
   不把同步后的兼容修复自动算作新功能。说明用途、入口、适用端、来源与限制，
   不重复粘贴提交记录或新增实现流水账。
2. **日期与排序**：使用 `YYYY-MM-DD｜功能名称` 标题，标题日期为功能或改进
   合入 fork 主用分支的北京时间日期，须依据合并或提交记录核对。条目按日期
   从新到旧排列，同日按合入顺序倒排。每个新增条目或子功能另标
   `新增日期：YYYY-MM-DD`，记录首次写入清单的北京时间日期，不与功能合入
   日期混用；修订保留原新增日期，可另注更新日期。历史日期不凭推测补写。
3. **合并状态**：尚未合并的分支新增内容须标注“待合并”，不能写成主用版本已
   提供，标题暂用开发完成日期。合并后核对实际内容，将标题改为合入日期并
   重新排序，更新状态及清单顶部的核对日期和源码基准；
   分支放弃或功能撤回时，移除相应的待合并内容。
4. **收尾检查**：核对本分支独立新增功能是否全部覆盖，来源是否准确，日期及
   倒序是否正确，入口和链接是否有效。交付说明中给出清单位置；没有新增功能时
   明确说明，无需为纯文档、
   重构或测试改动编造功能条目。

---

## 3. dev / exp 安装的安全不变量

**绝对禁止**:

- ❌ **不** 关 Alpha 进程(用户主用)。`install-fork.ps1 -Force`
  当前实现会模式匹配停所有 `T3 Code*` 进程,**可能误关 alpha**。
  本 fork 维护者的实际工作流是:
  - dev / exp 装入:**用户** 先在桌面上手动关闭 dev / exp,然后
    `install-fork.ps1 -Stage Experimental -InstallerPath $experimentalInstallerPath`(不带 `-Force`)。
  - alpha 装入:agent **不** 主动调用 `install-fork.ps1`,仅提供
    安装包(`.exe`)与"已清注册表卸载项"告知;**用户** 手动装。

按 `AGENTS.md` 第 1 节"三种伤害自己的方式" 第 1 条"绝不按模式匹配
kill PID",`install-fork.ps1 -Force` 的"模式匹配停所有 T3 Code*"
违反这条原则。本文件要求:

- dev / exp 安装时,**不** 使用 `-Force`,而是**用户**先手动关 dev / exp。
- alpha 安装时,**agent 不调用** `install-fork.ps1`,仅按本文件
  第 5 节"Alpha 安装流程"提供安装包 + 注册表清理结果。

**dev / exp 装入前的具体动作**(与 §2.4 节末尾对齐):

1. 用户在 Windows 任务管理器(或 `tasklist | grep "T3 Code
   (Experimental)\|T3 Code (Dev)"`)确认 **Experimental / Dev**
   进程存在(意味着要重装覆盖)。
2. **用户手动**结束这些进程。**绝不**让 agent 用 `Stop-Process`
   按模式匹配停 `T3 Code*`(`AGENTS.md` "三种伤害自己的方式" 第 1 条)。
3. 进程全部结束后,agent 分别跑 `install-fork.ps1 -Stage Experimental -InstallerPath $experimentalInstallerPath`
   和 `install-fork.ps1 -Stage Dev -InstallerPath $devInstallerPath`(均不带 `-Force`; `Stage` 是单值参数)。
4. 安装完成后,用户从桌面图标启动新装的 Experimental / Dev。

---

## 4. 临时 build 分支

### 4.1 何时使用

单 PR 情形下 `Build-Stage Experimental` 直接在 PR 分支上跑即可,**不**
需要临时 build 分支。这与 `AGENTS-local/build-and-install.md` §6.1
节"git switch '<pr-branch>'; Build-Stage Experimental" 的标准流程一致。

多 PR 共建 A/B 时(例如本轮同时验证 PR-1 cap 覆盖扩展 + PR-2 RPC
timing),需要把多个 PR 合并到一个 **临时 build 分支** 上跑
`Build-Stage Experimental`,因为 `Build-Stage Experimental` 是单
HEAD 命令。**这是单 PR 标准流程的偏离**,见
`docs/diagnostics/pi-provider-slow-20260925.md` §11.4 节"按
`AGENTS-local/build-and-install.md` §6 节修正"——本节是该节的展开,
不是替代。

### 4.2 临时 build 分支命名

```
build/<purpose>-<date>
```

例:`build/exp-pi-fix-20260929`。

### 4.3 临时 build 分支创建

```powershell
git switch main                              # 切到 fork main
git switch -c 'build/<purpose>-<date>'         # 建临时 build 分支
git merge --no-ff '<pr-branch-1>'              # merge PR-1
git merge --no-ff '<pr-branch-2>'              # merge PR-2
# 视情况 merge 多个 PR,直到 build 分支含所有待验证 PR

Build-Stage Experimental -OutputDir $experimentalOutputDir # 临时 build 分支对应目录
```

### 4.4 临时 build 分支生命周期

- **创建**:本节 4.3。
- **构建产物**（相对主工作区）:`installer/experimental/<分支标识>/<YYYY-MM-DD>/T3-Code-T3CodeExperimental-<version>-x64.exe`。
- **安装 + A/B 审验**:用户启动 exp / dev,跑审验场景。
- **删除**:本文件第 2.5.3 节"审验通过 + PR merge 后,`git branch -D
  build/<purpose>-<date>`"。

**绝对禁止**:

- ❌ 临时 build 分支 **不** push 到 origin。
- ❌ 临时 build 分支 **不** merge 到 fork `main`。
- ❌ 临时 build 分支 **不** 创建 PR。

这些限制针对分支发布和合并，不禁止为 Pre-release 创建必要的源码关联 tag。
本地临时分支及其安装包清理后，Pre-release、附件与关联 tag 仍须保留，
无需另建独立 tag 归档流程。

### 4.5 与 `AGENTS-local/build-and-install.md` §6.1 节的关系

`AGENTS-local/build-and-install.md` §6.1 节原文"git switch '<pr-branch>';
Build-Stage Experimental" 是 **单 PR** 的标准流程。本文件第 4 节
"临时 build 分支"是其 **多 PR 扩展**,**不是** 替代。

---

## 5. Alpha 安装流程(用户手动)

按本文件第 3 节"alpha 装入:agent **不** 主动调用 `install-fork.ps1`",
**alpha 安装流程** 由 agent 提示 + 用户手动完成:

### 5.1 agent 侧步骤

1. 按第 2.5.4 节同步并核对已批准的构建基线、选择 Alpha 版本、构建和检查产物，
   完成构建指南第 6.4 节的远端归档及本地清理。
   在交付说明中列出包名、本地路径、远端链接、源码提交、哈希及包内身份检查结果。
   仅构建交付时停在这里，下面的安装准备仍以用户实际授权和安排为准。

2. **清注册表卸载项**(原 `install-fork.ps1` 在 silent install 前
   做的步骤):删除 `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
   下 `DisplayName` 匹配 `T3 Code (Alpha)*` 的注册表项。
   - **不** 调用 `install-fork.ps1`(它会触发 silent install 流程)。
   - 仅清注册表,**不** 启动 silent install。
   - 命令示例(**必须在 chcp 936 PowerShell 下执行**,中文
     `DisplayName` 输出才不会乱码;按 `AGENTS-local/build-and-install.md`
     §5 节):

     ```powershell
     chcp 936 | Out-Null
     $root = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
     $removed = @()
     Get-ChildItem -Path $root | ForEach-Object {
       $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
       if ($null -ne $p -and $p.DisplayName -like "T3 Code (Alpha)*") {
         $removed += $p.DisplayName
         Remove-Item -Path $_.PSPath -Recurse -Force
       }
     }
     Write-Host "Removed uninstall entries: $($removed -join ', ')"
     ```

3. **告知用户**:
   - 已清注册表卸载项(列出被删的 DisplayName)。
   - 提供 alpha 安装包路径:`installer/alpha/T3-Code-T3CodeAlpha-<version>-x64.exe`。
   - **不** 自动 silent install(用户主用状态,**绝不** 自动接管)。

### 5.2 用户侧步骤

1. 用户在桌面上手动关闭任何 **T3 Code (Alpha)** 进程(若在跑)。
2. 用户双击安装包(`.exe`)或用 `Start-Process` 启动 silent install。
3. 用户启动新装的 alpha,确认对话历史 / 设置 / OAuth 凭据完好。

---

## 6. 与其他本地规则的交叉引用

- `AGENTS-local/build-and-install.md` — 三 build 角色 + 数据隔离 +
  日常构建/安装脚本。本文件是其"PR 流程"维度的扩展。
- `AGENTS-local/upstream-sync.md` — 阶段 ① 同步上游。
- `AGENTS-local/subagents.md` — 阶段 ③ 开发过程中是否使用子代理。
- `AGENTS-local/web-ui-review.md` — 仅在调用 Web 审验时读取，提供实际操作方法。
- `AGENTS.md` 第 1 节"按任务读取规则" — 本文件属于"提交流程"任务,
  触发读取条件为:**用户在仓库内进入 PR / 合并 / 构建工作流**。

---

## 7. 与诊断报告的交叉引用

本文件被以下诊断报告引用:

- `docs/diagnostics/pi-provider-slow-20260925.md` §11.4 节(在
  `diag/pi-provider-slow-20260925` 分支)
- 未来 PR / 诊断报告引用本文件的"工作流总览" + "阶段详解" + "临时
  build 分支" 三节即可。
