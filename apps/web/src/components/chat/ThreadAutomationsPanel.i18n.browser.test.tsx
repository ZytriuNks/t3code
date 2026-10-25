import { EnvironmentId, ThreadId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import { fakeTimers, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  tasks: [] as ScheduledTask[],
}));

vi.mock("../../i18n/I18nProvider", async (original) => {
  const { translate } = await import("../../i18n/messages");
  return {
    ...(await original<typeof import("../../i18n/I18nProvider")>()),
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
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/server", async (original) => {
  const actual = await original<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: () => null,
      setScheduledTaskEnabled: "toggle",
      runScheduledTaskNow: { permissionAtom: () => null },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({ data: { tasks: state.tasks }, error: null }),
}));
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");

describe("thread automation schedule localization", () => {
  it("updates schedule, next-run and paused copy without remounting", async () => {
    using _clock = fakeTimers();
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
    const panel = () => (
      <ThreadAutomationsPanel environmentId={environmentId} threadId={threadId} />
    );
    await using screen = await render(panel());
    await expect
      .element(screen.getByText("Every 15 min · next in 10m", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Weekdays at 09:00 · paused", { exact: true }))
      .toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(panel());
    await expect
      .element(screen.getByText("每 15 分钟 · 下次 10 分钟后", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("工作日 09:00 · 已暂停", { exact: true })).toBeVisible();
  });
});
