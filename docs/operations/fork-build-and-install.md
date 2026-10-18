# Fork 构建与安装指南

本 fork 基于 `productName` 派生三个桌面身份：Alpha（已合并并审验的
主用基线）、Experimental（待审验候选）、Dev（参考对照）。本指南说明
构建、安装与身份核验；维护者本地的 PR 和构建记录保存在 `AGENTS-local/`。

## 三个身份如何隔离

`productName` 是所有派生的根键。当前 fork 支持：

| productName              | 安装目录                                         | Chromium userData                | Server t3Home         |
| ------------------------ | ------------------------------------------------ | -------------------------------- | --------------------- |
| `T3 Code (Alpha)`        | `D:\t3code\alpha\T3 Code (Alpha)\`               | `%APPDATA%\t3code\`              | `~\.t3-alpha\`        |
| `T3 Code (Experimental)` | `D:\t3code\experimental\T3 Code (Experimental)\` | `%APPDATA%\t3code-experimental\` | `~\.t3-experimental\` |
| `T3 Code (Dev)`          | `D:\t3code\dev\T3 Code (Dev)\`                   | `%APPDATA%\t3code-dev\`          | `~\.t3-dev\`          |

构建身份由 `scripts/build-desktop-artifact.ts` 中的
`DESKTOP_IDENTITY_BY_PRODUCT_NAME` 决定。运行时的名称、系统身份、
数据目录和协议仍分别由桌面模块派生，修改构建表并不会自动更新这些判断。

安装版 Dev 的 `isDevelopment` 仍为 `false`；这个字段表示是否连接开发服务器，
不能用它单独判断产品阶段。`DesktopEnvironment.ts` 和
`DesktopEarlyElectronStartup.ts` 必须同时识别产品名 `T3 Code (Dev)`，
否则会出现安装目录正确、窗口名称和系统身份却回落为 Experimental 的情况。
构建结束后还原源码中的 `productName` 不会改变已生成安装包的身份。

`install-dir-override.nsh` 在 staging 阶段写入两个 hook：

- `customInit`：把 `$INSTDIR` 强行改写到 `D:\t3code\<stage>\<productName>\`
  后缀包含 productName 段，以免 `instFilesPre` 再次追加。
- `customUnInstallCheck` / `customUnInstallCheckCurrentUser`：用
  `ClearErrors` 短路 `handleUninstallResult` 的错误检查，使
  uninstaller 退出码不再触发 `SetErrorLevel 2 / Quit`。

## 一次性安装后看到什么

安装完成后您能在以下三处看到 fork：

1. `D:\t3code\alpha\T3 Code (Alpha)\`、`D:\t3code\experimental\…`、
   `D:\t3code\dev\…` 三个目录互不重叠。
2. `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` 下三
   条独立的卸载项 `T3 Code (Alpha) 0.0.42-fork-1` 等。
3. `~\.t3-alpha\`、`~\.t3-experimental\`、`~\.t3-dev\` 三个目录，
   每个目录下的 `userdata\statev2.sqlite` 持有各自的对话与设置。

## 构建流程

为每个阶段分别选择源码基线和版本号。Experimental 使用待审验分支；Dev
使用对应的已合并基线；Alpha 仅在明确请求后构建。严格 A/B 对照需要记录
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

### 为什么不能用裸 `/S`

`app-builder-lib` 的 `installUtil.nsh` 在 silent install 同版本
fork build 时会进入 `UninstallLoop`：调旧版 uninstaller，失败 5 次
后弹 `appCannotBeClosed` 提示框，默认按钮 Cancel。用户点 Cancel
后旧 uninstaller 已部分清理，第二次 silent install 才能正常完成。

### 标准做法：先清注册表再装

`scripts/fork-build/install-fork.ps1` 在运行 silent install 之前删
除对应 productName 在 `HKCU\…\Uninstall` 下的键。NSIS 找不到卸载
项就直接跳过 `uninstallOldVersion`、跳过整个 UninstallLoop，覆盖
安装一次成功。

```powershell
# 用户先关闭要升级的 Dev / Experimental，再按阶段分别调用
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Dev
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Experimental
```

`Stage` 是单值参数，不支持 `-Stage Experimental,Dev`。不要使用 `-Force`：
当前脚本会停止所有匹配的 T3 进程，可能关闭主用 Alpha。Alpha 安装按维护者
明确安排手动执行。

显式使用 `-InstallerPath` 时必须与单个 `-Stage` 匹配；不要将它与 `-Stage All`
组合，否则三个阶段会重复执行同一个安装包，并清理其他阶段的卸载项。

## 数据迁移 / 备份

- Alpha baseline：`~\.t3-alpha\userdata\` 即为基线；上游 Alpha
  release 若用本 fork 派生，会自动继承此目录。
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
