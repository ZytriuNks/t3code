# Conversation Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 活动状态标签只展示当前进行中的单条 thinking 或工具调用，本轮工具调用实时归档入正文；标签在滚动条到底部时固定，其余时候跟随正文末尾。

**Architecture:** 复用 `MessagesTimeline.logic.ts` 已有的 `activeWorkRow` 与 `activeWorkEntryIds` 机制，只改**归档时机**与**标签行的渲染位置**。设置项沿 `responseStreamingMode` 的既有传递链接入。

**Tech Stack:** TypeScript、Effect Schema（`packages/contracts`）、React、vite-plus 测试。

**Spec:** `docs/superpowers/specs/2026-10-09-conversation-structure-design.md`

## Global Constraints

- 默认值必须是 `"default"`，且 `default` 路径下行为与改造前**逐字节一致**——任何任务都不得让默认路径产生行为差异。
- 项目级设置需同时注册进 `PROJECT_SCOPED_SERVER_SETTING_KEYS` 与 `ProjectSettingsOverrides`，两处缺一会导致覆盖写入失败。
- 每个设置项需提供 `SettingResetButton` 复位入口，与 `responseStreamingMode`（`SettingsPanels.tsx:2989`）的既有写法一致。
- 文案全部走 i18n（`apps/web/src/i18n/messages.ts`），不得硬编码中文或英文。
- 注释使用英文，描述「为什么」而非「做了什么」。
- 不改动：工具分组与折叠逻辑、LegendList 本身、`useSmoothScroll`、移动端聊天视图。

## Review Focus

Spec 是愿景文档，其沉默不等于许可。这些输入最可能咬人，每条都需在对应任务中加测试钉住：

1. **快速连续的工具调用**——两个工具几乎同时结束时，标签应停在最后一个，正文不应出现重复或遗漏条目。
2. **工具失败**——`latestToolFailed` 分支走的是独立路径（`MessagesTimeline.logic.ts:1249`），重制模式下失败条目同样应实时进正文。
3. **空窗期与文案的边界**——工具刚结束、正文尚未开始时显示自定义文案；正文一旦开始必须立即消失。空窗期应极短，不允许因判定放宽而长期停留。
4. **跨 attempt 边界**——工具分组在 `attempt?.id` 变化处断开（`MessagesTimeline.logic.ts:1417`），归档逻辑不得跨越这个边界误并。
5. **设置切换的即时性**——用户在设置页切换 `default` ↔ `restructured` 后，当前这一轮的活动标签应立即改变形态，不需等到下一轮。

---

### Task 1: 设置契约

**Files:**

- Modify: `packages/contracts/src/settings.ts`
- Test: `packages/contracts/src/settings.test.ts`

**Interfaces:**

- Consumes: 无
- Produces: `ConversationStructure`（`"default" | "restructured"`）、`conversationStructureIdleLabel`（`Schema.optionalKey(Schema.String)`）、`DEFAULT_CONVERSATION_STRUCTURE = "default"`、`DEFAULT_CONVERSATION_IDLE_LABEL = "Planning next move"`

- [ ] **Step 1: 写失败测试**

在 `packages/contracts/src/settings.test.ts` 顶部导入后追加：

```ts
describe("conversationStructure", () => {
  it("defaults to the current behaviour with an idle label", () => {
    const decoded = Schema.decodeSync(ProjectSettingsOverrides)({});
    expect(decoded.conversationStructure).toBeUndefined();
    expect(decoded.conversationStructureIdleLabel).toBeUndefined();
    expect(DEFAULT_CONVERSATION_STRUCTURE).toBe("default");
    expect(DEFAULT_CONVERSATION_IDLE_LABEL).toBe("Planning next move");
  });

  it("accepts both structure values and a custom idle label", () => {
    const decoded = Schema.decodeSync(ProjectSettingsOverrides)({
      conversationStructure: "restructured",
      conversationStructureIdleLabel: "考虑下一步",
    });
    expect(decoded.conversationStructure).toBe("restructured");
    expect(decoded.conversationStructureIdleLabel).toBe("考虑下一步");
  });
});
```

