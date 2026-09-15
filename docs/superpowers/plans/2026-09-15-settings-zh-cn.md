# Settings Simplified Chinese Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变设置状态、路由、布局和交互的前提下，完成设置顶栏、作用域、搜索、常规页和外观页的简体中文本地化，并保留完整英文搜索能力。

**Architecture:** 继续使用 `apps/web/src/i18n/messages.ts` 作为唯一词典入口。设置目录保留英文标题和关键词，同时增加类型安全的消息键；搜索函数将英文静态字段与当前语言字段合并。目标页面通过现有 `useI18n()` 取文案，共享设置控件通过无 DOM 的上下文接收可选本地化文案，避免让排除范围内的页面出现零散正文翻译。

**Tech Stack:** TypeScript、React 19、Vite+ Test、现有 `I18nProvider`、TanStack Router、Base UI 设置控件。

## Global Constraints

- 基础提交为 `6ecc15fa25c808922a58f07377add25b55d9ac90`，基础汉化来自 `edd8003b7f4053d605e646a2f6d0074b7901330d`；不得改动或重写 `feat/web-zh-cn`。
- `apps/web/src/i18n/messages.ts` 是唯一消息词典入口；`MessageKey` 继续由英文词典推导，中文词典继续满足 `Record<MessageKey, string>`。
- 只完整汉化设置顶栏、作用域、搜索、常规页和外观页；其他设置分类只允许分类名、面包屑和搜索结果标题显示中文。
- `GitHub`、`WSL`、`T3 Connect`、模型名、提供商名、主题名、扩展名、路径、文件名、命令、快捷键、配置键、版本号、URL、项目名、环境名和原始错误详情保持原文。
- 不修改 DOM 层级、元素类型、`className`、控件宽度、滚动、折叠结构、路由、稳定 ID、作用域规则、设置值、默认值、持久化格式、异步流程和事件处理。
- 搜索保留原英文标题和关键词；中文标题与中文关键词命中同一设置项；英文查询排名和目录顺序不变。
- 动态内容必须使用现有 `{name}` 插值，不在组件内拼接翻译句子。
- 所有行为修改遵循 RED → GREEN：先写失败测试并确认失败原因，再写最小实现。
- Windows 下所有验证显式调用当前隔离工作树的 `node_modules/.bin/vp.cmd`，不得使用 PATH 中可能指向其他工作树的 `vp`。

---

## File Structure

### Core dictionary and search

- Modify: `apps/web/src/i18n/messages.ts` — 增加 `settings.header.*`、`settings.scope.*`、`settings.general.*`、`settings.appearance.*` 和 `settings.search.item.*` 词典项。
- Modify: `apps/web/src/i18n/messages.test.ts` — 锁定词典完整性、代表性翻译和动态值保留行为。
- Modify: `apps/web/src/components/settings/settingsSearch.ts` — 保存消息键、解析本地化标题、合并双语搜索字段并保持现有排名。
- Modify: `apps/web/src/components/settings/settingsSearch.test.ts` — 锁定中文与英文命中、排序、路由、作用域和稳定 ID。
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx` — 向搜索函数传入 `t` 并显示本地化结果标题。

### Header and scope

- Modify: `apps/web/src/components/settings/SettingsBreadcrumb.tsx` — 本地化面包屑、作用域菜单和无障碍标签。
- Create: `apps/web/src/components/settings/SettingsBreadcrumb.test.tsx` — 覆盖中英文标题及动态名称保留。
- Modify: `apps/web/src/components/settings/SettingsScopeNotice.tsx` — 本地化作用域选择操作。
- Modify: `apps/web/src/routes/settings.tsx` — 本地化恢复默认值、作用域边界提示及搜索目标标题。

### Shared settings copy and General

- Modify: `apps/web/src/components/settings/settingsLayout.tsx` — 增加无 DOM 的目标页文案上下文，保留英文默认值。
- Modify: `apps/web/src/components/settings/settingsLayout.test.tsx` — 验证上下文只替换显示文案，不改变行结构和目标行为。
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx` — 本地化常规页及其弹窗、Toast、枚举标签和无障碍文本。
- Modify: `apps/web/src/components/settings/NotificationSettings.tsx` — 本地化通知选项和权限提示。
- Create: `apps/web/src/components/settings/NotificationSettings.test.tsx` — 代表性渲染与权限失败文案测试。
- Modify: `apps/web/src/components/settings/ProjectDefaultsSettings.tsx` — 只本地化 `category === "general"` 分支。

### Appearance and theme workflows

