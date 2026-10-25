# Fork 构建与安装指南

本 fork 基于 `productName` 派生三个桌面身份：Beta（主用基线，覆盖当前
Alpha）、Experimental（待审验候选）、Dev（参考对照）。本指南说明
构建、安装与身份核验；维护者本地的 PR 和构建记录保存在 `AGENTS-local/`。

## 三个身份如何隔离

`productName` 是所有派生的根键。当前 fork 支持：

| productName              | 安装目录                                         | Chromium userData                | Server t3Home         |
| ------------------------ | ------------------------------------------------ | -------------------------------- | --------------------- |
| `T3 Code (Beta)`         | `D:\t3code\beta\T3 Code (Beta)\`                 | `%APPDATA%\t3code\`              | `~\.t3-alpha\`        |
| `T3 Code (Experimental)` | `D:\t3code\experimental\T3 Code (Experimental)\` | `%APPDATA%\t3code-experimental\` | `~\.t3-experimental\` |
| `T3 Code (Dev)`          | `D:\t3code\dev\T3 Code (Dev)\`                   | `%APPDATA%\t3code-dev\`          | `~\.t3-dev\`          |

构建身份由 `scripts/build-desktop-artifact.ts` 中的
`resolveDesktopIdentity` 决定。运行时的名称、系统身份、
数据目录和协议仍分别由桌面模块派生，修改构建表并不会自动更新这些判断。

安装版 Dev 的 `isDevelopment` 仍为 `false`；这个字段表示是否连接开发服务器，
不能用它单独判断产品阶段。`DesktopEnvironment.ts` 和
`DesktopEarlyElectronStartup.ts` 必须同时识别产品名 `T3 Code (Dev)`，
否则会出现安装目录正确、窗口名称和系统身份却回落为 Experimental 的情况。
构建结束后还原源码中的 `productName` 不会改变已生成安装包的身份。

表中是维护者安装目录的约定。升级优先沿用各阶段的注册目录；全新安装默认使用
`%LOCALAPPDATA%\Programs\<productName>`，不在安装包中强制写入维护者的盘符。
Beta 与 Alpha 共用安装注册身份。Beta 的主程序为 `T3 Code (Beta).exe`；升级时
先正常卸载旧版，再安装新程序并更新快捷方式。标准目录末尾的 `T3 Code (Alpha)`
改为 `T3 Code (Beta)`，其直接父目录若为 `alpha`，一并改为 `beta`。其他自定义
目录保持原位置；安装器显式收到 `/D` 时按指定位置安装。

三个阶段共用 `installer.nsh`。其 `customInit` 在调用旧卸载器之前，将
`$INSTDIR` 和该阶段注册表中的 `InstallLocation` 规范化，修复旧包写入的重复
反斜杠。卸载失败仍会阻止升级；不跳过失败，也不清除卸载项来伪装安装成功。

## 一次性安装后看到什么

安装完成后您能在以下三处看到 fork：

1. Beta 将标准 Alpha 程序目录迁至 Beta；Experimental 和 Dev 保持各自目录。
2. `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` 下保留
   当前阶段的卸载项，Beta 正常卸载旧 Alpha 后更新为 Beta 的版本信息。
3. Beta/Alpha 共用 `~\.t3-alpha\` 和 `%APPDATA%\t3code\`；
   `~\.t3-experimental\`、`~\.t3-dev\` 仍各自隔离。

## 构建流程

为每个阶段分别选择源码基线和版本号。Experimental 使用待审验分支；Dev
使用对应的已合并基线；Beta 为当前主用基线。严格 A/B 对照需要记录
两包的源码提交，确认差异范围，不能仅凭相近版本号判断。

构建前核对 `release/`、存档目录以及已安装版本，选择该阶段尚未使用的新版本号。
Dev 和 Experimental 的 `fork-N` 独立递增。显式设置 `T3CODE_DESKTOP_VERSION`；
未设置时构建脚本使用 `apps/server/package.json` 的版本。

下面演示单次 Dev 构建；Experimental 则将 `$stage` 改为 `Experimental`，
并选择该阶段的版本号。使用 `finally` 恢复清单，失败时也不遗留产品名修改。

```powershell
$stage = 'Dev'
$env:T3CODE_DESKTOP_VERSION = '0.0.42-fork-2' # 示例；每次先核对现有版本
$manifestPath = Join-Path (Get-Location) 'apps/desktop/package.json'
$original = [System.IO.File]::ReadAllBytes($manifestPath)
try {
  $manifest = [System.Text.Encoding]::UTF8.GetString($original)
  $manifest = $manifest -replace '"productName": "T3 Code \([^)]+\)"',
    ('"productName": "T3 Code (' + $stage + ')"')
  [System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
  corepack pnpm dist:desktop:win:x64 --keep-stage
  if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
} finally {
  [System.IO.File]::WriteAllBytes($manifestPath, $original)
}
```

产物位于 `release/T3-Code-T3Code<Stage>-<version>-x64.exe`。
`--keep-stage` 保留临时打包目录供核验；身份修复后应完整构建，不复用旧的
`dist-electron` 或使用 `--skip-build`。

新工作区需要安装依赖。如果第三方许可证插件下载 SPDX 数据超时，可以复制
主检出中同版本的 `.generated/third-party-licenses/spdx/` 缓存后重试；
保留许可证生成和校验，不能跳过它们。

## 安装流程

### 旧路径导致“应用无法关闭”

旧包注册的安装路径可能含重复反斜杠。NSIS 将该路径传给旧卸载器后，卸载器会
在执行卸载前返回错误码 2。安装器重试五次后统一显示“应用无法关闭”，即使应用
没有运行也会如此。点击取消后的 `Failed to uninstall old application files: 2`
说明升级未完成，不能据此判断新版本已覆盖旧版本。

新安装包在普通双击和 `/S` 静默安装时均修复这一旧路径，再正常执行升级。
无需手动删除卸载注册项。

### 安装并核对实际版本

`scripts/fork-build/install-fork.ps1` 校验安装包阶段，解析已注册的实际安装目录，
确认新旧目录下没有运行中的进程后再安装。完成后同时核对主程序的产品名、文件版本、
注册版本和安装目录；退出码为 0 但未实际覆盖的情况也会报错。

```powershell
# 用户先关闭要升级的 Beta / Experimental / Dev，再按阶段分别调用
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Beta
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Dev
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Experimental
```

`Stage` 是单值参数，不支持 `-Stage Experimental,Dev`。`-Force` 会明确报错，
脚本不再终止任何应用。用户先关闭目标阶段；Beta 升级时应先关闭原 Alpha。
Beta 安装按维护者明确安排执行。

显式使用 `-InstallerPath` 时必须与单个 `-Stage` 匹配；不要将它与 `-Stage All`
组合，脚本会拒绝这种用法。显式指定的安装包不存在或阶段不匹配时立即报错，
不会回退到目录中另一份包。归档安装包建议始终使用 `-InstallerPath` 指定。

## 数据迁移 / 备份

- Beta baseline：`~\.t3-alpha\userdata\` 即为基线；Beta 会继承当前 Alpha
  的服务器状态和 Electron userData 身份。
- 上游 stock Alpha release：NSIS 装到
  `%LOCALAPPDATA%\Programs\T3 Code\`，对应 Chromium userData 为
  `%APPDATA%\T3 Code\`、t3Home 为 `~\.t3\`——和本 fork 的
  `~\.t3-alpha\` **不重叠**。如果想接回上游 stock Alpha 数据，先
  把 `~\.t3-alpha\userdata\` 备份，再让 stock Alpha 写入 `~\.t3\`
  然后复制回来。
- Experimental：每次想重置只需清空 `~\.t3-experimental\userdata\`。
- Dev：默认空白（首次启动会建新数据库）。如需用 Exp 数据做 A/B 验
  证，可手动复制 `~\.t3-experimental\userdata\` 到
  `~\.t3-dev\userdata\`。

## 单元测试

每次改完派生表（`build-desktop-artifact.ts`、`DesktopUserData.ts`、
`ElectronProtocol.ts`、`DesktopBackendConfiguration.ts`、
`DesktopStatePaths.ts`、`DesktopEnvironment.ts`、`DesktopEarlyElectronStartup.ts`）后跑：

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

以本次实际测试结果为准，不依赖历史测试数量，也不预先忽略任何失败。

## 产物验收

- 核对安装包的 `ProductName`、版本号，以及 `app.asar/package.json` 的
  `productName`、`t3codeBuildStage`、`t3codeCommitHash`。
- 验证包内名称派生逻辑在没有开发服务器时返回目标阶段，Windows 应用 ID、
  URL scheme 和数据目录也与该阶段对应。文件名正确不足以证明运行时身份正确。
- 安装后的窗口标题应为 `T3 Code (<Stage>)`。侧栏的小标签另受前端支持阶段
  和“设置 → 外观 → 环境标识”控制；窗口名修复不等于所有阶段都已支持标签。
- 保存 `.exe` 和 `.blockmap`，复制到存档目录后核对 SHA-256。记录测试、
  包内检查与用户实际启动验收的区别。
