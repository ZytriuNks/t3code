# Fork 构建与安装指南

本 fork 在 `feat/web-zh-cn-settings-followup` 之上引入了一套基于
`productName` 的派生机制，使**同一份仓库源码可以产出三个互不干扰
的桌面客户端**：Alpha（基线）、Experimental（验证）、Dev（开发）。
本指南说明如何构建、安装、以及在 PR/新分支后刷新所有客户端。

## 三个身份如何隔离

`productName` 是所有派生的根键。当前 fork 支持：

| productName              | 安装目录                                         | Chromium userData                | Server t3Home         |
| ------------------------ | ------------------------------------------------ | -------------------------------- | --------------------- |
| `T3 Code (Alpha)`        | `D:\t3code\alpha\T3 Code (Alpha)\`               | `%APPDATA%\t3code\`              | `~\.t3-alpha\`        |
| `T3 Code (Experimental)` | `D:\t3code\experimental\T3 Code (Experimental)\` | `%APPDATA%\t3code-experimental\` | `~\.t3-experimental\` |
| `T3 Code (Dev)`          | `D:\t3code\dev\T3 Code (Dev)\`                   | `%APPDATA%\t3code-dev\`          | `~\.t3-dev\`          |

appId、URL scheme、`appUserModelId`、WM_CLASS、Linux desktop entry、
NSIS INSTALLDIR 都从 productName 派生（见
`scripts/build-desktop-artifact.ts` 的
`DESKTOP_IDENTITY_BY_PRODUCT_NAME`）。

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

版本号强制为 `0.0.42-fork-1` 以保证 NSIS 在覆盖安装时不会因
同版本号直接跳过（NSIS 的 same-version skip 会让覆盖 install 失
效）。`T3CODE_DESKTOP_VERSION` 必须在每次构建时显式传入，因为
desktop 阶段读 `apps/server/package.json` 的 `version`，而
`apps/desktop/package.json` 里的 `version` 不参与。

```powershell
# 在仓库根目录
$env:T3CODE_DESKTOP_VERSION = "0.0.42-fork-1"

# Experimental
(Get-Content apps/desktop/package.json) `
  -replace '"productName": "T3 Code \([^)]+\)"', `
           '"productName": "T3 Code (Experimental)"' `
  | Set-Content apps/desktop/package.json
corepack pnpm dist:desktop:win:x64

# Alpha
(Get-Content apps/desktop/package.json) `
  -replace '"productName": "T3 Code \([^)]+\)"', `
           '"productName": "T3 Code (Alpha)"' `
  | Set-Content apps/desktop/package.json
corepack pnpm dist:desktop:win:x64

# Dev
(Get-Content apps/desktop/package.json) `
  -replace '"productName": "T3 Code \([^)]+\)"', `
           '"productName": "T3 Code (Dev)"' `
  | Set-Content apps/desktop/package.json
corepack pnpm dist:desktop:win:x64

# 把 productName 还原到 Experimental 留给下一次构建
(Get-Content apps/desktop/package.json) `
  -replace '"productName": "T3 Code \([^)]+\)"', `
           '"productName": "T3 Code (Experimental)"' `
  | Set-Content apps/desktop/package.json
```

每次 `dist:desktop:win:x64` 会在 `release/` 下产出形如
`T3-Code-T3Code<Stage>-0.0.42-fork-1-x64.exe` 的安装包。

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
# 安装一个
pwsh .\scripts\fork-build\install-fork.ps1 -Stage Alpha

# 一次性装完三个
pwsh .\scripts\fork-build\install-fork.ps1 -Stage All -Force
```

`-Force` 在安装前 `Stop-Process` 所有运行中的 `T3 Code*` 和
`t3-resource-monitor`，避免 silent 模式被运行进程阻塞。

### 手动重装时的等价命令

如果不方便用脚本，可以把这两步复制粘贴到 PowerShell：

```powershell
$reg = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
Get-ChildItem -Path $reg | ForEach-Object {
  $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DisplayName -like "T3 Code (Alpha)*" -or
      $p.DisplayName -like "T3 Code (Experimental)*" -or
      $p.DisplayName -like "T3 Code (Dev)*") {
    Remove-Item -Path $_.PSPath -Recurse -Force
  }
}
& "C:\Users\87500\Downloads\T3-Code-Alpha-0.0.42-fork-1-x64.exe" /S
& "C:\Users\87500\Downloads\T3-Code-Experimental-0.0.42-fork-1-x64.exe" /S
& "C:\Users\87500\Downloads\T3-Code-Dev-0.0.42-fork-1-x64.exe" /S
```

> 注意：`& "路径" /S` 在中文 (chcp 936) PowerShell 下会因为调用
> 解析问题报 `CommandNotFoundException`。请优先使用上面的脚本，
> 或在 `cmd` 下运行（先把 `.exe` 文件名复制对，GBK 编码下文件名
> 不会乱码）。

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
`DesktopStatePaths.ts`）后跑：

```powershell
corepack pnpm typecheck
corepack pnpm exec vp test run --passWithNoTests `
  apps/desktop/src/electron/ElectronProtocol.test.ts `
  apps/desktop/src/app/DesktopUserData.test.ts `
  apps/desktop/src/app/DesktopAppIdentity.test.ts `
  apps/desktop/src/app/DesktopEnvironment.test.ts `
  apps/desktop/src/app/DesktopStatePaths.test.ts `
  apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts `
  apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
```

预期 62 个用例全过；`scripts/build-desktop-artifact.test.ts` 中
7 个 cargo 路径相关的失败是 pre-existing 环境依赖，与 fork 改动
无关。

## 后续 PR / 分支

每次上游/其他分支合入后再构建，安装脚本不变，只需把
`release/` 下的新 `.exe` 指给脚本即可：

```powershell
pwsh .\scripts\fork-build\install-fork.ps1 -Stage All `
  -InstallerPath release\T3-Code-T3CodeAlpha-0.0.42-fork-2-x64.exe
```

或者用 glob 自动挑最新的：

```powershell
pwsh .\scripts\fork-build\install-fork.ps1 -Stage All
```