- Modify: `apps/web/src/components/settings/SettingsPanels.tsx` — 本地化外观页基础设置、字体设置和动画设置。
- Modify: `apps/web/src/components/settings/PanelAnimationsPreview.tsx` — 本地化重放预览的无障碍名称。
- Modify: `apps/web/src/components/settings/SettingsFontPreviews.tsx` — 本地化字体预览中的应用自有提示和无障碍名称；示例命令保持原文。
- Modify: `apps/web/src/components/settings/FontFamilyPicker.tsx` — 本地化字体发现状态、操作和无障碍名称；字体名保持原文。
- Modify: `apps/web/src/components/settings/ThemeSettings.tsx` — 本地化主题库操作、显示模式、删除确认和 Toast。
- Modify: `apps/web/src/components/settings/ThemePreviewCircles.tsx` — 本地化模式选择操作；主题名保持原文。
- Modify: `apps/web/src/components/settings/ThemeImportDialog.tsx` — 本地化导入流程、状态、错误外壳和无障碍名称。
- Modify: `apps/web/src/components/settings/ThemeSearchSection.tsx` — 本地化 Open VSX 搜索、排序、安装和失败状态；扩展名与第三方说明保持原文。
- Modify: `apps/web/src/components/settings/ThemeEditorHost.tsx` — 本地化保存结果 Toast，保留主题名。
- Modify: `apps/web/src/components/settings/ThemeEditorPanel.tsx` — 本地化编辑器分组、字段、状态、按钮和无障碍名称。
- Modify: `apps/web/src/components/settings/ThemeColorPicker.tsx` — 本地化颜色角色、选择器提示和无障碍名称。
- Modify: `apps/web/src/components/settings/ThemeEditorHost.test.tsx` — 锁定本地化 Toast 与动态主题名。
- Create: `apps/web/src/components/settings/ThemeSettings.i18n.test.tsx` — 覆盖显示模式、主题操作与错误提示的代表性输出。

---

### Task 1: 建立双语设置搜索目录

**Files:**

- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`
- Modify: `apps/web/src/components/settings/settingsSearch.ts`
- Modify: `apps/web/src/components/settings/settingsSearch.test.ts`
- Modify: `apps/web/src/components/settings/SettingsSidebarNav.tsx`

**Interfaces:**

- Consumes: `MessageKey`、`MessageValues`、`translate(language, key, values)`、现有 `SettingsSearchItem` 目录。
- Produces:
  - `SettingsSearchItem.titleKey?: Extract<MessageKey, \`settings.search.item.${string}.title\`>`
  - `SettingsSearchItem.localizedSearchTermsKey?: Extract<MessageKey, \`settings.search.item.${string}.keywords\`>`
  - `settingsSearchItemTitle(item, t?): string`
  - `searchableSetting(id, t?): { id: string; title: string }`
  - `getSettingsSearchTargetScope(targetId, t?)`
  - `searchSettings(query, items?, t?): ReadonlyArray<SettingsSearchItem>`
  - `SETTINGS_SECTION_MESSAGE_KEYS: Readonly<Record<SettingsPath, MessageKey>>`

- [ ] **Step 1: 写入失败的消息和目录完整性测试**

在 `messages.test.ts` 增加代表性键和值测试：

```ts
it("translates settings search item titles and keywords", () => {
  expect(translate("zh-CN", "settings.search.item.default-model.title")).toBe("默认模型");
  expect(translate("zh-CN", "settings.search.item.default-model.keywords")).toContain("新线程");
  expect(translate("zh-CN", "settings.search.item.wsl-backend.title")).toBe("WSL 后端");
  expect(translate("zh-CN", "settings.search.item.t3-connect.title")).toBe("T3 Connect");
});
```

在 `settingsSearch.test.ts` 增加键命名和双语命中测试：

```ts
it("gives every catalog item stable typed message keys", () => {
  for (const item of SETTINGS_SEARCH_ITEMS) {
    expect(item.titleKey).toBe(`settings.search.item.${item.id}.title`);
    expect(item.localizedSearchTermsKey).toBe(`settings.search.item.${item.id}.keywords`);
  }
});

it.each([
  ["默认模型", "default-model"],
  ["新线程 推理强度", "default-model"],
  ["主题", "theme"],
  ["远程 配对", "network-access"],
  ["WSL", "wsl-backend"],
])("finds %s in Simplified Chinese", (query, id) => {
  expect(searchSettings(query, SETTINGS_SEARCH_ITEMS, zh).some((item) => item.id === id)).toBe(
    true,
  );
});

it("keeps English and Chinese queries on the same stable target", () => {
  expect(searchSettings("default model", SETTINGS_SEARCH_ITEMS, zh)[0]?.id).toBe("default-model");
  expect(searchSettings("默认模型", SETTINGS_SEARCH_ITEMS, zh)[0]?.id).toBe("default-model");
});
```

测试文件定义真实翻译函数，不使用模拟返回值：

```ts
const zh = (key: MessageKey, values?: MessageValues) => translate("zh-CN", key, values);
```

