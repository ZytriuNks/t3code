# Web 简体中文汉化第二部分批次 3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 T3 Code Web 设置页中“集成”和“源代码管理”页面及其直接关联弹窗、状态、Toast、Tooltip、占位符与无障碍文案的简体中文汉化。

**Architecture:** 继续使用 `apps/web/src/i18n/messages.ts` 的类型安全中英文字典和组件内 `useI18n()`。设置标题通过 `searchableSetting(id, t)` 复用搜索消息；动态环境名、浏览器名、配置文件名、主机名、路径、版本、域名和原始错误保持原文。纯展示函数只接收语言或翻译函数，不读取全局状态。

**Tech Stack:** React 19、TypeScript、Vite+ Test、现有 Web i18n Context。

## Global Constraints

- 英文仍是默认语言，中英字典键集合必须完全一致。
- 不新增第三方依赖、全局状态或翻译抽象。
- 不修改设置存储、搜索排序、连接、设备或源代码管理业务逻辑。
- 品牌名、产品名、命令、路径、Git 引用、浏览器/提供商/模型名以及后端原始错误保持原文。
- 每个页面先写失败测试，再做最小接线。
- 诊断、资源监控、许可证、移动端和桌面原生菜单不在本批次范围内。

---

### Task 1: 集成、浏览器导入与设备设置测试

**Files:**

- Modify: `apps/web/src/components/settings/IntegrationsSettings.test.tsx`
- Create: `apps/web/src/components/settings/BrowserImportWizard.i18n.test.tsx`
- Modify: `apps/web/src/components/settings/browserImportWizard.logic.test.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`

**Interfaces:**

- Consumes: `I18nProvider`、现有 `language` 客户端设置、`translate(language, key, values)`。
- Produces: 集成主页和浏览器导入向导的中英文渲染回归测试；跳过域名摘要的中英文格式断言。

- [ ] **Step 1: 为集成主页增加中文渲染测试**

在现有设置测试中用可变语言状态驱动 `I18nProvider`，并验证搜索标题、分区标题和无障碍标签：

```tsx
languageState.current = "zh-CN";
await openSettings();
expect(textContents()).toContain("浏览器");
expect(textContents()).toContain("浏览器配置文件");
expect(textContents()).toContain("默认浏览器视口");
expect(textContents()).toContain("设备");
expect(accessibleNames()).toContain("默认浏览器视口");
```

- [ ] **Step 2: 为浏览器导入向导增加中文渲染测试**

使用浏览器名 `Helium`、目标环境名 `Dev Box` 和配置文件名 `Work`，验证界面外壳翻译而动态值保持原文：

```tsx
expect(textContents()).toContain("从 Helium 导入");
expect(textContents()).toContain("选择要为 Dev Box 导入的 Cookie。");
expect(textContents()).toContain("Work");
expect(textContents()).toContain("导入");
```

- [ ] **Step 3: 为跳过域名摘要增加中文测试**

```ts
expect(formatSkippedDomains(["a.com", "b.com"], "zh-CN")).toBe("a.com、b.com");
expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"], "zh-CN")).toBe(
  "a.com、b.com、c.com及另外 2 个",
);
```

- [ ] **Step 4: 为新增消息增加字典断言**

```ts
expect(translate("zh-CN", "settings.integrations.section.browser")).toBe("浏览器");
expect(translate("zh-CN", "settings.browserImport.importFrom", { source: "Helium" })).toBe(
  "从 Helium 导入",
);
expect(translate("zh-CN", "settings.devices.section.title")).toBe("设备");
```

- [ ] **Step 5: 运行测试并确认缺少消息或接线导致失败**

Run:

```powershell
corepack pnpm test --run src/components/settings/IntegrationsSettings.test.tsx src/components/settings/BrowserImportWizard.i18n.test.tsx src/components/settings/browserImportWizard.logic.test.ts src/i18n/messages.test.ts
```

Working directory: `apps/web`

Expected: 新中文断言失败；原有业务测试继续通过。

### Task 2: 集成、浏览器导入与设备设置实现

**Files:**

- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/components/settings/IntegrationsSettings.tsx`
- Modify: `apps/web/src/components/settings/BrowserImportWizard.tsx`
- Modify: `apps/web/src/components/settings/browserImportWizard.logic.ts`
- Modify: `apps/web/src/components/settings/DeviceHostsSettings.tsx`
- Modify: `apps/web/src/components/settings/DeviceHostEditor.tsx`
- Modify: `apps/web/src/components/device/DeviceSetup.tsx`
- Modify: `apps/web/src/components/device/DeviceHostAvailability.tsx`

**Interfaces:**

- Consumes: `useI18n(): { language, t }` 和 `searchableSetting(id, t)`。
- Produces: `settings.integrations.*`、`settings.browserImport.*`、`settings.devices.*` 消息组；`formatSkippedDomains(domains, language)`；`platformSetupStatus(state, platform, t)`。

- [ ] **Step 1: 添加完整中英文消息组**

消息键覆盖浏览器默认值、配置文件管理、导入向导、设备中心、模拟器状态、远程设备主机和编辑器。例如：

```ts
"settings.integrations.section.browser": "Browser",
"settings.integrations.viewport.description":
  "Tab size for you and agents. Fill fits the panel; other sizes show the device toolbar.",
