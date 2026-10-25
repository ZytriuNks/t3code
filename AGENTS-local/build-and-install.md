# 三 build 构建、安装与数据隔离指南（本地开发偏好）

> 本文件是 fork 维护者的本地扩展，被 `.git/info/exclude` 排除，仅在本地工作树里存在。
> 仅维护可复用的构建、安装、数据隔离与验收指导，不写入迭代记录、构建日志、
> 具体产物清单、提交哈希、构建时间或阶段性验收和 CI 状态。

本 fork 用 `productName` 在桌面应用上派生三个互不干扰的身份：
`T3 Code (Alpha)`、`T3 Code (Experimental)`、`T3 Code (Dev)`。
它们共用同一份源码，但安装到三个目录、持有三套用户数据，构成
"主用基线 + A/B 验证 + 参考对照"的最小稳定组合。

---

## 1. 三 build 的角色

| Build | 角色 | 安装目录 | 何时升级 |
|-------|------|----------|----------|
| **Alpha** | 主用基线 baseline，**包含所有已合并、已审验通过的 PR** | `D:\t3code\alpha\T3 Code (Alpha)\` | **人工驱动**：只有当用户完成 PR 审验并合并到主用分支后，才构建并装入 Alpha。Alpha 不是 nightly/snapshot。 |
| **Experimental** | 验证候选（**含待审验 PR/新功能**） | `D:\t3code\experimental\T3 Code (Experimental)\` | 开发态审验后候选稳定时构建；用户明确要求或打包问题复现时可提前构建 |
| **Dev** | 参考对照（**不含待审验 PR，源码基线与本轮对照匹配**） | `D:\t3code\dev\T3 Code (Dev)\` | 无可用基线包或源码、构建配置、平台架构变化时构建；条件匹配时复用已有包 |

**Alpha 的严格语义**：Alpha 是"已审验通过、已合并、已批准"的
代码基线。Experimental 里验证通过只是必要条件，不是充分条件。
PR 必须经过人工审验（包括但不限于：代码评审、行为对照、稳定性
观察），并由用户**手动决定合并**，才能进入下一次 Alpha 构建。
未经审验通过的代码不会因为"在 Experimental 里跑过了"就自动进入
Alpha。

**为什么 Dev 不直接装上游 stock release**：上游 stock Alpha
release 的 `productName` 是 `T3 Code`，会装到
`%LOCALAPPDATA%\Programs\T3 Code\`、`%APPDATA%\T3 Code\`、
`~\.t3\`，与本 fork 的 `~\.t3-alpha\` 等不重叠。Dev 是"本 fork
基线"的快照而不是"上游原版"，因为 Dev 必须能用同一种派生框架
构建，从而保证 Experimental 和 Dev 之间**只有 PR 内容是变量**。

**审验顺序与 A/B 搭配**：共享 UI 默认先用 Web 开发态迭代；后端修改先做定向
测试及必要的真实服务验证；桌面原生能力用 Electron 开发态补验证。候选稳定后
构建 Experimental（含待审验 PR），用匹配的 Dev 基线包做需要的 A/B 对照，
不要求每次细微调整都构建两套安装包。最终保留安装包检查和受影响的桌面流程审验；
用户审验通过并决定合并后，Alpha 仍只在用户明确请求时构建。
完整分流见 [workflow-pr-ab-alpha.md](workflow-pr-ab-alpha.md) 第 2.3.1 节；
仅在实际调用 Web 审验时读取 [web-ui-review.md](web-ui-review.md)。

---

## 2. 数据隔离：什么在哪里

NSIS `customInit` 把 `$INSTDIR` 钉到
`D:\t3code\<stage>\<productName>\`，三个 build 物理隔离。构建时的
身份表位于 `scripts/build-desktop-artifact.ts`；运行时名称、系统身份、
userData 与 t3Home 仍有独立判断，修改时必须一起核对，不能把构建表视为
运行时自动共享的单一真源。

安装版 Dev 的 `isDevelopment = false` 是正常行为，该字段表示是否连接开发服务器。
`DesktopEnvironment.ts` 和 `DesktopEarlyElectronStartup.ts` 必须按产品名识别
`T3 Code (Dev)`，不能仅用开发服务器模式派生阶段名称和系统身份。

| 路径 | Alpha | Experimental | Dev |
|------|-------|--------------|-----|
| NSIS 安装目录 | `D:\t3code\alpha\T3 Code (Alpha)\` | `D:\t3code\experimental\T3 Code (Experimental)\` | `D:\t3code\dev\T3 Code (Dev)\` |
| Chromium userData | `%APPDATA%\t3code\` | `%APPDATA%\t3code-experimental\` | `%APPDATA%\t3code-dev\` |
| URL scheme | `t3code://` | `t3code-experimental://` | `t3code-dev://` |
| AppUserModelID | `com.t3tools.t3code` | `com.t3tools.t3code.experimental` | `com.t3tools.t3code.dev` |
| Server t3Home | `~\.t3-alpha\` | `~\.t3-experimental\` | `~\.t3-dev\` |
| 服务器数据库 | `~\.t3-alpha\userdata\statev2.sqlite` | `~\.t3-experimental\userdata\statev2.sqlite` | `~\.t3-dev\userdata\statev2.sqlite` |
| 设置 / 键位 / 模型清单 | `~\.t3-<stage>\userdata\{client-settings,settings,keybindings,model-manifest}.json` | 同上 | 同上 |
| OAuth 凭据 | `~\.t3-<stage>\userdata\secrets\` | 同上 | 同上 |
| 汉化字符串 | 编译进安装包（i18n message 文件） | 同上 | 同上 |

**关键不变量**：

1. 安装目录、Chromium userData、t3Home **三件事**任意两两不重名
   —— 这是隔离的根本保证。三件事同时被 productName 派生
   (`DESKTOP_IDENTITY_BY_PRODUCT_NAME`)，不能只改其一。
2. 数据库的对话历史、设置、键位都落在 `~\.t3-<stage>\userdata\`
   下，**不在 Chromium userData**。Chromium userData 只承载
   renderer 缓存（IndexedDB / Service Worker）。
3. `statev2.sqlite` 在 upgrade 时**保持不动**——silent install 不
   会删 userData；三个 .exe 覆盖安装也不会触碰
   `~\.t3-<stage>\userdata\` 下的任何文件。

---

## 3. 备份与回滚

```powershell
# 备份所有三个 stage 的 userdata 到 D:\backups\
$stages = @{ Alpha = '.t3-alpha'; Experimental = '.t3-experimental'; Dev = '.t3-dev' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($name in $stages.Keys) {
  $src = Join-Path $env:USERPROFILE "$($stages[$name])\userdata"
  $dst = "D:\backups\$name-$stamp"
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
  Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force
}
```

**回滚到上一个版本**：本地旧包已清理时，从 fork 对应的 Pre-release / Release
下载安装包并核对 SHA-256，再按第 5 节的安装授权和阶段隔离规则处理。
日常安装包归档只保存在 Pre-release 附件中，关联 tag 只定位源码；不另建 tag
存档或复制附件。用户明确要求的正常 Release 另按发布流程处理，不删除远端附件
来清理本地空间。
回滚安装包不等于回滚数据库，须先核对目标版本能否读取现有数据。

**清空某个 stage 重置**：删除对应 `~\.t3-<stage>\userdata\` 即可。
安装目录不必动。下次启动会重建数据库。

**Dev 想参考 Experimental 的数据做 A/B**：把
`~\.t3-experimental\userdata\` 整体复制到 `~\.t3-dev\userdata\`。
两边都从同一个数据库起步，可比性最强。

---

## 4. 日常构建流程

默认先按工作流第 2.3.1 节完成适用的构建前审验，在候选稳定后打包。用户明确
要求“构建 exp”等时执行已授权构建及必要检查，不增加 Web 审验确认关卡。
安装 / 升级、原生依赖或包内资源故障可提前构建实际包复现。Web、真实服务、
Electron 开发态与安装包的验证结果分开记录，不能相互替代。

构建受 `productName` 控制，**`apps/desktop/package.json` 的
`productName` 是构建时的开关**。调用方应保存原始清单，并通过 `finally`
还原；打包脚本本身不会自动恢复源码中的 productName。已有清单默认值为
`T3 Code (Experimental)`。

### 4.1 统一产物目录

所有对话和 worktree 都把产物放在**主工作区根目录**的 `installer/`，不使用当前
worktree 自己的 `installer/`。在普通非 bare 仓库中，可用
`git rev-parse --path-format=absolute --git-common-dir` 定位共享 `.git`，其父目录
即主工作区；使用前核对解析结果。`.gitignore` 中的 `/installer/` 排除整个目录。

| 阶段 | 主工作区内的存放路径 |
|------|----------------------|
| Alpha | `installer/alpha/<安装包及附属文件>` |
| Dev | `installer/dev/<安装包及附属文件>` |
| Experimental | `installer/experimental/<分支标识>/<YYYY-MM-DD>/<安装包及附属文件>` |

- 日期使用 `Asia/Shanghai`。同日多次构建用不同版本号区分，不覆盖旧文件。
- 分支标识用于目录和 tag：原始分支名转小写，把非 `[a-z0-9-]` 字符替换为 `-`，
  合并连续 `-`，去掉首尾 `-`，取前 48 个字符；空值用 `branch`。再附加 `-` 和
  原始分支名 UTF-8 字节的 SHA-256 前 8 位。记录原名与标识的对应关系，发现碰撞时
  加长哈希，不覆盖另一分支。Experimental 在 detached HEAD 下须明确记录所属开发分支。
- 使用打包器已有的 `--output-dir` 直接输出到上述绝对路径。`release/`、
  `D:/installers/` 和其他 worktree 的输出目录不再作为日常存档位置。
- `.exe`、`.blockmap`、`<安装包名>.build.json` 和 `<安装包名>.SHA256SUMS.txt`
  构成一套产物，元数据文件名也带版本，避免多个构建互相覆盖。

以下函数仅执行打包；执行者仍须完成第 6.4 节的校验、远端归档和本地清理。
`$installerRoot` 是已核对的主工作区 `installer/` 绝对路径；每次构建 Experimental
前按实际分支重新计算 `$experimentalOutputDir`，不可沿用上一分支的目录。

```powershell
$commonGitDir = git rev-parse --path-format=absolute --git-common-dir
if ($LASTEXITCODE -ne 0 -or (Split-Path -Leaf $commonGitDir) -ne '.git') {
  throw 'Resolve and verify the primary worktree before building'
}
$installerRoot = Join-Path (Split-Path -Parent $commonGitDir) 'installer'

function Build-Stage {
  param(
    [ValidateSet('Alpha', 'Experimental', 'Dev')][string]$name,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [string]$version = $env:T3CODE_DESKTOP_VERSION,
    [switch]$KeepStage
  )
  if ([string]::IsNullOrWhiteSpace($version)) { throw 'Choose a desktop version before building' }
  if (-not [System.IO.Path]::IsPathFullyQualified($OutputDir)) { throw 'Use an absolute installer output path' }
  $outputPath = [System.IO.Path]::GetFullPath($OutputDir)
  $installerPrefix = [System.IO.Path]::GetFullPath($installerRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $outputPath.StartsWith($installerPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output must stay within the primary worktree installer directory'
  }
  $manifestPath = Join-Path (Get-Location) 'apps/desktop/package.json'
  $original = [System.IO.File]::ReadAllBytes($manifestPath)
  $previousVersion = $env:T3CODE_DESKTOP_VERSION
  $previousKeepStage = $env:T3CODE_DESKTOP_KEEP_STAGE
  try {
    $env:T3CODE_DESKTOP_VERSION = $version
    $env:T3CODE_DESKTOP_KEEP_STAGE = if ($KeepStage) { 'true' } else { 'false' }
    $manifest = [System.Text.Encoding]::UTF8.GetString($original)
    $manifest = $manifest -replace '"productName": "T3 Code \([^)]+\)"',
      ('"productName": "T3 Code (' + $name + ')"')
    [System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
    corepack pnpm dist:desktop:win:x64 --output-dir $OutputDir
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
  } finally {
    [System.IO.File]::WriteAllBytes($manifestPath, $original)
    $env:T3CODE_DESKTOP_VERSION = $previousVersion
    $env:T3CODE_DESKTOP_KEEP_STAGE = $previousKeepStage
  }
}

# 先核对该阶段的版本、设置 T3CODE_DESKTOP_VERSION，并切到所需源码基线
Build-Stage Dev -OutputDir (Join-Path $installerRoot 'dev')
```

产物位于第 4.1 节对应目录，文件名为 `T3-Code-T3Code<Stage>-<version>-x64.exe`。
Dev、Experimental 分别构建；Alpha 仍需明确请求。

### 4.2 版本、源码与并行构建

**版本号约定**：每个阶段独立选择高于该阶段现有版本的新版本号。
`fork-N` 是版本标识，不能仅凭后缀大小推断 NSIS
是否会调用旧卸载器或绕过安装 hook。

#### 提升版本前的版本号核对

每次构建前核对：

1. 主工作区 `installer/` 及 fork 远端 tags / Releases 中该阶段已有版本；Experimental
   跨分支检查，不能在新分支重新使用已占用的渠道版本号。
2. Windows 卸载项中该阶段的 `DisplayVersion`。
3. 已安装 `app.asar/package.json` 的版本及源码提交。

Dev 与 Experimental 的后缀独立管理，不强行对齐。相同版本重建必须明确
区分产物来源，默认使用新版本保留回退选择。安装脚本清理选定阶段卸载项的
行为独立于版本命名；升级时仍遵守下节流程，不凭版本提升假定安装一定成功。

构建前固定源码提交，并核对所有影响产物的源码改动已包含在该提交中。存在未提交
源码时，先确定归属并形成可追溯的构建提交；不得把未包含这些改动的 HEAD 标为
完整来源。构建时临时派生的产品名称和版本记录在 build.json，结束后恢复源码清单。
不要为构建直接重置、stash 或提交用户其他未完成的工作。

多个对话构建时，使用独立 worktree。对同一渠道的版本分配、归档和清理实施互斥，
记录进行中的版本及构建归属；不能由不同对话同时占用同一版本或改同一源码清单。
实际编译可并行，但较旧构建晚完成时不得删除更新版本。比较版本按版本语义，
不能按上传完成时间、文件修改时间或字符串排序判断新旧。

#### 构建产物与依赖

- 身份或标签逻辑变化后完整构建，不用 `--skip-build` 复用旧的桌面或前端产物。
  不通过重命名其他阶段的安装包制作目标阶段。
- 新工作区先安装依赖。若 SPDX 许可证下载超时，可复制主检出同版本的
  `.generated/third-party-licenses/spdx/` 缓存后重试，保留许可证生成与校验。
- 普通构建不保留临时打包 stage。需要验收包内元数据或编译代码时，显式使用
  `Build-Stage ... -KeepStage`，记录本次临时目录的确切路径，验收及归档完成后清理。
  构建失败需要保留诊断现场时，记录用途与清理时机，不按通配符删除其他任务的 stage。
  构建完成后恢复源码清单中的 `productName` 不会改变已经生成的安装包。

### 4.3 对话区交付：可点击的本地文件链接

**每次构建完成后，必须在对话区的交付回复中输出指向本地实际产物的可点击链接。**
Alpha、Dev、Experimental 均适用；不能仅在终端日志中输出路径，也不能仅给代码块、
反引号路径或远端 Release 链接。按渠道与版本分别列出安装包、`.blockmap`、
`.build.json` 和 `.SHA256SUMS.txt` 的本地链接，并保留第 6.4 节要求的远端归档链接。

#### T3 支持的格式与行为

- 使用标准 Markdown 文件链接：`[显示名称](<绝对文件路径>)`。Windows 路径统一使用
  正斜杠并保留盘符（如 `D:/Code Projects/...`）；目标用 `<...>` 包住，兼容空格和括号。
  例如下面是**语法示例，不是实际产物**；交付时必须替换为本次已存在的完整路径：

  ```markdown
  [Experimental 安装包](<D:/Code Projects/t3code/installer/experimental/branch-key/YYYY-MM-DD/T3-Code-T3CodeExperimental-VERSION-x64.exe>)
  ```

- 实际回复中的链接必须在代码块之外。优先使用主工作区统一产物目录下的绝对路径，
  不使用当前 worktree 的相对 `installer/...` 路径、临时 stage 路径或省略号；安装包
  链接不附加源码行号或片段后缀。正文中的路径不得包含凭据或配对 token。
- T3 的 `apps/web/src/components/ChatMarkdown.tsx` 会把 Windows 盘符链接规范化为
  `file:///...`，再通过 `apps/web/src/markdown-links.ts` 与 `MarkdownFileLink` 识别为
  文件入口；角括号路径及空格已有 `markdown-links.test.ts` 覆盖。无需额外 MCP
  “生成文件链接”工具，直接在助手回复中输出上述 Markdown 即可。
- 文本构建记录/校验文件可通过文件面板或编辑器查看；`.exe`、`.blockmap` 属于
  非文本产物，按客户端和连接能力提供打开或“在资源管理器中显示”等文件菜单动作。
  `DesktopBridge.openLocalPath({ path, reveal })` 是客户端内部 IPC，并非可直接调用的
  代理 MCP 工具。不要把链接描述为必定启动安装，也不要为验证链接擅自执行安装包。
  `file:///...` 是 T3 支持的规范化形式，但不能将其当作远程浏览器的下载地址；
  本地路径属于构建所在环境，远程访问或该客户端不支持打开时仍需提供 Release 下载链接。

#### 交付前核对

在归档和本地清理完成后，对**最终保留**的每个链接目标再次执行
`Test-Path -LiteralPath $artifactPath -PathType Leaf`（或等价文件检查），同时核对渠道、
版本、大小和 SHA-256。只给仍存在的文件输出可点击的本地链接；文件若已按保留策略
清理，应明确说明“本地已清理”并给远端归档链接，不输出失效链接，也不声称未实测的
打开操作已通过。构建失败时，仅为实际留存的产物提供链接，并说明失败环节。

---

## 5. 日常安装流程

`scripts/fork-build/install-fork.ps1` 在 silent install **之前**
先删除注册表里的 `T3 Code (<stage>)` 卸载项。NSIS
`uninstallOldVersion` 找不到旧 uninstaller 就跳过
`UninstallLoop`、跳过那个"appCannotBeClosed"对话框。脚本在
chcp 936 PowerShell 下也能直接调用（不依赖 `&`）。当前脚本默认仍从 `release/`
找包，执行新流程时必须传入已核对的绝对 `-InstallerPath`。调用前用
`Test-Path -LiteralPath ... -PathType Leaf` 检查文件存在，并核对渠道、版本和哈希；
显式路径无效时应停止，不能让脚本回退到旧默认目录。

```powershell
# 用户先关闭对应阶段，分别升级 Dev / Experimental
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Dev `
  -InstallerPath (Join-Path $installerRoot 'dev/T3-Code-T3CodeDev-<version>-x64.exe')
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Experimental `
  -InstallerPath (Join-Path $experimentalOutputDir 'T3-Code-T3CodeExperimental-<version>-x64.exe')
```

**不要做这些事**：

- 不使用 `-Force`，它会停止其他阶段；不将 `-Stage All` 与单个
  `-InstallerPath` 组合，它会在三个阶段重复调用同一安装包并清理卸载项。
- `Stage` 是单值参数，不支持逗号列表；安装两种构建时分别调用。
- 不要在 silent install 前手动卸载旧版本——脚本已经清掉注册
  表，手动卸载反而会让 `statev2.sqlite` 里的数据被
  `--delete-app-data` 删掉。
- 不要把 `T3CODE_DESKTOP_VERSION` 设成上游版本号——会触发
  app-builder-lib 同版本 skip，覆盖安装直接不执行。
- 不要在 `apps/desktop/package.json` 里改 `appId` 或
  `protocols.scheme` —— 这两个是从 productName 派生的，会被覆写。

---

## 6. PR-A/B-Alpha 提交流程（仅 dev / exp 安装）

本节仅描述 PR 流程中的构建、安装和审验：Dev / Experimental 在 PR 合并前
用于对照，Alpha 在审验通过、合并后按用户明确请求构建。分支管理、PR 提交和
合并流程见 `AGENTS-local/workflow-pr-ab-alpha.md`。

### 6.1 候选稳定后构建 Experimental，按需构建或复用 Dev(PR 合并**前**)

按 §1 节"Experimental = 验证候选(含待审验 PR),Dev = 参考对照
(不含 PR)"，Experimental 在构建前审验后候选稳定时构建；Dev 基线包在合并前
准备，可复用满足以下条件的已有包：

- `build.json` 中完整源码提交与本轮选定的合并前基线匹配，不能只根据版本名判断。
- 渠道身份、构建配置、影响产物的工具链 / 依赖及平台架构与本轮对照要求匹配。
- 产物完整、哈希核对通过，且已有完整 Pre-release 归档；本地已清理时可从该
  Pre-release 下载核对后复用。记录本轮使用的版本和基线，不重新上传相同归档。

不匹配或没有可用包时才重建 Dev。需要 A/B 时先用两个隔离检出在开发态对照；
最终仍检查 Exp 包内身份及实际打包运行路径。运行代码或打包配置在安装包审验后
变化时重新构建并补测；仅修改 PR 描述或添加证据不重打包。

#### 单 PR 情形(标准)

```powershell
git switch '<pr-branch>'           # PR-1 / PR-2 等
Build-Stage Experimental -OutputDir $experimentalOutputDir # 当前 PR 分支对应目录
```

仅在没有可复用的 Dev 基线包时另行执行：

```powershell
git switch '<baseline-commit>'      # PR 合并之前的 commit,通常是 fork main HEAD
Build-Stage Dev -OutputDir (Join-Path $installerRoot 'dev') # 不含待审验 PR 的基线
```

#### 多 PR 情形(临时 build 分支)

按 `AGENTS-local/workflow-pr-ab-alpha.md` 第 4 节"临时 build 分支":

```powershell
git switch main
git switch -c 'build/<purpose>-<date>'
git merge --no-ff '<pr-branch-1>'            # merge PR-1
git merge --no-ff '<pr-branch-2>'            # merge PR-2
# 视情况 merge 多个 PR,直到 build 分支含所有待验证 PR
Build-Stage Experimental -OutputDir $experimentalOutputDir # 临时 build 分支对应目录
```

Dev 使用本轮选定并记录的 fork `main` 合并前基线（不含待审验 PR），可复用匹配
的已有包。临时 build 分支只用作 Exp 构建源，不作为 Dev 基线；审验期间 main
前进时重新确定比较基线及其影响，不能默默更换已记录的基线。

#### 关键不变量

- **不** 在 fork `main` 上直接构建 dev / exp(避免污染主用分支历史)。
- 临时 build 分支名 **不** push 到 origin；安装包按第 6.4 节仅归档到 Pre-release，
  其必要关联 tag 指向实际构建源码。
  审验完成后删除临时分支及符合条件的本地产物(见
  `AGENTS-local/workflow-pr-ab-alpha.md` §2.5.3 节)。
- 临时 build 分支 **不** merge 到 fork `main`;**不** 创建 PR。

### 6.2 安装 dev / exp(不关 alpha 进程)

按 `AGENTS-local/workflow-pr-ab-alpha.md` 第 3 节"dev / exp 安装
的安全不变量",**绝不使用** `install-fork.ps1 -Force`(会模式
匹配停所有 `T3 Code*` 进程,可能误关 alpha)。

#### 安装流程(用户手动关 dev / exp + agent 装)

1. **用户** 在 Windows 任务管理器(或 `tasklist | grep "T3 Code
   (Experimental)\|T3 Code (Dev)"`)确认 Experimental / Dev 进程
   存在(即要重装覆盖)。
2. **用户手动**结束这些进程。**绝不**让 agent 用 `Stop-Process`
   按模式匹配停 `T3 Code*` —— AGENTS.md "三种伤害自己的方式" 第 1 条
   "绝不按模式匹配 kill PID"。
3. 进程全部结束后,agent 跑(都不带 `-Force`):

   ```powershell
   # 路径须先按第 5 节核对，以下为当前分支已归档的安装包
   pwsh .\scripts\fork-build\install-fork.ps1 -Stage Experimental -InstallerPath $experimentalInstallerPath
   # 需要安装 Dev 时另行调用
   pwsh .\scripts\fork-build\install-fork.ps1 -Stage Dev -InstallerPath $devInstallerPath
   ```

4. 安装完成后,**用户** 从桌面图标启动新装的 Experimental / Dev。

#### Alpha 进程保护

- **绝对禁止** agent 触发任何关 alpha 的动作。
- Agent 在查错误时,只能 `tasklist | grep "T3 Code (Alpha)"` 查
  alpha 状态;**不**调用 `Stop-Process` 对 alpha 做任何事。
- 用户在主用 alpha 状态下,本节与 §6.1 / §6.3 完全不触及 alpha。

### 6.3 构建 Alpha(PR 合并**后**,仅在用户明确请求时)

按 §1 节"Alpha = 主用 baseline,代表已审验通过、已合并、已批准的
代码基线" + 第 8 节"Agent 不要自动调用 Build-Stage Alpha",**Alpha
仅在 PR 审验通过 + 用户手动 merge 到 fork `main` 之后,且用户明确
请求构建 Alpha 时才构建**。构建基线为已批准的 fork `main` 提交；
GitHub 合并只更新远端分支，先同步本地检出或显式绑定所选提交的构建工作区。
同时按第 4 节核对 Alpha 自己的版本并设置 `T3CODE_DESKTOP_VERSION`。

在适合切换分支的干净工作区中：

```powershell
git fetch origin main
git switch main
git merge --ff-only origin/main
git rev-parse HEAD         # 确认是本次已批准的源码基线
Build-Stage Alpha -OutputDir (Join-Path $installerRoot 'alpha')
# 产物:installer/alpha/T3-Code-T3CodeAlpha-<version>-x64.exe
```

快进失败或 HEAD 与预期不符时先核对原因，不强行重置。若使用绑定指定提交的
独立构建工作区，直接核对该工作区 HEAD，不在其他工作区里切换分支。

#### Alpha 安装(用户手动,详见 `AGENTS-local/workflow-pr-ab-alpha.md` §5)

**Agent 不调用** `install-fork.ps1`。完整流程见工作流文档第 5 节:

1. agent 从已批准的 fork `main` 提交构建 Alpha，完成第 6.4 节归档及清理后交付；
   后续注册表清理和安装准备仍以用户实际授权为准。
2. agent 清注册表卸载项:`HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
   下 `DisplayName` 匹配 `T3 Code (Alpha)*` 的项。**必须在 chcp 936
   PowerShell 下执行**,命令示例见工作流文档 §5.1。
3. agent 告知用户:(a) 已清注册表卸载项(列出被删的 DisplayName);
   (b) 提供 alpha 安装包路径 `installer/alpha/T3-Code-T3CodeAlpha-<version>-x64.exe`;
   (c) **不**自动 silent install。
4. 用户在桌面上手动关闭 alpha(若在跑)→ 双击安装包或用
   `Start-Process` 启动 silent install → 启动新装 alpha,确认
   `~\.t3-alpha\` 里对话历史 / 设置 / OAuth 凭据完好。

#### Alpha 装入的不变量

- `~\.t3-alpha\` 在覆盖安装时**保持不动**;`statev2.sqlite` 不被
  删(§2 节不变量)。
- 不主动复制作 `~\.t3-experimental\` 或 `~\.t3-dev\` 到
  `~\.t3-alpha\` —— Alpha baseline 是用户主用状态,不是 dev/ab
  验证状态(§8 节)。
- 不主动用上游 stock Alpha release 的 `~\.t3\` 替换本 fork 的
  `~\.t3-alpha\`,除非用户明确要求接回上游数据(§8 节)。

### 6.4 远端归档与本地清理

用户授权构建安装包后，必要检查、上传本节规定的测验用 Pre-release，以及符合
保留策略的本地清理，均属于构建收尾，不重复请求相同授权。仅执行 `build:desktop`
等编译检查不触发安装包发布。安装应用、创建或合并 PR、正常 Release 和删除远端
归档分别按用户授权执行；用户在当前会话中的具体要求优先。

PR 所需的图像、视频等更新证据直接附在对应 PR 的正文或评论中，按工作流
第 2.5.2 节处理，不上传到 Pre-release / Release，也不建立证据专用发布。

#### 6.4.1 发布类型与命名

归档仓库为 fork `ZytriuNks/t3code`，执行 GitHub 命令时显式指定 `--repo`，
不得发布到上游。**日常安装包归档只需保留在 Pre-release 附件中**，不需要
另建 tag 存档、证据发布或其他安装包副本。GitHub Release 必须关联 `tag_name`，
因此保留该发布所需的关联 tag，作为实际构建提交的定位；Tags 页中的源码下载
不是安装包，也不算完成归档。无需先单独执行 `git tag` / `git push --tags`，
可由 `gh release create --target <完整源码提交>` 创建必要关联 tag。
Pre-release 显示在 Releases 页面和关联 tag 出现在 Tags 页，均是 GitHub 正常行为；
不为隐藏 Tags 页条目删除发布的关联 tag。仅在用户明确要求正常发布时使用 Release。

| 触发方式 | 发布类型 |
|----------|----------|
| 构建完成后的自动归档，包括 Alpha | Pre-release，`latest=false` |
| 用户明确要求 release / 正常发布 | 正常 Release，不默认标记为 Pre-release |
| 用户明确指定 Pre-release | 按指定的 Pre-release 发布 |

Alpha 的本地渠道含义不等于 GitHub 正常 Release。明确要求 release 时，按指定
源码和产物范围核对后创建或晋升正常 Release，使用正常发布标题与说明；不要机械
套用测验包声明。是否标记 Latest 按本次发布要求及仓库发布惯例处理。

自动归档的 Pre-release 使用以下关联 tag 名；`<分支标识>` 与第 4.1 节目录中的标识完全相同：

| 阶段 | Pre-release 关联 tag 格式 |
|------|----------|
| Alpha | `alpha-<版本>` |
| Dev | `dev-<版本>` |
| Experimental | `exp-<分支标识>-<版本>` |

tag 指向本次实际构建的源码提交，不能默认指向最新 main。已有 tag 不移动、不强推；
同版本不同内容必须使用新版本。临时构建提交可通过 Pre-release 的关联 tag 定位，不能据此推送
同名临时分支、合并 main 或创建 PR。重试时仅复用提交和附件哈希均一致的记录，
不使用 `--clobber` 覆盖不同的已发布产物。

#### 6.4.2 英文发布说明与附件

所有 Pre-release / Release 的标题和正文默认使用符合仓库风格的英文：描述具体
用途、变化和验证结果，简洁直接。与用户交流仍使用中文。

测验用标题采用 `Alpha <version> (Developer testing)`、
`Dev <version> (Developer testing)` 或
`Experimental <branch-key> <version> (Developer testing)`。
所有测验用 Pre-release 正文开头必须保留以下英文声明：

> **Developer testing build.** This prerelease is intended for development testing, regression checks, and issue reproduction. It is not a stable release.

正文随后用英文列出渠道、版本、分支、完整源码提交、构建时间、实际验证范围、
已知限制和附件校验方式。不得把未运行的检查或测试构建描述为稳定性保证。

每套归档附件包括安装包、生成的 `.blockmap`、`<安装包名>.build.json` 和
`<安装包名>.SHA256SUMS.txt`。build.json 记录渠道、版本、原始分支及标识、源码
提交、构建时间与时区、平台架构、包内身份核对结果，以及二进制文件名、大小和
SHA-256；校验文件覆盖安装包、blockmap 和 build.json，文件名使用相对名称。
按明确清单上传，不通配上传目录中的日志、环境文件、凭据、个人路径或调试配置。

这些附件作为安装包的一套归档只保存在该 Pre-release 中。截图、录像及其他
PR 审验媒体另放对应 PR 正文或评论附件；不因附件上传工具受限改存发布页。

#### 6.4.3 必须完成的收尾顺序

1. 固定源码与版本，按第 4.1 节构建到统一目录；核对包内渠道、版本、源码信息，
   完成受影响范围的必要检查。安装验收仍遵守独立授权，不因归档自动安装应用。
2. 生成构建记录和校验文件，记录本次附件清单。
3. 使用 `gh release create` 创建 draft，指定实际源码 `--target`、英文标题和
   `--notes-file`。自动归档添加 `--prerelease --latest=false`，上传本次附件。
4. 核对远端附件名称、数量、大小及 SHA-256。远端未返回 digest 时，下载到本次
   临时目录计算校验；不能只以命令退出码或空 tag 判断成功。
5. 核对通过后发布 draft，再确认 Pre-release 状态、下载地址和关联 tag 的实际提交。
   正常 Release 使用本次明确要求的发布类型，不套用自动归档的 Pre-release 状态。
6. 远端归档成功后执行本节保留策略，清理本次无用副本及已完成验收的临时 stage，
   按第 4.3 节在对话区交付仍存在的本地产物可点击链接，并列出远端链接、版本、
   源码提交与验证范围。

构建、校验或上传失败时，保留新旧产物，报告失败环节及留存路径；不能提前清理
可回退版本。已存在完整归档时核对后复用，无需反复上传。构建只有在远端归档与
符合条件的收尾完成后才算交付完成；暂缓清理的理由和范围必须明确记录。

#### 6.4.4 本地保留策略

| 对象 | 清理条件 | 保留范围 |
|------|----------|----------|
| Alpha / Dev | 新版本必要检查及远端归档成功 | 本地仅保留该渠道最新完整一套产物 |
| Experimental | 所属分支开发完成，且待清理版本均有完整远端归档 | 清理该分支目录及空日期目录，保留其他分支 |
| Pre-releases、附件及必要关联 tag | 不属于本地清理范围 | 长期保留；明确要求的正常 Release 也不自动清理 |

- 分支完成指对应 PR 已合并，或用户明确结束、放弃该分支；临时集成分支须等所含
  PR 均已完成且不再用于审验。关闭对话、切换分支或本地分支不存在均不是清理依据。
- 旧 Dev 包仍被其他对话用于 A/B 对照时暂缓删除，记录使用任务；对照结束后清理。
  清理前核对本次构建是否仍为该渠道最新版本，旧构建晚完成不得反向删除新版本。
- 清理整套旧产物，包括对应 blockmap、校验文件和构建记录；Experimental 在开发
  期间保留该分支的各次产物，不套用 Alpha / Dev 的仅留最新规则。
- 删除或移动前解析并检查绝对路径，目标必须位于已确认的主工作区 `installer/`
  内，不经符号链接或 junction 越界。按构建记录确定文件归属，不按宽泛名称匹配
  其他任务。只有本次记录的临时 stage 可在该根目录外单独清理。
- 不清理应用安装目录、用户数据、GitHub tags 或远端 Release 附件。需要清理历史
  `D:/installers/` 或其他遗留目录时单独确定范围，不在日常收尾中自动扫描删除。
- 若使用回收站，说明产物可恢复，清空回收站前不算释放磁盘空间；操作被环境阻止
  时如实报告，不绕过限制或把未完成清理记作成功。

### 6.5 默认立场

按 §1 节"Alpha 不是 nightly 或 snapshot"+ §8 节"Agent 不要做的事":

- **Experimental 与 Dev** 的构建,agent 在用户给出明确请求(如
  "构建 exp")时直接执行;不需要"明确合并后"这种前置条件。
- **Alpha** 的构建,仅在用户明确说"现在合并并构建 Alpha"或
  类似请求后执行。任何"Experimental 跑过了 → 应该能进 Alpha"
  的推断都是越权。
- **合并 PR 到 fork `main`**: **默认立场**是用户在 fork 仓库 UI
  手动 merge,agent **不** 自动合并。**但**若
  用户在同一会话中明确给出授权(例如"帮我 merge 这个 PR"、
  "按 Create a merge commit 走"等),agent **可以**通过 `gh pr merge` 或 fork 仓库
  API 完成 merge —— 详见 `AGENTS-local/workflow-pr-ab-alpha.md`
  §2.5.2 节"PR 合并"小节,该小节明确"默认不主动 merge,用户主动
  授权时可由 agent 帮用户 merge"以及 merge 方式选择(Merge commit /
  Squash / Rebase)。按 `AGENTS.md` 第 1 节"已有授权应持续
  适用",授权过一次 merge 流程后,后续同类型 PR合并按相同步骤
  执行,不再追问。

---

## 7. 派生表检查与产物验收

### 名称、标签与隔离验收

- 核对包内 `productName`、版本及源码提交，窗口名称和阶段应与目标 build 匹配；
  应用 ID、协议和数据目录按第 2 节核对，不能只根据安装包文件名判断身份。
- Alpha、Experimental 在“设置 → 外观 → 环境标识”的“版本标签”或“图案”
  模式显示对应标签；“无”模式隐藏。两者没有专用背景图案，图案模式回退到标签。
- 用户的隐藏设置应保留。分别验证目标阶段的窗口名、标签显示/隐藏及历史数据，
  不将其他阶段的验收结论替代该阶段的实际安装验收。
- 交付时按第 4.3 节输出可点击的本地文件链接，并说明源码基线、产物版本及验证范围。
  将包内校验、实际安装验收与 CI 结果区分开，未运行或排队中的检查不能视为通过。
- 安装包和 `.blockmap` 直接输出到统一目录；确需转移时核对 SHA-256，确认一致后
  才清理本次重复副本。远端校验和完整归档按第 6.4 节执行。

### 派生表验证

修改任何派生表之后，必须跑：

```powershell
corepack pnpm --filter @t3tools/desktop typecheck
corepack pnpm exec vp test run --passWithNoTests `
  apps/desktop/src/electron/ElectronProtocol.test.ts `
  apps/desktop/src/app/DesktopUserData.test.ts `
  apps/desktop/src/app/DesktopAppIdentity.test.ts `
  apps/desktop/src/app/DesktopEnvironment.test.ts `
  apps/desktop/src/app/DesktopStatePaths.test.ts `
  apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts `
  apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
```

以当前测试结果为准，不用历史数量判断成功，也不预先将失败认定为环境问题。
修改标签逻辑时另跑 `SidebarStageBackdrop.test.tsx`、`branding.test.ts` 等相关测试。

派生表所在文件：

- `scripts/build-desktop-artifact.ts` —
  `DESKTOP_IDENTITY_BY_PRODUCT_NAME`（构建时身份）
- `apps/desktop/src/app/DesktopEnvironment.ts` — 窗口名、branding 和系统身份
- `apps/desktop/src/app/DesktopEarlyElectronStartup.ts` — Linux 启动前身份
- `apps/desktop/src/app/DesktopUserData.ts` — `stageNames`
- `apps/desktop/src/app/DesktopStatePaths.ts` —
  `BASE_DIR_BY_APP_NAME`
- `apps/desktop/src/electron/ElectronProtocol.ts` —
  `PRODUCTION_SCHEMES_BY_APP_NAME`
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts` —
  `wslT3HomeByAppName`

新增 build（例如 `T3 Code (Beta)`）时，需核对上述文件的构建和运行时身份，
并检查 `SidebarStageBackdrop.tsx` 的可显示标签。只修改 productName 或构建表
不会自动补齐窗口名称与侧栏标签。

## 8. Agent 不要做的事

- **不要自动合并 PR**。Alpha 只反映已人工合并的内容。
- **不要自动调用 `Build-Stage Alpha`**。Alpha 构建只能在用户
  明确请求后进行（例如“现在合并并构建 Alpha”）。
- **不要为了“证明 Exp 能进 Alpha”而主动复制作 `~\.t3-<exp>\` 到
  `~\.t3-alpha\`**。Alpha baseline 是用户主用状态，不是 dev/ab
  验证状态。
- **不要用上游 stock Alpha release 的 `~\.t3\`** 与本 fork 的
  `~\.t3-alpha\` 互资，除非用户明确要求接回上游数据。
- **不要在 PR 合并前重构 alpha 以外的 stage 之间的数据流向**
  （例如用 `~\.t3-dev\` 当 alpha 的后备）。隔离是不变量。