- [ ] **Step 2: 运行新测试并确认 RED**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/settingsSearch.test.ts
```

Expected: FAIL，因为搜索项消息键及第三个 `t` 参数尚不存在；现有英文搜索断言仍应通过编译前已覆盖的部分。

- [ ] **Step 3: 增加搜索消息键和类型安全目录字段**

对每个 `SETTINGS_SEARCH_ITEMS` 项增加与 `id` 一致的键：

```ts
{
  id: "default-model",
  title: "Default model",
  titleKey: "settings.search.item.default-model.title",
  localizedSearchTermsKey: "settings.search.item.default-model.keywords",
  to: "/settings/general",
  scope: "project-defaults",
  searchTerms: ["new thread project provider reasoning effort"],
}
```

所有生产目录项都使用由自身 `id` 生成的同一规则：

```ts
const titleKey = `settings.search.item.${item.id}.title`;
const localizedSearchTermsKey = `settings.search.item.${item.id}.keywords`;
```

英文 `*.title` 与当前 `title` 完全一致；英文 `*.keywords` 与当前 `searchTerms` 合并后的内容一致。中文 `*.title` 翻译显示标题，中文 `*.keywords` 写入对应中文概念词，同时原样保留品牌、协议、命令和缩写。

类型定义使用消息键子集：

```ts
export type SettingsSearchItemTitleKey = Extract<
  MessageKey,
  `settings.search.item.${string}.title`
>;
export type SettingsSearchItemKeywordsKey = Extract<
  MessageKey,
  `settings.search.item.${string}.keywords`
>;

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly titleKey?: SettingsSearchItemTitleKey;
  readonly localizedSearchTermsKey?: SettingsSearchItemKeywordsKey;
  // existing fields remain unchanged
}
```

字段保持可选，以兼容测试和调用方构造的临时英文目录项；`SETTINGS_SEARCH_ITEMS` 中的每个生产项必须填写两个键，并由 Step 1 的命名测试强制完整。

- [ ] **Step 4: 实现双语标题解析和搜索排名**

把分类消息键从 `SettingsSidebarNav.tsx` 移到 `settingsSearch.ts` 并导出。增加可选翻译函数，未传入时保持英文：

```ts
export type SettingsTranslator = (key: MessageKey, values?: MessageValues) => string;

export function settingsSearchItemTitle(item: SettingsSearchItem, t?: SettingsTranslator): string {
  return t && item.titleKey ? t(item.titleKey) : item.title;
}

export function searchableSetting(
  id: SettingsSearchItemId,
  t?: SettingsTranslator,
): { readonly id: string; readonly title: string } {
  const item = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: item.id, title: settingsSearchItemTitle(item, t) };
}
```

`searchSettings` 的字段和排名实现为：

```ts
const englishTitle = normalizeSearchText(item.title);
const localizedTitle = normalizeSearchText(settingsSearchItemTitle(item, t));
const titles = [...new Set([englishTitle, localizedTitle])];
const fields = [
  ...titles,
  normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
  ...(item.searchTerms ?? []).map(normalizeSearchText),
  ...(t ? [normalizeSearchText(t(SETTINGS_SECTION_MESSAGE_KEYS[item.to]))] : []),
  ...(t && item.localizedSearchTermsKey
    ? [normalizeSearchText(t(item.localizedSearchTermsKey))]
    : []),
];

const titleRank = (title: string) =>
  title === normalizedQuery
    ? 5
    : title.startsWith(normalizedQuery)
      ? 4
      : title.includes(normalizedQuery)
        ? 3
        : queryTokens.every((token) => title.includes(token))
          ? 2
          : 0;
const rank = Math.max(
  ...titles.map(titleRank),
  fields.some((field) => field.includes(normalizedQuery)) ? 1 : 0,
);
```

保留现有逐 token 过滤和最终排序：

```ts
.toSorted((left, right) => right.rank - left.rank || left.index - right.index)
```

`getSettingsSearchTargetScope(targetId, t?)` 使用 `settingsSearchItemTitle(item, t)` 返回标题。

- [ ] **Step 5: 接入搜索侧栏**

`SettingsSidebarNav.tsx` 使用：

```ts
const results = useMemo(
  () => searchSettings(query, searchableItems, t),
  [query, searchableItems, t],
);
```

结果标题改为：

```tsx
{
  settingsSearchItemTitle(item, t);
}
```

删除该文件内重复的 `SETTINGS_SECTION_MESSAGE_KEYS`，从 `settingsSearch.ts` 导入。

- [ ] **Step 6: 运行双语搜索测试并确认 GREEN**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/settingsSearch.test.ts
```

Expected: 两个文件全部 PASS；原英文排序、路由和可用性测试保持通过。

- [ ] **Step 7: 提交搜索目录改动**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/components/settings/SettingsSidebarNav.tsx
git commit -m "feat(web): localize settings search"
```

---

### Task 2: 本地化设置顶栏、面包屑和作用域

**Files:**

- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`
- Modify: `apps/web/src/components/settings/SettingsBreadcrumb.tsx`
- Create: `apps/web/src/components/settings/SettingsBreadcrumb.test.tsx`
- Modify: `apps/web/src/components/settings/SettingsScopeNotice.tsx`
- Modify: `apps/web/src/routes/settings.tsx`