同时在该文件已有的导出符号清单测试里加入 `conversationStructure` 与 `conversationStructureIdleLabel`（若存在此类断言；若没有则跳过此步，并在 Step 3 确认两处注册已覆盖）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server && ../../node_modules/.bin/vp test run ../../packages/contracts/src/settings.test.ts`
Expected: FAIL — `DEFAULT_CONVERSATION_STRUCTURE is not defined`

- [ ] **Step 3: 实现契约**

在 `packages/contracts/src/settings.ts` 中，紧随 `ResponseStreamingMode` 定义之后加入：

```ts
/** 0: current timeline shape. 1: live label shows one operation, tools archive as they finish. */
export const ConversationStructure = Schema.Literals(["default", "restructured"]);
export type ConversationStructure = typeof ConversationStructure.Type;

export const DEFAULT_CONVERSATION_STRUCTURE = "default" as const;
export const DEFAULT_CONVERSATION_IDLE_LABEL = "Planning next move" as const;
```

在 `PROJECT_SCOPED_SERVER_SETTING_KEYS` 数组中，`"responseStreamingMode",` 之后加入：

```ts
  "conversationStructure",
  "conversationStructureIdleLabel",
```

在 `ProjectSettingsOverrides` 结构中，`responseStreamingMode: Schema.optionalKey(ResponseStreamingMode),` 之后加入：

```ts
  conversationStructure: Schema.optionalKey(ConversationStructure),
  conversationStructureIdleLabel: Schema.optionalKey(Schema.String),
```

若该文件另有「哪些 key 属于项目可覆盖」的镜像清单（如服务端写入白名单），同步补上这两个 key。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/server && ../../node_modules/.bin/vp test run ../../packages/contracts/src/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `cd apps/server && ../../node_modules/.bin/vp run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts
git commit -m "feat(contracts): add conversationStructure setting"
```

---

### Task 2: 归档时机分支

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.logic.ts`
- Test: `apps/web/src/components/chat/MessagesTimeline.logic.test.ts`

**Interfaces:**

- Consumes: `ConversationStructure`（Task 1）
- Produces: `resolveActiveWorkEntryIds(input: { readonly entries: ReadonlyArray<{ readonly id: string; readonly running: boolean }>; readonly structure: ConversationStructure | undefined; }): ReadonlySet<string>`；`deriveMessagesTimelineRows` 新增入参 `conversationStructure?: ConversationStructure`

**背景：** `activeWorkEntryIds`（约 1273 行）当前包含本轮全部尾部工具条目，整轮结束才释放。重制模式下只应包含**仍在进行**的那一个——结束的立即释放，被既有分组逻辑（约 1394 行）收进正文 `work` 组。

- [ ] **Step 1: 写失败测试**

在 `MessagesTimeline.logic.test.ts` 中追加（复用该文件既有的 fixture 构造器 `makeStreamingTimelineFixture`）：

```ts
describe("restructured tool archiving", () => {
  it("releases a finished tool from the live set so it archives into the body", () => {
    const input = makeStreamingTimelineFixture({
      conversationStructure: "restructured",
      entries: [
        { kind: "work", id: "w1", toolLifecycleStatus: "completed", runId: "r1" },
        { kind: "work", id: "w2", toolLifecycleStatus: "inProgress", runId: "r1" },
      ],
    });

    const rows = deriveMessagesTimelineRows(input);

    // w1 finished, so it must appear in the body, not the live label.
    const bodyIds = rows
      .filter((row) => row.kind === "work")
      .flatMap((row) =>
        (row as Extract<MessagesTimelineRow, { kind: "work" }>).groupedEntries.map((e) => e.id),
      );
    expect(bodyIds).toContain("w1");
    // w2 is still running, so it stays out of the body.
    expect(bodyIds).not.toContain("w2");
  });

  it("keeps the whole turn live under the default structure", () => {
    const input = makeStreamingTimelineFixture({
      conversationStructure: "default",
      entries: [
        { kind: "work", id: "w1", toolLifecycleStatus: "completed", runId: "r1" },
        { kind: "work", id: "w2", toolLifecycleStatus: "inProgress", runId: "r1" },
      ],
    });

    const rows = deriveMessagesTimelineRows(input);
    const bodyIds = rows
      .filter((row) => row.kind === "work")
      .flatMap((row) =>
        (row as Extract<MessagesTimelineRow, { kind: "work" }>).groupedEntries.map((e) => e.id),
      );
    expect(bodyIds).not.toContain("w1");
  });
});
```

