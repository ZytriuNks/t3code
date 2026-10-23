import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { state, Passthrough, Nothing } = vi.hoisted(() => ({
  state: { language: "en" as "en" | "zh-CN" },
  Passthrough: ({ children }: { children?: ReactNode }) => children ?? null,
  Nothing: () => null,
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
    useConnectionStatusCopy: () => ({}),
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "keybindings" ? [] : atom === "update-state" ? { status: "idle" } : [],
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/server", () => ({
  primaryServerKeybindingsAtom: "keybindings",
  serverEnvironment: { updateStateAtom: () => "update-state" },
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => ({
    environmentId: "primary",
    label: "Laptop",
    serverConfig: null,
    displayUrl: null,
    connection: { phase: "connected" },
  }),
  usePrimaryEnvironmentId: () => "primary",
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("~/environments/primary", () => ({
  createServerPairingCredential: vi.fn(),
  revokeOtherServerClientSessions: vi.fn(),
  revokeServerClientSession: vi.fn(),
  revokeServerPairingLink: vi.fn(),
  isLoopbackHostname: () => true,
  usePrimarySessionState: () => ({
    data: {
      authenticated: true,
      permissions: ["access:read"],
      auth: { policy: "remote-reachable" },
    },
  }),
}));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("~/state/auth", () => ({ authEnvironment: { accessChanges: () => "access-changes" } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === "access-changes"
      ? {
          data: { type: "snapshot", payload: { pairingLinks: [], clientSessions: [] } },
          error: null,
          isPending: false,
          refresh: vi.fn(),
        }
      : { data: null, error: null, isPending: false, refresh: vi.fn() },
}));
vi.mock("~/state/desktopNetworkAccess", () => ({
  desktopNetworkAccessStateAtom: "network",
  refreshDesktopNetworkAccessState: vi.fn(),
}));
vi.mock("~/state/desktopSshHosts", () => ({
  desktopSshHostsStateAtom: "ssh",
  filterDiscoveredSshHosts: () => [],
}));
vi.mock("~/state/desktopWslState", () => ({
  desktopWslStateAtom: "wsl",
  refreshDesktopWslState: vi.fn(),
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { remove: "remove", register: "register", setEnabled: "setEnabled" },
}));
vi.mock("~/connection/onboarding", () => ({
  connectPairing: "connectPairing",
  connectSshEnvironment: "connectSshEnvironment",
}));
vi.mock("~/connection/desktopLocal", () => ({ isDesktopLocalConnectionTarget: () => false }));
vi.mock("~/cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("~/cloud/useCloudLinkController", () => ({ useCloudLinkController: vi.fn() }));
vi.mock("~/uiStateStore", () => ({
  useUiStateStore: (selector: (value: unknown) => unknown) =>
    selector({ defaultAdvertisedEndpointKey: null, setDefaultAdvertisedEndpointKey: vi.fn() }),
}));
vi.mock("~/versionSkew", () => ({
  resolveServerConfigVersionMismatch: () => null,
  resolveServerSelfUpdateCapability: () => null,
  supportsDesktopAppUpdate: () => false,
  supportsServerUpdateThreadContinuation: () => false,
}));
vi.mock("~/branding", () => ({ APP_VERSION: "0.0.0" }));
vi.mock("../../localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("../ServerUpdateAction", () => ({
  OutdatedServerUpdateAction: Nothing,
  ServerUpdateAction: Nothing,
  ServerUpdateProgress: Nothing,
  ServerUpdatesAction: Nothing,
}));
vi.mock("../clerk/RemoveT3ConnectEnvironmentDialog", () => ({
  RemoveT3ConnectEnvironmentDialog: Nothing,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({ CloudEnvironmentConnectRows: Nothing }));
vi.mock("../ConnectionStatusDot", () => ({ ConnectionStatusDot: Nothing }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: Nothing }));
vi.mock("../AnimatedHeight", () => ({ AnimatedHeight: Passthrough }));
vi.mock("./EnvironmentRow", () => ({
  EnvironmentRow: Nothing,
  environmentTransportLabel: () => "",
  formatDesktopSshTarget: () => "",
}));
vi.mock("./EnvironmentIconPicker", () => ({ EnvironmentIconMenu: Nothing }));
vi.mock("./EnvironmentRoutesList", () => ({ EnvironmentRoutesList: Nothing }));
vi.mock("./LocalEnvironmentSetting", () => ({ LocalEnvironmentSetting: Nothing }));
vi.mock("./LoadBalancingSettings", () => ({ LoadBalancingSettings: Nothing }));
vi.mock("./GitHubRoutingSettings", () => ({ GitHubRoutingSettings: Nothing }));
vi.mock("./SessionPermissions", () => ({ SessionPermissions: Nothing }));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: Passthrough,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title?: ReactNode;
    headerAction?: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
  useRelativeTimeTick: () => 0,
}));
vi.mock("./FoldedSettingsSection", () => ({
  FoldedSettingsSection: ({
    title,
    summary,
    control,
    children,
  }: {
    title: string;
    summary?: string | null;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{summary}</p>
      {control}
      {children}
    </section>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: Passthrough,
  DialogClose: Passthrough,
  DialogDescription: Passthrough,
  DialogFooter: Passthrough,
  DialogHeader: Passthrough,
  DialogPanel: Passthrough,
  DialogPopup: Passthrough,
  DialogTitle: Passthrough,
  DialogTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: Nothing,
  AlertDialogClose: Nothing,
  AlertDialogDescription: Nothing,
  AlertDialogFooter: Nothing,
  AlertDialogHeader: Nothing,
  AlertDialogPopup: Nothing,
  AlertDialogTitle: Nothing,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: Passthrough,
  TooltipPopup: Passthrough,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: Nothing,
  MenuItem: Nothing,
  MenuPopup: Nothing,
  MenuSeparator: Nothing,
  MenuTrigger: Nothing,
}));
vi.mock("../ui/popover", () => ({
  Popover: Passthrough,
  PopoverPopup: Passthrough,
  PopoverTrigger: Passthrough,
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: Passthrough }));
vi.mock("../ui/switch", () => ({ Switch: Nothing }));
vi.mock("../ui/checkbox", () => ({ Checkbox: Nothing }));
vi.mock("../ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: { add: vi.fn() } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));

import { ConnectionsSettings } from "./ConnectionsSettings";

function renderedText(renderer: ReactTestRenderer): string[] {
  const values: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") values.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object" && "children" in node) {
      visit((node as { children: unknown }).children);
    }
  };
  visit(renderer.toJSON());
  return values;
}

describe("Connections settings language switching", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { location: { href: "http://localhost/", hostname: "localhost" } });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    state.language = "en";
    vi.unstubAllGlobals();
  });

  it("re-renders restored connection copy when the app language changes", async () => {
    await act(() => {
      renderer = create(<ConnectionsSettings />);
    });
    const english = renderedText(renderer!);
    expect(english).toEqual(
      expect.arrayContaining([
        "Version",
        "Authorized clients",
        "0 clients",
        "Create pairing link",
        "View access",
        "Inspect pairing links and authorized clients.",
        "Environments",
        "Add Environment",
        "Remote link",
        "Remote access is already configured. Change network exposure where the server starts.",
      ]),
    );

    state.language = "zh-CN";
    await act(() => renderer!.update(<ConnectionsSettings />));

    const chinese = renderedText(renderer!);
    expect(chinese).toEqual(
      expect.arrayContaining([
        "版本",
        "已授权客户端",
        "0 客户端",
        "查看访问权限",
        "环境",
        "添加环境",
        "远程链接",
      ]),
    );
    expect(chinese).not.toContain("Authorized clients");
    expect(chinese).not.toContain("Remote link");
  });
});