**Interfaces:**

- Consumes: Task 1 的 `SETTINGS_SECTION_MESSAGE_KEYS`、`settingsSearchItemTitle` 和支持 `t` 的 `getSettingsSearchTargetScope`。
- Produces: 顶栏与作用域组件的双语渲染；不新增路由或设置状态接口。

- [ ] **Step 1: 写入失败的面包屑和动态值测试**

`SettingsBreadcrumb.test.tsx` 使用与 `I18nProvider.test.tsx` 相同的语言状态 mock，并覆盖：

```tsx
await act(() => {
  renderer = create(
    <I18nProvider>
      <SettingsBreadcrumb pathname="/settings/appearance" />
    </I18nProvider>,
  );
});

const json = JSON.stringify(renderer!.toJSON());
expect(json).toContain("设置");
expect(json).toContain("外观");
expect(json).toContain("设置面包屑");
```

增加带作用域的用例，使用固定项目名 `My Project` 和环境名 `Dev Box`，断言中文“全部环境”“全部项目”“离线”出现，而两个动态名称保持原文。

`messages.test.ts` 增加：

```ts
expect(translate("zh-CN", "settings.header.restoreDeviceDefaults")).toBe("恢复设备默认值");
expect(
  translate("zh-CN", "settings.scope.reconnectEnvironment", { environment: "Dev Box" }),
).toContain("Dev Box");
```

- [ ] **Step 2: 运行顶栏测试并确认 RED**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/SettingsBreadcrumb.test.tsx
```

Expected: FAIL，因为 `settings.header.*`、`settings.scope.*` 和组件接入尚不存在。

- [ ] **Step 3: 实现面包屑和作用域翻译**

`SettingsBreadcrumb.tsx` 调用 `useI18n()`。分类映射保留诊断详情页：

```ts
const SETTINGS_BREADCRUMB_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  ...SETTINGS_SECTION_MESSAGE_KEYS,
  "/settings/diagnostics": "settings.general.diagnostics.title",
  "/settings/open-source-licenses": "settings.general.openSourceLicenses.title",
};
```

以下文本全部改为 `t(...)`：设置面包屑 `aria-label`、设置、分类、环境作用域、项目作用域、全部环境、全部项目、不可用环境、不可用项目、离线。动态 `selected.label`、`group.displayName` 和路径不传入词典。

- [ ] **Step 4: 实现设置路由与作用域提示翻译**

`routes/settings.tsx` 读取 `t` 并调用：

```ts
const searchTarget = getSettingsSearchTargetScope(hash, t);
```

恢复按钮接收翻译后的标签，或在按钮内部调用 `useI18n()`：

```tsx
{
  t("settings.header.restoreDeviceDefaults");
}
```

现有作用域提示改用带插值的词典模板：

```tsx
t("settings.scope.requiresSupportingEnvironment.choose", {
  setting: searchTarget.title,
});
```

`SettingsScopeNotice.tsx` 把“Open all environments”和 checkout 组合标签中的固定“Environment”改为消息键；项目名、环境名和工作区路径仍原样拼入显示结构。

- [ ] **Step 5: 运行顶栏和既有作用域测试并确认 GREEN**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/SettingsBreadcrumb.test.tsx src/components/settings/settingsScope.test.ts src/components/settings/settingsScopeAxis.test.ts src/components/settings/settingsScopeNavigation.test.ts
```

Expected: 全部 PASS，作用域选择和路由保持原行为。

- [ ] **Step 6: 提交顶栏和作用域改动**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/SettingsBreadcrumb.tsx apps/web/src/components/settings/SettingsBreadcrumb.test.tsx apps/web/src/components/settings/SettingsScopeNotice.tsx apps/web/src/routes/settings.tsx
git commit -m "feat(web): localize settings header"
```

---

### Task 3: 本地化常规设置页

**Files:**

- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`
- Modify: `apps/web/src/components/settings/settingsLayout.tsx`
- Modify: `apps/web/src/components/settings/settingsLayout.test.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/NotificationSettings.tsx`
- Create: `apps/web/src/components/settings/NotificationSettings.test.tsx`
- Modify: `apps/web/src/components/settings/ProjectDefaultsSettings.tsx`

**Interfaces:**

- Consumes: Task 1 的 `searchableSetting(id, t?)`。
- Produces:
  - `SettingsRowCopy`：共享设置行固定文案。
  - `SettingsRowCopyProvider({ copy, children })`：只提供 React Context，不输出 DOM。
  - 常规页完整中文显示，其他分类继续使用英文默认 copy。

- [ ] **Step 1: 写入失败的共享设置行和通知组件测试**