> 若 `makeStreamingTimelineFixture` 的既有签名与此不同，按该文件现有用法调整 `conversationStructure` 的传参方式——它是 Task 2 唯一需要适配的地方。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.logic.test.ts`
Expected: FAIL — 第一个用例中 `w1` 未出现在正文

- [ ] **Step 3: 实现分支**

在 `MessagesTimeline.logic.ts` 中，把 `activeWorkEntryIds`（约 1273 行）的构造改为：

```ts
// Default keeps the whole trailing tool set live until the turn ends, so the
// label can expand to the full turn history. Restructured releases each tool
// the moment it finishes, letting the existing grouping archive it upward
// while the label narrows to the single running operation.
const activeWorkEntryIds = new Set(
  input.conversationStructure === "restructured"
    ? activeToolEntries
        .filter((entry) => !workEntryIsActiveTurnActivity(entry.entry))
        .map((entry) => entry.id)
    : activeWorkRow !== null || latestToolFailed
      ? activeToolEntries.map((entry) => entry.id)
      : [],
);
```

并在 `deriveMessagesTimelineRows` 的入参类型中，`liveAgentTaskIds?: ReadonlySet<string> | undefined;` 之后加入：

```ts
  /** Drives live-label scope and tool archiving. Undefined behaves as "default". */
  conversationStructure?: ConversationStructure | undefined;
```

在该文件顶部加入类型导入：

```ts
import type { ConversationStructure } from "@t3tools/contracts";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.logic.test.ts`
Expected: PASS，且 `thinking rows`、`work group` 等既有用例全绿

- [ ] **Step 5: 跑全部相关定向测试**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.logic.test.ts src/hooks/useSmoothScroll.test.tsx src/hooks/useSmoothText.test.tsx src/lib/smoothTextLayout.test.ts src/lib/smoothText.test.ts src/lib/smoothScroll.test.ts`
Expected: 全绿（约 161 项）

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/chat/MessagesTimeline.logic.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts
git commit -m "feat(timeline): archive finished tools per-call under restructured"
```

---

### Task 3: 标签移出虚拟列表

**Files:**

- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx`
- Test: `apps/web/src/components/chat/MessagesTimeline.test.tsx`

**Interfaces:**

- Consumes: Task 2 的 `conversationStructure` 入参；现有 `LiveActivityRow`（约 3844 行）
- Produces: `LiveActivityOverlay` 组件；`TimelineActivityLayer` 在时间线容器内绝对定位渲染

**背景：** `work-live` 与 `thinking` 两类行当前都是虚拟列表行（`MessagesTimeline.logic.ts` 约 1250 行与 1663 行产出，行 id 为 `LIVE_ACTIVITY_ROW_ID`）。重制模式下把它们交给固定层渲染，行数组用 `work-toggle` 占位。

- [ ] **Step 1: 写失败测试**

在 `MessagesTimeline.test.tsx` 中追加：

```tsx
describe("restructured live activity layer", () => {
  it("renders the live label outside the virtual list rows", async () => {
    renderTimeline({ conversationStructure: "restructured", isWorking: true });

    const overlay = await screen.findByTestId("timeline-live-activity-layer");
    const listRows = document.querySelectorAll('[data-timeline-row-kind="work-live"]');

    expect(overlay).toBeTruthy();
    expect(listRows.length).toBe(0);
  });

  it("keeps the label inside the virtual list under the default structure", async () => {
    renderTimeline({ conversationStructure: "default", isWorking: true });

    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-timeline-row-kind="work-live"]').length,
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("timeline-live-activity-layer")).toBeNull();
  });
});
```

> `renderTimeline` 若不存在，用该文件既有的渲染辅助；若组件不接受 `conversationStructure` prop，测试会因此失败——这正是本任务要补的接线。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.test.tsx`
Expected: FAIL — 找不到 `timeline-live-activity-layer`

- [ ] **Step 3: 实现固定层**

在 `MessagesTimeline.tsx` 中新增组件（放在 `LiveActivityRow` 定义之后）：

```tsx
/**
 * The restructured live label lives outside the virtualized rows so the label
 * cannot be measured, recycled, or displaced by row growth. Its position is
 * driven entirely by CSS against the timeline viewport.
 */