"settings.browserImport.importFrom": "Import from {source}",
"settings.browserImport.destination": "Choose which cookies to import for {environment}.",
"settings.devices.section.title": "Devices",
"settings.devices.hosts.add": "Add host",
```

对应中文：

```ts
"settings.integrations.section.browser": "浏览器",
"settings.integrations.viewport.description":
  "你和代理使用的标签页尺寸。填充会适配面板，其他尺寸会显示设备工具栏。",
"settings.browserImport.importFrom": "从 {source} 导入",
"settings.browserImport.destination": "选择要为 {environment} 导入的 Cookie。",
"settings.devices.section.title": "设备",
"settings.devices.hosts.add": "添加主机",
```

浏览器导入失败原因按 `BrowserImportFailureReason` 建立完整键映射，避免继续渲染共享契约中的英文 `BROWSER_IMPORT_FAILURE_COPY`。

- [ ] **Step 2: 接入集成页浏览器默认值和配置文件管理**

每个相关组件在渲染处读取翻译，并让设置标题复用搜索消息：

```tsx
const { t } = useI18n();
const setting = searchableSetting("browser-default-viewport", t);

<SettingsRow
  {...setting}
  description={t("settings.integrations.viewport.description")}
  control={<SelectTrigger aria-label={t("settings.integrations.viewport.ariaLabel")} />}
/>;
```

保留预设名称、尺寸、百分比、FPS、浏览器名和配置文件名原文。

- [ ] **Step 3: 接入浏览器导入向导**

```tsx
const { language, t } = useI18n();
<DialogTitle>{t("settings.browserImport.importFrom", { source: source.name })}</DialogTitle>
<DialogDescription>
  {t("settings.browserImport.destination", { environment: destinationEnvironmentName })}
</DialogDescription>
```

Cookie 数量使用中英文单复数消息；失败页通过原因到消息键的完整映射翻译；域名本身保持原文。

- [ ] **Step 4: 接入设备与远程主机界面**

`DeviceSetup`、`DeviceHostsSettings`、`DeviceHostEditor` 和 `DeviceHostAvailability` 就地调用 `useI18n()`。`platformSetupStatus` 改为显式接收 `t`：

```ts
export function platformSetupStatus(
  state: DeviceServiceState,
  platform: DevicePlatform,
  t: I18nContextValue["t"],
) {
  /* 只翻译已知状态，availability.reason 原样返回 */
}
```

远程主机标签、目标地址和连接失败原始详情保持原文。

- [ ] **Step 5: 运行集成相关测试**

Run:

```powershell
corepack pnpm test --run src/components/settings/IntegrationsSettings.test.tsx src/components/settings/IntegrationsSettings.logic.test.ts src/components/settings/BrowserImportWizard.i18n.test.tsx src/components/settings/browserImportWizard.logic.test.ts src/components/settings/deviceHostsSettings.logic.test.ts src/components/settings/deviceHostConnectionChecks.test.ts src/i18n/messages.test.ts
```

Expected: 全部通过。

- [ ] **Step 6: 提交集成与设备汉化**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/IntegrationsSettings.tsx apps/web/src/components/settings/IntegrationsSettings.test.tsx apps/web/src/components/settings/BrowserImportWizard.tsx apps/web/src/components/settings/BrowserImportWizard.i18n.test.tsx apps/web/src/components/settings/browserImportWizard.logic.ts apps/web/src/components/settings/browserImportWizard.logic.test.ts apps/web/src/components/settings/DeviceHostsSettings.tsx apps/web/src/components/settings/DeviceHostEditor.tsx apps/web/src/components/device/DeviceSetup.tsx apps/web/src/components/device/DeviceHostAvailability.tsx
git commit -m "feat(web): localize integration settings"
```

### Task 3: 源代码管理测试与实现

**Files:**