在 `settingsLayout.test.tsx` 增加中文 copy 测试：

```tsx
const copy: SettingsRowCopy = {
  resetToInheritedTooltip: "恢复继承值",
  resetToDefaultTooltip: "恢复默认值",
  resetToInheritedLabel: (label) => `将${label}恢复为继承值`,
  resetToDefaultLabel: (label) => `将${label}恢复为默认值`,
  reconnectSelectedEnvironment: "请重新连接所选环境后再更改此设置。",
  selectEnvironment: "这是环境级设置，请选择一个环境后再更改。",
  mixedAcrossEnvironments: "所选环境中的值不一致",
  overriddenForProject: "已为此项目覆盖",
  inheritedFrom: (source) => `继承自 ${source}`,
  setOnEnvironment: "已在环境中设置",
  builtInDefault: "内置默认值",
};
```

使用 `SettingsRowCopyProvider` 包裹现有 `SettingsRow`，断言中文文本出现且 `id="word-wrap" tabindex="-1"` 等结构断言不变。

`NotificationSettings.test.tsx` mock `useScopedSettings` 为 `notificationMode: "notifications"`、mock 更新函数，使用真实 `I18nProvider` 渲染后断言：

```ts
expect(markup).toContain("线程通知");
expect(markup).toContain("系统通知");
expect(markup).toContain('aria-label="线程通知"');
```

另一个用例让 `Notification` 不可用并触发选择，断言 HTTPS/桌面应用提示为中文。

- [ ] **Step 2: 运行常规页代表性测试并确认 RED**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/settingsLayout.test.tsx src/components/settings/NotificationSettings.test.tsx
```

Expected: FAIL，因为 copy context、常规页消息键和通知翻译尚不存在。

- [ ] **Step 3: 增加共享设置行 copy context**

`settingsLayout.tsx` 定义英文默认值，保证排除范围页面不变：

```ts
export interface SettingsRowCopy {
  readonly resetToInheritedTooltip: string;
  readonly resetToDefaultTooltip: string;
  readonly resetToInheritedLabel: (label: string) => string;
  readonly resetToDefaultLabel: (label: string) => string;
  readonly reconnectSelectedEnvironment: string;
  readonly selectEnvironment: string;
  readonly mixedAcrossEnvironments: string;
  readonly overriddenForProject: string;
  readonly inheritedFrom: (source: string) => string;
  readonly setOnEnvironment: string;
  readonly builtInDefault: string;
}

const SettingsRowCopyContext = createContext<SettingsRowCopy>(EN_SETTINGS_ROW_COPY);

export function SettingsRowCopyProvider({
  copy,
  children,
}: {
  readonly copy: SettingsRowCopy;
  readonly children: ReactNode;
}) {
  return <SettingsRowCopyContext value={copy}>{children}</SettingsRowCopyContext>;
}
```

`SettingsRow` 使用 context 生成继承摘要和禁用提示；自动继承重置按钮使用 `copy.resetToInheritedTooltip` 与 `copy.resetToInheritedLabel(title)`。`SettingResetButton` 的默认 Tooltip 和 `aria-label` 分别使用 `copy.resetToDefaultTooltip` 与 `copy.resetToDefaultLabel(label)`，显式传入的 `tooltip` 仍优先。Provider 不生成 DOM。

- [ ] **Step 4: 本地化常规页枚举和所有可见分支**

`GeneralSettingsPanel` 用 `t` 构造 `SettingsRowCopy` 并在现有 `SettingsPageContainer` 外包裹 Provider。所有 `searchableSetting(...)` 调用改为 `searchableSetting(id, t)`。

把模块级英文显示映射改成 `MessageKey` 映射：

```ts
const RESPONSE_STREAMING_MODE_MESSAGE_KEYS: Record<ResponseStreamingMode, MessageKey> = {
  turn: "settings.general.responseStreaming.option.turn",
  paragraph: "settings.general.responseStreaming.option.paragraph",
  token: "settings.general.responseStreaming.option.token",
};
```

同样处理时间格式、差异布局、退出确认、后台活动配置和布尔覆盖项。逐项替换常规页中的：

- Organization、Behavior、Projects & threads、Confirmations、Text generation、About、Diagnostics 分区。
- 项目分组、自动收起、通知、语言、时间格式、响应流式传输、差异默认值、主动面板、斜杠菜单、输入区折叠、提供商更新检查、重启后继续线程、后台活动、新工作树、项目基础目录、确认项、退出快捷键、文本生成模型、版本、诊断和许可证。
- Token 流式警告、后台活动高级弹窗、更新通道控件中的标题、说明、选项、按钮、Tooltip、Toast 和 `aria-label`。

现有设置枚举值、条件和 `onValueChange` 校验保持逐字符不变。

- [ ] **Step 5: 本地化常规页直接子组件**

`NotificationSettings.tsx` 调用 `useI18n()`：

```ts
const NOTIFICATION_MODE_MESSAGE_KEYS: Record<keyof typeof NOTIFICATION_MODE_LABELS, MessageKey> = {
  off: "settings.general.notifications.option.off",
  notifications: "settings.general.notifications.option.notifications",
  sound: "settings.general.notifications.option.sound",
  "notifications-and-sound": "settings.general.notifications.option.notificationsAndSound",
};
```

权限失败只翻译应用自有说明，不改变 `Notification.requestPermission()` 流程。

`ProjectDefaultsSettings.tsx` 只在 `category === "general"` 时使用 `settings.general.*` 文案；`source-control` 和 `integrations` 分支继续走原英文文本。模型名、提供商名和 `t3.json` 保持原文。

- [ ] **Step 6: 运行常规页测试并确认 GREEN**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/settingsLayout.test.tsx src/components/settings/NotificationSettings.test.tsx src/components/settings/SettingsPanels.logic.test.ts src/components/settings/SettingInheritance.test.ts
```

