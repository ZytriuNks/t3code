import type { BrowserImportSource } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({ current: "zh-CN" as const }));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector?: (settings: { language: "zh-CN" }) => T) =>
    selector ? selector({ language: languageState.current }) : { language: languageState.current },
}));
vi.mock("../permissions/PermissionChecklist", () => ({
  PermissionChecklist: () => null,
  PermissionContinueButton: ({ children }: { readonly children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    DialogClose: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});
vi.mock("../ui/spinner", () => ({ Spinner: () => null }));

import { I18nProvider } from "../../i18n/I18nProvider";
import { BrowserImportWizard } from "./BrowserImportWizard";

let renderer: ReactTestRenderer | undefined;

const source: BrowserImportSource = {
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "Personal" }],
};

function textContents(): string[] {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      collected.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer?.toJSON());
  return collected;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("BrowserImportWizard localization", () => {
  it("renders translated shell copy while preserving browser and profile names", async () => {
    await act(async () => {
      renderer = create(
        <I18nProvider>
          <BrowserImportWizard
            source={source}
            destinationEnvironmentName="Dev Box"
            targetProfiles={[{ id: "work", name: "Work" }]}
            canCreateProfile={false}
            onImport={vi.fn().mockResolvedValue({
              kind: "imported",
              imported: 1,
              skipped: 0,
              skippedDomains: [],
              targetName: "Work",
            })}
            onRefreshSource={vi.fn().mockResolvedValue(source)}
            onOpenFullDiskAccessSettings={vi.fn()}
            onClose={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    const texts = textContents();
    expect(texts).toContain("从 Helium 导入");
    expect(texts).toContain("选择要为 Dev Box 导入的 Cookie。");
    expect(texts).toContain("Work");
    expect(texts).toContain("导入");
  });
});