- Create: `apps/web/src/components/settings/SourceControlSettings.i18n.test.tsx`
- Modify: `apps/web/src/components/settings/SourceControlWritingSettings.test.tsx`
- Modify: `apps/web/src/components/settings/GitHubRoutingSettings.test.ts`
- Modify: `apps/web/src/components/settings/SourceControlSettings.tsx`
- Modify: `apps/web/src/components/settings/SourceControlWritingSettings.tsx`
- Modify: `apps/web/src/components/settings/GitHubRoutingSettings.tsx`
- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`

**Interfaces:**

- Consumes: `useI18n()`、`searchableSetting(id, t)`。
- Produces: `settings.sourceControl.*` 消息组；可本地化的 GitHub 路由汇总标签。

- [ ] **Step 1: 增加源代码管理中文渲染测试**

在无已连接环境状态下渲染面板并断言：

```tsx
expect(textContents()).toContain("服务器环境");
expect(textContents()).toContain("连接一个环境以检查其版本控制工具和托管集成。");
expect(textContents()).toContain("文本生成");
```

在写作设置测试中切换为 `zh-CN` 并断言“为全部环境编写自定义指令”“遵循更改请求模板”“源代码管理写作模型”。

- [ ] **Step 2: 增加 GitHub 路由中文汇总测试**

```ts
expect(
  summarizeGitHubRouting(entries, (permission) =>
    permission === "read-write" ? "可读取并操作" : "可读取 PR",
  ),
).toBe("bb-1 可读取并操作 · alvin 可读取 PR");
```

- [ ] **Step 3: 运行源代码管理测试并确认失败**

Run:

```powershell
corepack pnpm test --run src/components/settings/SourceControlSettings.i18n.test.tsx src/components/settings/SourceControlWritingSettings.test.tsx src/components/settings/GitHubRoutingSettings.test.ts src/i18n/messages.test.ts
```

Expected: 新中文断言失败；原有写作设置和汇总行为测试继续通过。

- [ ] **Step 4: 添加消息并接入三个组件**

```tsx
const { t } = useI18n();
const setting = searchableSetting("git-fetch-interval", t);
```

翻译扫描状态、认证状态、版本控制/托管分区、Git 获取间隔、写作风格、模板、模型、GitHub 路由权限和失败 Toast。`item.label`、`item.version`、`installHint`、认证账号和原始错误详情保持原文。

- [ ] **Step 5: 运行源代码管理测试**

Run:

```powershell
corepack pnpm test --run src/components/settings/SourceControlSettings.i18n.test.tsx src/components/settings/SourceControlWritingSettings.test.tsx src/components/settings/GitHubRoutingSettings.test.ts src/components/settings/settingsSearch.test.ts src/i18n/messages.test.ts
```

Expected: 全部通过。

- [ ] **Step 6: 提交源代码管理汉化**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/SourceControlSettings.tsx apps/web/src/components/settings/SourceControlSettings.i18n.test.tsx apps/web/src/components/settings/SourceControlWritingSettings.tsx apps/web/src/components/settings/SourceControlWritingSettings.test.tsx apps/web/src/components/settings/GitHubRoutingSettings.tsx apps/web/src/components/settings/GitHubRoutingSettings.test.ts
git commit -m "feat(web): localize source control settings"
```

### Task 4: 批次 3 残余审计与验证

**Files:**

- Audit: `apps/web/src/components/settings/IntegrationsSettings.tsx`
- Audit: `apps/web/src/components/settings/BrowserImportWizard.tsx`
- Audit: `apps/web/src/components/settings/DeviceHostsSettings.tsx`
- Audit: `apps/web/src/components/settings/DeviceHostEditor.tsx`
- Audit: `apps/web/src/components/device/DeviceSetup.tsx`
- Audit: `apps/web/src/components/device/DeviceHostAvailability.tsx`
- Audit: `apps/web/src/components/settings/SourceControlSettings.tsx`
- Audit: `apps/web/src/components/settings/SourceControlWritingSettings.tsx`
- Audit: `apps/web/src/components/settings/GitHubRoutingSettings.tsx`

**Interfaces:**

- Consumes: 本批次全部消息和组件接线。
- Produces: 无遗漏的批次 3 范围与验证证据。

- [ ] **Step 1: 扫描残余英文**

逐项确认命中属于注释、测试夹具、动态技术值或真实遗漏；修复真实遗漏，不改业务逻辑。

- [ ] **Step 2: 运行全部批次 3 定向测试**

```powershell
corepack pnpm test --run src/i18n/messages.test.ts src/components/settings/settingsSearch.test.ts src/components/settings/IntegrationsSettings.test.tsx src/components/settings/IntegrationsSettings.logic.test.ts src/components/settings/BrowserImportWizard.i18n.test.tsx src/components/settings/browserImportWizard.logic.test.ts src/components/settings/deviceHostsSettings.logic.test.ts src/components/settings/deviceHostConnectionChecks.test.ts src/components/settings/SourceControlSettings.i18n.test.tsx src/components/settings/SourceControlWritingSettings.test.tsx src/components/settings/GitHubRoutingSettings.test.ts
```

Expected: 全部通过。

- [ ] **Step 3: 运行 Web 类型检查**

```powershell
corepack pnpm typecheck
```

Working directory: `apps/web`

Expected: 退出码 0。

- [ ] **Step 4: 运行格式、lint 与差异检查**

```powershell
corepack pnpm exec vp fmt --check apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/IntegrationsSettings.tsx apps/web/src/components/settings/BrowserImportWizard.tsx apps/web/src/components/settings/DeviceHostsSettings.tsx apps/web/src/components/settings/DeviceHostEditor.tsx apps/web/src/components/device/DeviceSetup.tsx apps/web/src/components/device/DeviceHostAvailability.tsx apps/web/src/components/settings/SourceControlSettings.tsx apps/web/src/components/settings/SourceControlWritingSettings.tsx apps/web/src/components/settings/GitHubRoutingSettings.tsx
git diff --check HEAD~2..HEAD
git status --short
```

Expected: 格式和差异检查通过；工作树仅允许保留本实施计划文件，代码修改均已提交。