Expected: 全部 PASS；设置逻辑和继承行为测试不变。

- [ ] **Step 7: 提交常规页改动**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/settingsLayout.tsx apps/web/src/components/settings/settingsLayout.test.tsx apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/NotificationSettings.tsx apps/web/src/components/settings/NotificationSettings.test.tsx apps/web/src/components/settings/ProjectDefaultsSettings.tsx
git commit -m "feat(web): localize general settings"
```

---

### Task 4: 本地化外观基础设置

**Files:**

- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/PanelAnimationsPreview.tsx`
- Modify: `apps/web/src/components/settings/SettingsFontPreviews.tsx`
- Modify: `apps/web/src/components/settings/FontFamilyPicker.tsx`
- Create: `apps/web/src/components/settings/ThemeSettings.i18n.test.tsx`

**Interfaces:**

- Consumes: Task 1 的 `searchableSetting(id, t?)`，Task 3 的 `SettingsRowCopyProvider`。
- Produces: 外观页非主题编辑流程的完整中文文案；字体名和示例命令保持原文。

- [ ] **Step 1: 写入失败的外观代表性测试**

`ThemeSettings.i18n.test.tsx` 先覆盖可独立渲染的模式和预览文案。使用真实 `I18nProvider` 及最小 hook mock，断言：

```ts
expect(markup).toContain("跟随系统外观");
expect(markup).toContain("浅色");
expect(markup).toContain("深色");
expect(markup).toContain("重放面板动画预览");
```

`messages.test.ts` 增加外观代表性断言：

```ts
expect(translate("zh-CN", "settings.appearance.interface.title")).toBe("界面");
expect(translate("zh-CN", "settings.appearance.typography.title")).toBe("排版");
expect(translate("zh-CN", "settings.appearance.wordWrap.title")).toBe("自动换行");
```

- [ ] **Step 2: 运行外观测试并确认 RED**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/ThemeSettings.i18n.test.tsx
```

Expected: FAIL，因为外观消息键和组件接入尚不存在。

- [ ] **Step 3: 本地化外观页基础设置**

`AppearanceSettingsPanel` 使用 `t`，通过 Task 3 的 Provider 传入中文 `SettingsRowCopy`，并把 `searchableSetting(...)` 改为 `searchableSetting(id, t)`。

模块级显示映射改成消息键：

```ts
const ENVIRONMENT_IDENTIFICATION_MESSAGE_KEYS: Record<EnvironmentIdentificationMode, MessageKey> = {
  artwork: "settings.appearance.environmentIdentification.option.artwork",
  pill: "settings.appearance.environmentIdentification.option.versionPill",
  none: "settings.appearance.environmentIdentification.option.none",
};
```

同样处理差异配色和字体平滑选项。逐项替换：

- Colors & themes、Interface、Motion、Typography 分区。
- 对比度、玻璃透明度、环境标识、差异配色、面板动画、界面字体、输入字体、代码字体、终端字体、字体平滑和自动换行。
- 所有说明、选项、展开高级排版、重置操作、占位符、Tooltip 和 `aria-label`。

百分比、毫秒、字号数值和设置值保持不变。

- [ ] **Step 4: 本地化字体与动画叶子组件**

`PanelAnimationsPreview.tsx` 仅把 `aria-label` 改为：

```tsx
aria-label={t("settings.appearance.motion.replayPreview")}
```

`SettingsFontPreviews.tsx` 本地化预览的应用自有占位符和 `aria-label`，保留 `$frontend-design`、文件名和示例命令。`FontFamilyPicker.tsx` 本地化加载、无结果、选择字体和枚举权限提示，字体 family 原样显示。

- [ ] **Step 5: 运行外观基础测试并确认 GREEN**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/ThemeSettings.i18n.test.tsx src/components/settings/SettingsPanels.logic.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交外观基础改动**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/PanelAnimationsPreview.tsx apps/web/src/components/settings/SettingsFontPreviews.tsx apps/web/src/components/settings/FontFamilyPicker.tsx apps/web/src/components/settings/ThemeSettings.i18n.test.tsx
git commit -m "feat(web): localize appearance settings"
```