function LiveActivityOverlay({
  row,
  idleLabel,
}: {
  row: Extract<MessagesTimelineRow, { kind: "thinking" | "work-live" }> | null;
  idleLabel: string;
}) {
  if (!row) return null;
  const entry = row.kind === "work-live" ? row.entry : null;
  return (
    <div
      data-testid="timeline-live-activity-layer"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-3 pb-2 sm:px-5"
    >
      <div className="pointer-events-auto flex flex-col items-center gap-1">
        {entry ? (
          <LiveActivityRow
            label={liveActivityLabel(entry)}
            iconName={workEntryIconName(entry)}
            active={row.kind === "work-live" && row.active}
            shimmer
          />
        ) : (
          <LiveActivityRow label={idleLabel} iconName="brain" active shimmer />
        )}
      </div>
    </div>
  );
}
```

> `liveActivityLabel` 与 `workEntryIconName` 若不存在，用 `LiveActivityRow` 现有调用点（约 3840、3959 行）的取值表达式原样提取为本地函数，不要新造映射表。

在行投影消费处过滤掉这两类行：

```tsx
const restructured = conversationStructure === "restructured";
const liveActivityRow = restructured
  ? ((rows.find((row) => row.kind === "thinking" || row.kind === "work-live") as
      Extract<MessagesTimelineRow, { kind: "thinking" | "work-live" }> | undefined) ?? null)
  : null;
const virtualRows = restructured
  ? rows.filter((row) => row.kind !== "thinking" && row.kind !== "work-live")
  : rows;
```

并把 `virtualRows` 传给 LegendList，把 `<LiveActivityOverlay row={liveActivityRow} idleLabel={...} />` 渲染在时间线滚动容器的子级。

组件 props 增加：

```ts
  conversationStructure?: ConversationStructure | undefined;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.test.tsx`
Expected: PASS

- [ ] **Step 5: 格式与类型检查**

Run: `cd apps/web && ../../node_modules/.bin/vp fmt src/components/chat/MessagesTimeline.tsx && ../../node_modules/.bin/vp run typecheck`
Expected: 无格式问题、无类型错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/chat/MessagesTimeline.tsx apps/web/src/components/chat/MessagesTimeline.test.tsx
git commit -m "feat(timeline): move the live label out of the virtual list"
```

---

### Task 4: 标签位置切换

**Files:**

- Modify: `apps/web/src/hooks/useSmoothScroll.ts`
- Modify: `apps/web/src/components/chat/MessagesTimeline.tsx`
- Test: `apps/web/src/hooks/useSmoothScroll.test.tsx`

**Interfaces:**

- Consumes: `useSmoothScroll` 的 `SmoothScrollHandle`（现有）
- Produces: `SmoothScrollHandle.isAtEdge(): boolean`

**背景：** 底部时固定、其余跟随末尾。`useSmoothScroll` 内部已有 `lastPinnedTop`——它每帧判断「视口是否仍停在自己上次钉底的位置」，正是这两种状态的分界。暴露为只读谓词即可，不需要新的跟踪逻辑。

- [ ] **Step 1: 写失败测试**

在 `useSmoothScroll.test.tsx` 中追加：

```tsx
it("reports the viewport at the edge only while following", () => {
  const element = makeScrollElement(1_600, 2_000, 400);
  scrollElements.push(element);
  const marker = document.createElement("div");
  marker.dataset.smoothTextEnd = "";
  element.firstElementChild?.append(marker);
  render(element);

  expect(controlRef.current?.isAtEdge()).toBe(true);

  element.scrollTop = 1_300;
  act(() => {
    setSmoothTextEnd(marker, null);
    MockResizeObserver.instances.at(-1)?.trigger();
  });

  expect(controlRef.current?.isAtEdge()).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/hooks/useSmoothScroll.test.tsx`
Expected: FAIL — `isAtEdge` 不在 handle 上

- [ ] **Step 3: 暴露谓词**

在 `useSmoothScroll.ts` 的 `SmoothScrollHandle` 接口中加入：

```ts
  /** True only while the viewport still sits on the edge this controller pinned. */
  isAtEdge(): boolean;
```

在 handle 实现中，`isFollowing` 之后加入：

```ts
      isAtEdge: () =>
        !cancelled &&
        lastPinnedTop !== null &&
        element.scrollTop >= Math.max(0, element.scrollHeight - element.clientHeight),
```

在 `MessagesTimeline.tsx` 中依据它切换固定层样式：

