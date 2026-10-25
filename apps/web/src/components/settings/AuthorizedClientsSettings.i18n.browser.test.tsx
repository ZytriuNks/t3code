import { AuthSessionId, type AdvertisedEndpoint } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "~/index.css";
import type { ServerClientSessionRecord } from "../../environments/primary";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PairingClientsList } from "./AuthorizedClientsSettings";

const preference = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));
vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useClientSettings: <T,>(selector: (settings: typeof preference) => T) => selector(preference),
}));

function setup() {
  preference.language = "en";
  const current: ServerClientSessionRecord = {
    sessionId: AuthSessionId.make("fixture-current"),
    subject: "fixture-device",
    scopes: ["orchestration:read"],
    method: "browser-session-cookie",
    client: { deviceType: "desktop", label: "Fixture PC" },
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastConnectedAt: null,
    connected: true,
    current: true,
  };
  const endpoints: AdvertisedEndpoint[] = [
    {
      id: "fixture-lan",
      label: "Fixture LAN",
      provider: { id: "core", label: "Core", kind: "core", isAddon: false },
      reachability: "lan",
      status: "available",
      httpBaseUrl: "http://192.0.2.1:3773",
      wsBaseUrl: "ws://192.0.2.1:3773/ws",
      compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
      source: "server",
    },
  ];
  const props = {
    endpointUrl: null,
    endpoints,
    defaultEndpointKey: null,
    isLoading: false,
    pairingLinks: [
      {
        id: "fixture-link",
        subject: "fixture-subject",
        scopes: ["orchestration:read"] as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    createdPairingCredentials: new Map([["fixture-link", "fixture-code"]]),
    clientSessions: [current],
    revokingPairingLinkId: null,
    revokingClientSessionId: null,
    onRevokePairingLink: vi.fn(),
    onRevokeClientSession: vi.fn(),
    canRevoke: true,
  };
  return {
    props,
    view: () => (
      <I18nProvider>
        <PairingClientsList {...props} />
      </I18nProvider>
    ),
  };
}

describe("authorized client copy", () => {
  it("updates memoized device rows and an open share panel when the language changes", async () => {
    const { view } = setup();
    await using screen = await render(view());
    await expect.element(screen.getByRole("heading", { name: "Pairing link" })).toBeVisible();
    await screen.getByRole("button", { name: "Share", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Copy link", exact: true }))
      .toBeVisible();
    preference.language = "zh-CN";
    await screen.rerender(view());
    await expect.element(screen.getByRole("heading", { name: "配对链接" })).toBeVisible();
    await expect.element(screen.getByText("此设备", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "已连接", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "复制链接", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "仅复制代码", exact: true }))
      .toBeVisible();
  });

  it("translates the manual reveal fallback and revocation state", async () => {
    const { props, view } = setup();
    using _secure = vi.spyOn(window, "isSecureContext", "get").mockReturnValue(false);
    await using screen = await render(view());
    await screen.getByRole("button", { name: "Show link", exact: true }).click();
    preference.language = "zh-CN";
    await screen.rerender(view());
    await expect
      .element(page.getByRole("dialog").getByRole("heading", { name: /配对链接/ }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "完成", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await screen.rerender(
      <I18nProvider>
        <PairingClientsList {...props} revokingPairingLinkId="fixture-link" />
      </I18nProvider>,
    );
    await expect
      .element(screen.getByRole("button", { name: "正在撤销…", exact: true }))
      .toBeDisabled();
  });
});