---

### Task 5: 本地化主题库、导入、搜索和编辑流程

**Files:**

- Modify: `apps/web/src/i18n/messages.ts`
- Modify: `apps/web/src/i18n/messages.test.ts`
- Modify: `apps/web/src/components/settings/ThemeSettings.tsx`
- Modify: `apps/web/src/components/settings/ThemePreviewCircles.tsx`
- Modify: `apps/web/src/components/settings/ThemeImportDialog.tsx`
- Modify: `apps/web/src/components/settings/ThemeSearchSection.tsx`
- Modify: `apps/web/src/components/settings/ThemeEditorHost.tsx`
- Modify: `apps/web/src/components/settings/ThemeEditorPanel.tsx`
- Modify: `apps/web/src/components/settings/ThemeColorPicker.tsx`
- Modify: `apps/web/src/components/settings/ThemeEditorHost.test.tsx`
- Modify: `apps/web/src/components/settings/ThemeSettings.i18n.test.tsx`

**Interfaces:**

- Consumes: 现有 `useTheme`、`useThemeEditorStore`、主题文件解析与 Open VSX 搜索接口；不改变它们。
- Produces: 主题工作流的本地化显示；动态主题名、扩展名、第三方说明和原始异常详情保持原文。

- [ ] **Step 1: 写入失败的主题动态文案和 Toast 测试**

扩展 `ThemeEditorHost.test.tsx` 的 `renderEditor()` 返回类型，使测试可以调用 `onSaved`。用真实 `translate("zh-CN", ...)` mock `useI18n()`，断言：

```ts
const saved = { ...theme, label: "Aurora" };
expect(renderEditor()?.onSaved(saved, { created: true })).toBe(true);
expect(toastManager.add).toHaveBeenCalledWith(
  expect.objectContaining({
    title: "Aurora 已创建",
    description: "现已启用。",
  }),
);
```

`ThemeSettings.i18n.test.tsx` 增加：

```ts
expect(markup).toContain("创建主题");
expect(markup).toContain("添加主题");
expect(markup).toContain("搜索主题");
expect(markup).toContain("编辑 Aurora");
```

`messages.test.ts` 增加带动态值的断言，确保 `Aurora` 和原始错误详情未被修改。

- [ ] **Step 2: 运行主题测试并确认 RED**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/ThemeEditorHost.test.tsx src/components/settings/ThemeSettings.i18n.test.tsx
```

Expected: FAIL，因为主题工作流仍使用英文硬编码。

- [ ] **Step 3: 本地化主题库和预览操作**

`ThemeSettings.tsx` 与 `ThemePreviewCircles.tsx` 调用 `useI18n()`，逐项替换：

- System、Light、Dark 及其模式选择 `aria-label`。
- Create theme、Add theme、Duplicate、Edit、Export、Remove 及 Tooltip。
- 当前启用状态、浅色/深色变体选择、删除单个或多个主题的确认标题、说明、取消和删除按钮。
- 添加、更新、启用、保存失败等 Toast 外壳。

动态主题名始终作为 `{theme}` 插值：

```ts
t("settings.appearance.theme.created", { theme: savedTheme.label });
```

- [ ] **Step 4: 本地化主题导入和 Open VSX 搜索**

`ThemeImportDialog.tsx` 逐项替换：添加主题标题、Theme JSON、选择文件、读取中、已安装、拖放说明、导入选项、按钮、文件读取失败、无效主题和选择失败。JSON 示例、文件名和解析异常详情保持原文。

`ThemeSearchSection.tsx` 逐项替换：搜索框、Popular、Sort、四种排序标签、搜索中、无结果、扩大搜索建议、Install、Update、Installing、Updating、查看源代码、取消和安装失败。以下值保持原文：Open VSX、建议搜索中的主题品牌、扩展名、作者和第三方 description。

- [ ] **Step 5: 本地化主题编辑器和颜色选择器**

`ThemeEditorPanel.tsx` 把分组和颜色角色配置中的显示 `label` 改成 `MessageKey`，渲染时调用 `t`：

```ts
interface ThemeEditorGroup {
  readonly titleKey: MessageKey;
  readonly roles: ReadonlyArray<{
    readonly id: string;
    readonly labelKey: MessageKey;
    // existing role metadata unchanged
  }>;
}
```

逐项覆盖 Foundation、Brand & content、Context、Status，主题名称、外观、颜色、基础/高级模式、过滤、无匹配、Inspect、保存、最小化、关闭和所有无障碍名称。

`ThemeColorPicker.tsx` 的颜色角色映射改为 `MessageKey`，本地化饱和度、亮度、色相、HEX、RGB、显示/隐藏用途和选择颜色提示。颜色值与主题 token 名保持不变。

`ThemeEditorHost.tsx` 本地化创建、更新、保存、启用和浏览器存储失败 Toast；主题名和 appearance 动态值通过插值保留。

- [ ] **Step 6: 运行主题工作流测试并确认 GREEN**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/components/settings/ThemeImportDialog.test.ts src/components/settings/ThemeEditorHost.test.tsx src/components/settings/themeEditorStore.test.ts src/components/settings/themeInspector.test.ts src/components/settings/ThemeSettings.i18n.test.tsx
```