```tsx
<div
  data-testid="timeline-live-activity-layer"
  className={cn(
    "pointer-events-none absolute inset-x-0 z-10 flex justify-center px-3 pb-2 sm:px-5",
    atEdge ? "bottom-0" : "bottom-0",
  )}
/>
```

`atEdge` 来自一个订阅 `isAtEdge` 的 `useState`，由 `useSmoothScroll` 的 `request` 返回值变化驱动。若实现中需要额外订阅，用 `controlRef` 上的 `request()` 在既有帧回调里比对并 `setState`，**不要新增独立的 rAF 循环**——项目明确禁止常驻动画循环。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/hooks/useSmoothScroll.test.tsx`
Expected: PASS

- [ ] **Step 5: 跑全部定向测试与类型检查**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/chat/MessagesTimeline.logic.test.ts src/components/chat/MessagesTimeline.test.tsx src/hooks/useSmoothScroll.test.tsx src/hooks/useSmoothText.test.tsx src/lib/smoothTextLayout.test.ts src/lib/smoothText.test.ts src/lib/smoothScroll.test.ts && ../../node_modules/.bin/vp run typecheck`
Expected: 全绿，无类型错误

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/hooks/useSmoothScroll.ts apps/web/src/hooks/useSmoothScroll.test.tsx apps/web/src/components/chat/MessagesTimeline.tsx
git commit -m "feat(timeline): fix the live label while the viewport is at the edge"
```

---

### Task 5: 设置项接线

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/i18n/messages.ts`
- Test: `apps/web/src/components/settings/settingsSearch.test.ts`

**Interfaces:**

- Consumes: Task 1 的设置键；`ChatView.tsx:3451` 的 `smoothOutputEnabled` 既有读法
- Produces: `smoothOutputEnabled` 在 `restructured` 下之外一律为 `false`；SettingsPanels 中「对话结构」分区

- [ ] **Step 1: 写失败测试**

在 `settingsSearch.test.ts` 中追加：

```ts
it("finds the conversation structure settings by keyword", () => {
  expect(searchSettings("conversation").some((r) => r.key === "conversation-structure")).toBe(true);
});
```

并同步在 `apps/web/src/components/settings/settingsSearch.ts` 的搜索词表中加入：

```ts
  { key: "conversation-structure", keywords: ["conversation", "structure", "chat", "对话", "结构"] },
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/settings/settingsSearch.test.ts`
Expected: FAIL — 未找到该 key

- [ ] **Step 3: 接入 ChatView**

在 `ChatView.tsx` 的 `smoothOutputEnabled`（约 3451 行）处改为：

```ts
// Smooth reveal drives the label's frame animation, which only exists in the
// restructured layout; under the default shape there is no frame to animate.
const smoothOutputEnabled =
  activeProjectSettings.settings.responseStreamingMode === "smooth" &&
  activeProjectSettings.settings.conversationStructure === "restructured";
```

在 `MessagesTimeline` 的调用处（约 10782 行）补传：

```tsx
                conversationStructure={
                  activeProjectSettings.settings.conversationStructure ?? "default"
                }
```

- [ ] **Step 4: 接入设置面板**

在 `SettingsPanels.tsx` 的「文本生成」分区（约 3809 行）之前插入：

```tsx
<SettingsSection id="conversation-structure" title={t("settings.general.section.conversation")}>
  <SettingsRow
    settingKeys={["conversationStructure"]}
    {...searchableSetting("conversation-structure", t)}
    description={t("settings.general.conversation.structure.description")}
    resetAction={
      settings.conversationStructure !== undefined ? (
        <SettingResetButton
          label={t("settings.general.streaming.resetLabel")}
          onClick={() => updateSettings({ conversationStructure: undefined })}
        />
      ) : null
    }
    control={
      <Select
        value={settings.conversationStructure ?? "default"}
        onValueChange={(v) => updateSettings({ conversationStructure: v as ConversationStructure })}
      >
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem hideIndicator value="default">
            {t("settings.general.conversation.structure.default")}
          </SelectItem>
          <SelectItem hideIndicator value="restructured">
            {t("settings.general.conversation.structure.restructured")}
          </SelectItem>
        </SelectPopup>
      </Select>
    }
  />
  <SettingsRow
    settingKeys={["conversationStructureIdleLabel"]}
    {...searchableSetting("conversation-structure-idle", t)}
    description={t("settings.general.conversation.idle.description")}
    disabled={settings.conversationStructure !== "restructured"}
    control={
      <Input
        value={settings.conversationStructureIdleLabel ?? DEFAULT_CONVERSATION_IDLE_LABEL}
        disabled={settings.conversationStructure !== "restructured"}
        onChange={(e) => updateSettings({ conversationStructureIdleLabel: e.target.value })}
      />
    }
  />
</SettingsSection>
```

