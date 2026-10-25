import { RegistryContext } from "@effect/atom-react";
import type {
  DeleteProjectInput,
  UpdateProjectInput,
} from "@t3tools/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { ensureLocalApi } from "../../localApi";
import "~/index.css";
import type { Project } from "../../types";
type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const languageState = vi.hoisted(() => ({ current: "en" as "en" | "zh-CN" }));
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  providers: null as Atom.Atom<ReadonlyArray<ServerProvider>> | null,
  config: null as Atom.Atom<{ keybindings: ResolvedKeybindingsConfig }> | null,
  editable: null as Atom.Atom<ReadonlySet<EnvironmentId>> | null,
  locale: null as Atom.Writable<"en" | "zh-CN"> | null,
  projects: [] as Project[],
  update:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: UpdateProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  delete:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: DeleteProjectInput;
      }) => Promise<AsyncResult.Success<void>>
    >(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  updateSettings: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
  updateClientSettings: vi.fn(),
  releaseUploads: vi.fn(),
  clearDraft: vi.fn(),
  copy: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../i18n/I18nProvider", { spy: true });
vi.mock("../../state/session", { spy: true });
vi.mock("../../state/environments", { spy: true });
vi.mock("../../state/entities", { spy: true });
vi.mock("../../state/use-orchestration-command", { spy: true });
vi.mock("../../hooks/useSettings", { spy: true });
vi.mock("../../lib/composerDraftUploads", { spy: true });
import { useAtomValue } from "@effect/atom-react";
import { useI18n } from "../../i18n/I18nProvider";
import { translate } from "../../i18n/messages";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShells, waitForProjectRemoval } from "../../state/entities";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { projectEnvironment } from "../../state/projects";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./ProjectActionsSettings", () => ({ ProjectActionsSettings: () => null }));
vi.mock("./ProjectFaviconPickerDialog", () => ({
  canPickExternalProjectFavicon: () => false,
  ProjectFaviconPickerDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (path: string) => void;
  }) =>
    open ? <button onClick={() => onSelect("/work/icon.png")}>Select fixture icon</button> : null,
}));
vi.mock("./ProjectIconPickerDialog", () => ({ ProjectIconPickerDialog: () => null }));
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("codex");
const environments = [primaryId, remoteId].map((environmentId) => ({
  environmentId,
  label: environmentId,
  connection: { phase: "connected" },
  serverConfig: { keybindings: DEFAULT_RESOLVED_KEYBINDINGS },
}));
const session = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3_session",
  },
});
const writable = () => AsyncResult.success(session([AuthOrchestrationOperateScope]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setup() {
  vi.clearAllMocks();
  languageState.current = "en";
  const registry = AtomRegistry.make();
  state.registry = registry;
  state.locale = Atom.make<"en" | "zh-CN">("en");
  state.sessions.clear();
  for (const id of [primaryId, remoteId])
    state.sessions.set(id, Atom.make<SessionResult>(writable()).pipe(Atom.keepAlive));
  state.editable = Atom.make(
    (get) =>
      new Set(
        [primaryId, remoteId].filter((id) => {
          const result = get(state.sessions.get(id)!);
          const value = Option.getOrNull(AsyncResult.value(result));
          return (
            result._tag !== "Failure" &&
            value !== null &&
            sessionGrantsScope(value, AuthOrchestrationOperateScope)
          );
        }),
      ),
  );
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: { instanceId, model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.providers = Atom.make<ReadonlyArray<ServerProvider>>([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  state.config = Atom.make({ keybindings: DEFAULT_RESOLVED_KEYBINDINGS });
  state.update.mockImplementation(async ({ environmentId, input }) => {
    const { projectId, ...updates } = input;
    const patch = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<Project>;
    state.projects = state.projects.map((project) =>
      project.environmentId === environmentId && project.id === projectId
        ? { ...project, ...patch }
        : project,
    );
    return AsyncResult.success(undefined);
  });
  state.delete.mockResolvedValue(AsyncResult.success(undefined));
  state.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockResolvedValue(true);
  vi.mocked(useI18n).mockImplementation(function useTestI18n() {
    const language = useAtomValue(state.locale!);
    return { language, preference: language, t: (key, values) => translate(language, key, values) };
  });
  vi.mocked(useEnvironmentsWithScope).mockImplementation(() => useAtomValue(state.editable!));
  vi.mocked(readEnvironmentScope).mockImplementation((id, scope) => {
    const result = registry.get(state.sessions.get(id)!);
    const value = Option.getOrNull(AsyncResult.value(result));
    return result._tag !== "Failure" && value !== null && sessionGrantsScope(value, scope);
  });
  vi.mocked(useEnvironments).mockReturnValue({ environments } as never);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(primaryId);
  vi.mocked(useProjects).mockImplementation(() => state.projects);
  vi.mocked(useThreadShells).mockReturnValue([]);
  vi.mocked(waitForProjectRemoval).mockResolvedValue(true);
  vi.mocked(useOrchestrationCommand).mockImplementation(((command: unknown) =>
    command === projectEnvironment.update ? state.update : state.delete) as never);
  vi.mocked(useClientSettings).mockImplementation(((
    select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown,
  ) => select(DEFAULT_CLIENT_SETTINGS)) as never);
  vi.mocked(releaseProjectDraftUploads).mockImplementation(state.releaseUploads);
  const clearDraft = vi
    .spyOn(useComposerDraftStore.getState(), "clearProjectDraftThreadId")
    .mockImplementation(state.clearDraft);
  const confirm = vi.spyOn(ensureLocalApi().dialogs, "confirm").mockImplementation(state.confirm);
  return {
    [Symbol.dispose]() {
      confirm.mockRestore();
      clearDraft.mockRestore();
      registry.dispose();
      vi.resetAllMocks();
    },
  };
}
function group() {
  return buildSidebarProjectSnapshots({
    projects: state.projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!;
}
const view = () => (
  <RegistryContext.Provider value={state.registry!}>
    <ProjectSettingsPanel projectKey={group().projectKey} />
  </RegistryContext.Provider>
);
const grant = async (id: EnvironmentId, result: SessionResult) =>
  act(() => state.registry!.set(state.sessions.get(id)!, result));
async function rename(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole("textbox", { name: "Project name" }).fill("Renamed");
  await screen.getByRole("button", { name: "Choose file", exact: true }).click();
}

describe("project settings", () => {
  it("switches project icon controls and removal confirmation to Chinese", async () => {
    using _fixture = setup();
    await using screen = await render(view());
    await expect.element(screen.getByRole("button", { name: "Choose project icon" })).toBeVisible();
    await act(() => state.registry!.set(state.locale!, "zh-CN"));
    await screen.rerender(view());
    await expect.element(screen.getByRole("button", { name: "选择项目图标" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "选择文件", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "移除所有条目", exact: true }).click();
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.confirm.mock.calls[0]![0]).toContain("要移除项目");
    expect(state.confirm.mock.calls[0]![0]).not.toContain("Remove project");
  });
  it("preflights every member before any shared field update", async () => {
    using _fixture = setup();
    await grant(remoteId, AsyncResult.success(session([AuthSettingsWriteScope])));
    await using screen = await render(view());
    await expect.element(screen.getByRole("textbox", { name: "Project name" })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Choose file", exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Remove all entries", exact: true }))
      .toBeDisabled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.projects.every((project) => project.title === "Shared repo")).toBe(true);
  });
  it("updates every member with project access without settings access", async () => {
    using _fixture = setup();
    await using screen = await render(view());
    await rename(screen);
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]);
    expect(state.projects.map((project) => project.title)).toEqual(["Renamed", "Renamed"]);
  });
  it("stops before the next member when permission is revoked during an earlier update", async () => {
    using _fixture = setup();
    const first = deferred<AsyncResult.Success<void>>();
    state.update.mockReturnValueOnce(first.promise);
    await using screen = await render(view());
    await rename(screen);
    expect(state.update).toHaveBeenCalledOnce();
    await grant(remoteId, AsyncResult.success(session([])));
    await act(() => first.resolve(AsyncResult.success(undefined)));
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]![0].environmentId).toBe(primaryId);
  });
  it("permits removing a writable checkout while denying removal of a mixed group", async () => {
    using _fixture = setup();
    await grant(remoteId, AsyncResult.success(session([])));
    await using screen = await render(view());
    await expect
      .element(screen.getByRole("button", { name: "Remove checkout /work/remote" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Remove all entries", exact: true }))
      .toBeDisabled();
    expect(state.confirm).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Remove checkout /work/primary" }).click();
    await vi.waitFor(() => expect(state.clearDraft).toHaveBeenCalledOnce());
    expect(state.delete).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    });
    expect(state.releaseUploads).toHaveBeenCalledOnce();
  });
  it("rechecks removal targets after confirmation before deleting or clearing drafts", async () => {
    using _fixture = setup();
    const confirmed = deferred<boolean>();
    state.confirm.mockReturnValueOnce(confirmed.promise);
    await using screen = await render(view());
    await screen.getByRole("button", { name: "Remove all entries", exact: true }).click();
    expect(state.confirm).toHaveBeenCalledOnce();
    await grant(remoteId, AsyncResult.success(session([])));
    await act(() => confirmed.resolve(true));
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.releaseUploads).not.toHaveBeenCalled();
    expect(state.clearDraft).not.toHaveBeenCalled();
  });
  it("reacts to revoked and restored permissions and guards a pending blur", async () => {
    using _fixture = setup();
    await using screen = await render(view());
    const input = screen.getByRole("textbox", { name: "Project name" });
    await input.fill("Renamed");
    await grant(remoteId, AsyncResult.success(session([])));
    await act(() => input.element().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(state.update).not.toHaveBeenCalled();
    await expect.element(input).toBeDisabled();
    await grant(remoteId, writable());
    await expect.element(input).toBeEnabled();
    await input.fill("Shared repo");
    await rename(screen);
    await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
  });
  it.each([
    ["loading", () => AsyncResult.initial<AuthSessionState, Error>(), false],
    [
      "failed",
      () => AsyncResult.failure<AuthSessionState, Error>(Cause.fail(new Error("Disconnected"))),
      false,
    ],
    ["refreshing", () => AsyncResult.waiting(writable()), true],
  ] as const)(
    "uses the current grant while a member's session is %s",
    async (_state, result, allowed) => {
      using _fixture = setup();
      await grant(remoteId, result());
      await using screen = await render(view());
      if (allowed) {
        await rename(screen);
        await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
      } else {
        await expect.element(screen.getByRole("textbox", { name: "Project name" })).toBeDisabled();
        expect(state.update).not.toHaveBeenCalled();
      }
    },
  );
});