Expected: 全部 PASS；主题解析、存储和检查逻辑测试保持原行为。

- [ ] **Step 7: 提交主题工作流改动**

```powershell
git add apps/web/src/i18n/messages.ts apps/web/src/i18n/messages.test.ts apps/web/src/components/settings/ThemeSettings.tsx apps/web/src/components/settings/ThemePreviewCircles.tsx apps/web/src/components/settings/ThemeImportDialog.tsx apps/web/src/components/settings/ThemeSearchSection.tsx apps/web/src/components/settings/ThemeEditorHost.tsx apps/web/src/components/settings/ThemeEditorPanel.tsx apps/web/src/components/settings/ThemeColorPicker.tsx apps/web/src/components/settings/ThemeEditorHost.test.tsx apps/web/src/components/settings/ThemeSettings.i18n.test.tsx
git commit -m "feat(web): localize theme workflows"
```

---

### Task 6: 完整验证与布局检查

**Files:**

- Verify all files changed by Tasks 1–5.
- Modify only a directly failing localization line or test assertion when verification identifies a defect; do not perform unrelated cleanup.

**Interfaces:**

- Consumes: Tasks 1–5 的完整设置本地化。
- Produces: 自动化、类型、格式、浏览器和差异证据。

- [ ] **Step 1: 运行全部相关单元测试**

Run from `apps/web`:

```powershell
..\..\node_modules\.bin\vp.cmd test run --project unit src/i18n/messages.test.ts src/i18n/locale.test.ts src/i18n/I18nProvider.test.tsx src/components/settings/settingsSearch.test.ts src/components/settings/SettingsBreadcrumb.test.tsx src/components/settings/settingsLayout.test.tsx src/components/settings/NotificationSettings.test.tsx src/components/settings/SettingsPanels.logic.test.ts src/components/settings/SettingInheritance.test.ts src/components/settings/ThemeImportDialog.test.ts src/components/settings/ThemeEditorHost.test.tsx src/components/settings/themeEditorStore.test.ts src/components/settings/themeInspector.test.ts src/components/settings/ThemeSettings.i18n.test.tsx
```

Expected: 所有文件 PASS，无失败测试。

- [ ] **Step 2: 运行 Web 类型检查**

Run from repository root:

```powershell
.\node_modules\.bin\vp.cmd run --filter @t3tools/web typecheck
```

Expected: exit code 0，无 TypeScript 错误。

- [ ] **Step 3: 运行项目检查和差异检查**

Run from repository root:

```powershell
.\node_modules\.bin\vp.cmd check
git diff --check
git status --short --branch
```

Expected: `vp check` 和 `git diff --check` exit code 0；状态只包含实施计划允许的文件，或在任务提交完成后为空。

- [ ] **Step 4: 使用隔离 T3 环境进行浏览器验证**

按仓库 `test-t3-app` Skill 启动隔离服务器并完成配对。分别设置 English 和简体中文，检查：

```text
/settings/general
/settings/appearance
```

在桌面宽度和窄屏验证：顶栏、面包屑、环境/项目菜单、常规页、外观页、主题弹窗、错误提示和无障碍名称；使用“默认模型”与“default model”、“远程 配对”与“remote pairing”确认导航目标一致。

Expected: 目标区域无明显应用自有中英文混排；品牌和动态数据保持原文；无裁切、水平溢出、控件下移或遮挡；菜单、弹窗、折叠区、主题操作和恢复默认值可操作。

- [ ] **Step 5: 核对零布局与零行为漂移**

Run from repository root:

```powershell
git diff upstream/main...HEAD -- apps/web/src/components/settings apps/web/src/routes/settings.tsx apps/web/src/i18n
```

逐文件确认没有不属于文本来源或测试覆盖的 DOM、`className`、路由、状态、持久化、事件处理或异步流程改动。

- [ ] **Step 6: 提交验证中产生的必要修正**

仅在 Step 1–5 产生直接修正时执行：

```powershell
git add -u apps/web/src
git diff --cached --name-only
git commit -m "fix(web): finish settings localization"
```

`git diff --cached --name-only` 必须只列出 Step 1–5 直接修正的已跟踪 Web 文件；出现其他路径时先取消暂存并停止提交。若没有修正，不创建空提交。