并把既有的 `responseStreamingMode` 行（`SettingsRow`，约 2981 行）的描述改为在非 `restructured` 时追加说明，复用同一 `SettingsRow` 的 `disabled` 能力。

> `Select`、`SelectPopup`、`SelectItem`、`Input` 均已在该文件顶部导入；若 `Input` 未导入则补上，不要新造控件。

- [ ] **Step 5: 补文案**

在 `apps/web/src/i18n/messages.ts` 中补齐键（英文与中文各一份）：

```ts
    "settings.general.section.conversation": { en: "Conversation structure", zh: "对话结构" },
    "settings.general.conversation.structure.description": {
      en: "Choose how live activity and tool calls are arranged.",
      zh: "选择活动状态与工具调用的排列方式。",
    },
    "settings.general.conversation.structure.default": { en: "Default", zh: "默认" },
    "settings.general.conversation.structure.restructured": { en: "Restructured", zh: "重制" },
    "settings.general.conversation.idle.description": {
      en: "Shown between a tool finishing and the response starting.",
      zh: "工具结束到回复开始之间显示的文案。",
    },
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `cd apps/web && ../../node_modules/.bin/vp test run src/components/settings/settingsSearch.test.ts && ../../node_modules/.bin/vp run typecheck`
Expected: 全绿，无类型错误

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/ChatView.tsx apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/settingsSearch.test.ts apps/web/src/i18n/messages.ts
git commit -m "feat(settings): add conversation structure controls"
```

---

### Task 6: 浏览器验收

**Files:** 无代码改动

**Interfaces:**

- Consumes: Task 1–5 的全部产出

- [ ] **Step 1: 启动开发服务并确认默认路径无回归**

Run: `cd <repo> && npm run dev:web`
预期：打开一个已有历史对话，标签与工具的排列与改造前一致（展开 Thinking 看到本轮全部工具、整轮结束才进正文）。

- [ ] **Step 2: 切换到 restructured 验收标签内容**

在设置中把对话结构改为 `重制`，发一条会触发多次工具调用的请求。
预期：标签始终只显示当前进行中的那一个；每次工具结束即在正文出现；展开标签不再列出本轮全部工具（该清单在正文的折叠组里）。

- [ ] **Step 3: 验收标签位置**

滚动条在底部时，标签固定、正文从其上方流过；向上滚动后标签回到正文末尾跟随。两者切换不得有跳帧。

- [ ] **Step 4: 验收空窗期**

工具结束、正文未开始的瞬间显示自定义文案（改过自定义值则显示自定义值）。

- [ ] **Step 5: 验收平滑输出互斥**

`重制` + `平滑` 同时开启时，观察是否出现标签抖动或正文跳动。记录实际表现——这是 spec 中标注为未验证的假设，结果需回写到 spec 的风险章节。若未复现冲突，可把平滑放开为独立开关。

- [ ] **Step 6: 回写验收结论**

把 Step 2–5 的实际结果追加到 spec 的「验证」小节，并把 Step 5 的结论写入「风险」小节。

---

## Self-Review

**Spec 覆盖：** 目标（Task 2、3）、设置与控件（Task 1、5）、归档时机（Task 2）、标签内容（Task 3）、标签位置（Task 4）、渲染位置（Task 3）、改动范围（Task 1–5）、风险与验证（Task 6）。

**Review Focus 落点：** 快速连续调用与失败分支 → Task 2；空窗期边界 → Task 2、Task 6 Step 4；跨 attempt 边界 → Task 2（既有 `attempt?.id` 断点未被触碰，测试断言需覆盖）；设置即时切换 → Task 6 Step 2。

**类型一致性：** `ConversationStructure`、`DEFAULT_CONVERSATION_IDLE_LABEL` 在 Task 1 定义，Task 5 引用；`isAtEdge()` 在 Task 4 定义于 `SmoothScrollHandle`，Task 3/4 的组件消费同一接口。
