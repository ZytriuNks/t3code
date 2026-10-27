import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { translate, type MessageKey, type MessageValues } from "../i18n/messages";

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "zh-CN",
  enabled: true,
  configs: new Map<string, unknown>(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
}));
vi.mock("../i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: MessageKey, values?: MessageValues) => translate(state.locale, key, values),
  }),
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: { confirmThreadDelete: boolean }) => unknown) =>
    select({ confirmThreadDelete: state.enabled }),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => state.configs } }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../state/entities", () => ({ readThreadShell: () => ({ title: "Root or fork" }) }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: state.confirm } }) }));

import { useThreadDeleteConfirmation } from "./useThreadDeleteConfirmation";

const target = (environment: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(environment),
  threadId: ThreadId.make("same-id"),
});
function capability(environment: string, enabled: boolean | undefined) {
  state.configs.set(environment, {
    environment: { capabilities: { threadLifecycleCascade: enabled } },
  });
}
beforeEach(() => {
  state.locale = "en";
  state.enabled = true;
  state.configs.clear();
  state.confirm.mockReset().mockResolvedValue(true);
});

it.each([true, false, undefined])(
  "confirms single and bulk targets with cascade capability %s",
  async (supportsCascade) => {
    capability("new", supportsCascade);
    capability("other", supportsCascade);
    const confirm = useThreadDeleteConfirmation();
    expect(await confirm([target("new")])).toMatchObject({ _tag: "Success", value: true });
    expect(await confirm([target("new"), target("other")])).toMatchObject({
      _tag: "Success",
      value: true,
    });
    const [single, bulk] = state.confirm.mock.calls.map(([message]) => message);
    expect(single).toContain('Delete thread "Root or fork"?');
    expect(single).toContain("Delete this thread from T3?");
    expect(bulk).toContain("Delete 2 threads?");
    expect(bulk).toContain("Delete these threads from T3?");
    for (const message of [single!, bulk!]) {
      expect(message).not.toMatch(/permanently clears|transcript|terminal/i);
      expect(message.includes("if the server confirms cascading deletion")).toBe(
        supportsCascade === true,
      );
    }
  },
);

it("does not advertise cascade for mixed environments sharing a thread ID", async () => {
  capability("new", true);
  expect(await useThreadDeleteConfirmation()([target("new"), target("old")])).toMatchObject({
    value: true,
  });
  expect(state.confirm.mock.calls[0]![0]).not.toContain("subagent");
});

it("returns cancellation and dialog errors to callers", async () => {
  state.confirm.mockResolvedValue(false);
  expect(await useThreadDeleteConfirmation()([target("old")])).toMatchObject({
    _tag: "Success",
    value: false,
  });
  state.confirm.mockRejectedValue(new Error("Dialog unavailable"));
  expect(await useThreadDeleteConfirmation()([target("old")])).toMatchObject({ _tag: "Failure" });
});

it("respects disabled confirmations and rejects an empty selection", async () => {
  state.enabled = false;
  expect(await useThreadDeleteConfirmation()([target("old")])).toMatchObject({ value: true });
  expect(await useThreadDeleteConfirmation()([])).toMatchObject({ value: false });
  expect(state.confirm).not.toHaveBeenCalled();
});

it("localizes single and bulk confirmations", async () => {
  state.locale = "zh-CN";
  capability("new", true);
  const confirm = useThreadDeleteConfirmation();
  await confirm([target("new")]);
  await confirm([target("new"), target("new")]);
  expect(state.confirm.mock.calls[0]![0]).toContain("从 T3 删除此线程？若服务端确认级联删除");
  expect(state.confirm.mock.calls[1]![0]).toContain("删除 2 个线程？");
  expect(state.confirm.mock.calls[1]![0]).toContain("从 T3 删除这些线程？");
});
