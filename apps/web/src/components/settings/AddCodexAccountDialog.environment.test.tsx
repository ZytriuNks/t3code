import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  toast: vi.fn(),
  mutate: vi.fn(),
  update: vi.fn(),
  mutationEnvironmentIds: [] as EnvironmentId[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: () => {},
    useEffectEvent: (callback: unknown) => callback,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providersValueAtom: () => null, updateSettings: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    providerInstances: { pi_work: { driver: "pi", enabled: true } },
  }),
  usePersistEnvironmentProviderInstanceMutation: (environmentId: EnvironmentId) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutate;
  },
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "new-account",
}));

import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
const environmentId = EnvironmentId.make("remote-device");
const onClose = vi.fn();
const onAccountCreated = vi.fn();
function render() {
  hooks.beginRender();
  return AddCodexAccountDialog({
    environmentId,
    onClose,
    onAccountCreated,
    renderSetup: () => null,
  });
}
beforeEach(() => {
  hooks.reset();
  state.toast.mockReset();
  state.mutationEnvironmentIds = [];
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  onClose.mockReset();
  onAccountCreated.mockReset();
});

it("keeps a failed account creation open and reports the save failure", async () => {
  state.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Conflict")) });
  const form = visitElements(render(), (element) => element.props.id === "add-codex-account")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await Promise.resolve();
  expect(onClose).not.toHaveBeenCalled();
  expect(onAccountCreated).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
});

it("creates managed accounts atomically on the selected environment without replacing other providers", async () => {
  const tree = render();
  const form = visitElements(tree, (element) => element.props.id === "add-codex-account")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await Promise.resolve();
  expect(state.mutationEnvironmentIds).toEqual([environmentId]);
  expect(state.mutate).toHaveBeenCalledWith({
    operation: "create",
    instanceId: ProviderInstanceId.make("codex_new-account"),
    instance: {
      driver: "codex",
      displayName: "ChatGPT - Personal",
      enabled: true,
      config: { enabled: true, setupMode: "managed" },
    },
  });
  expect(state.update).not.toHaveBeenCalled();
  expect(onAccountCreated).toHaveBeenCalledWith("codex_new-account", "ChatGPT - Personal");
  expect(onClose).toHaveBeenCalledOnce();
});
