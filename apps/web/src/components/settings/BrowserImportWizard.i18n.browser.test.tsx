import type { BrowserImportSource } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

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
import { I18nProvider } from "../../i18n/I18nProvider";
import { BrowserImportWizard } from "./BrowserImportWizard";

const source: BrowserImportSource = {
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "Personal" }],
};

describe("BrowserImportWizard localization", () => {
  it("renders translated shell copy while preserving browser and profile names", async () => {
    languageState.current = "zh-CN";
    await using screen = await render(
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

    await expect.element(screen.container).toBeInTheDocument();
    await expect.element(page.getByText("从 Helium 导入", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("选择要为 Dev Box 导入的 Cookie。", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Work", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "导入", exact: true })).toBeVisible();
  });
});
