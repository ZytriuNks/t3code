import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  toast: vi.fn(),
  mutate: vi.fn(),
  update: vi.fn(),
  mutationEnvironmentIds: [] as EnvironmentId[],
  canManageProviders: true,
  hasCurrentGrant: true,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => state.canManageProviders,
  readEnvironmentScope: () => state.hasCurrentGrant,
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => state.update,
}));
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => ({
    providerInstances: { pi_work: { driver: "pi", enabled: true } },
  }),
  usePersistEnvironmentProviderInstanceMutation: (environmentId: EnvironmentId) => {
    state.mutationEnvironmentIds.push(environmentId);
    return state.mutate;
  },
}));
import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
const environmentId = EnvironmentId.make("remote-device");
function setup() {
  state.canManageProviders = true;
  state.hasCurrentGrant = true;
  state.toast.mockReset();
  state.mutationEnvironmentIds = [];
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
  const providersSpy = vi
    .spyOn(serverEnvironment, "providersValueAtom")
    .mockReturnValue(Atom.make([]));
  const onClose = vi.fn();
  const onAccountCreated = vi.fn();
  return {
    [Symbol.dispose]() {
      providersSpy.mockRestore();
    },
    onClose,
    onAccountCreated,
    view: () => (
      <AddCodexAccountDialog
        environmentId={environmentId}
        onClose={onClose}
        onAccountCreated={onAccountCreated}
        renderSetup={() => null}
      />
    ),
  };
}

it("keeps a failed account creation open and reports the save failure", async () => {
  using fixture = setup();
  const { view, onClose, onAccountCreated } = fixture;
  state.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Conflict")) });
  await using _screen = await render(view());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" })),
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(onAccountCreated).not.toHaveBeenCalled();
  await expect.element(page.getByRole("textbox", { name: "Account name" })).toBeEnabled();
});

it("creates managed accounts atomically on the selected environment without replacing other providers", async () => {
  using fixture = setup();
  const { view, onClose, onAccountCreated } = fixture;
  await using _screen = await render(view());
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(new Set(state.mutationEnvironmentIds)).toEqual(new Set([environmentId]));
  expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
    operation: "create",
    instanceId: expect.stringMatching(/^codex_[\w-]+$/),
    instance: {
      driver: "codex",
      displayName: "ChatGPT - Personal",
      enabled: true,
      config: { enabled: true, setupMode: "managed" },
    },
  });
  expect(state.update).not.toHaveBeenCalled();
  expect(onAccountCreated).toHaveBeenCalledWith(
    state.mutate.mock.calls[0]![0].instanceId,
    "ChatGPT - Personal",
  );
});

it("does not create an account after the provider management grant is revoked", async () => {
  using fixture = setup();
  const { view, onClose, onAccountCreated } = fixture;
  await using _screen = await render(view());
  state.hasCurrentGrant = false;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.update).not.toHaveBeenCalled();
  expect(onAccountCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("disables creation without the provider management grant", async () => {
  using fixture = setup();
  const { view } = fixture;
  state.canManageProviders = false;
  await using _screen = await render(view());
  await expect.element(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
});
