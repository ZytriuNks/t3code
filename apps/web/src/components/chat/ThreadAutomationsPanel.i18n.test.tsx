import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  tasks: [] as ScheduledTask[],
}));

vi.mock("../../i18n/I18nProvider", async () => {
  const { translate } = await import("../../i18n/messages");
  return {
    useI18n: () => ({
      language: state.language,
      t: (
        key: import("../../i18n/messages").MessageKey,
        values?: import("../../i18n/messages").MessageValues,
      ) => translate(state.language, key, values),
    }),
  };
});
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => null,
    setScheduledTaskEnabled: "toggle",
    runScheduledTaskNow: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: state.tasks }, error: null }),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (x: unknown) => x,
}));

import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");

function scheduleLines(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType("p")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""));
}

describe("thread automation schedule localization", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    state.language = "en";
    state.tasks = [
      {
        id: ScheduledTaskId.make("interval"),
        threadId,
        title: "Inbox sweep",
        enabled: true,
        schedule: { type: "interval", everyMs: 15 * 60_000 },
        nextRunAt: "2026-01-01T00:10:00.000Z",
        lastRunStatus: "never",
      } as ScheduledTask,
      {
        id: ScheduledTaskId.make("weekday"),
        threadId,
        title: "Standup notes",
        enabled: false,
        schedule: {
          type: "fixed_time",
          timeOfDay: "09:00",
          weekdays: [1, 2, 3, 4, 5],
        } as ScheduledTask["schedule"],
        nextRunAt: null,
        lastRunStatus: "never",
      } as ScheduledTask,
    ];
  });

  afterEach(async () => {
    if (renderer) await act(async () => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers();
  });

  it("re-renders schedule, next-run, and paused labels in the selected language", async () => {
    const panel = <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />;
    await act(async () => {
      renderer = create(panel);
    });
    expect(scheduleLines(renderer!)).toEqual(
      expect.arrayContaining(["Every 15 min · next in 10m", "Weekdays at 09:00 · paused"]),
    );

    state.language = "zh-CN";
    await act(async () => {
      renderer!.update(
        <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />,
      );
    });
    expect(scheduleLines(renderer!)).toEqual(
      expect.arrayContaining(["每 15 分钟 · 下次 10 分钟后", "工作日 09:00 · 已暂停"]),
    );
  });
});
