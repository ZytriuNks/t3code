import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ModelListRow } from "./ModelListRow";

vi.mock("../ui/combobox", () => ({
  ComboboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function row(overrides: Partial<ComponentProps<typeof ModelListRow>> = {}) {
  return (
    <ModelListRow
      index={0}
      slug="gpt-5"
      name="GPT-5"
      instanceId={ProviderInstanceId.make("pi_work")}
      driverKind={ProviderDriverKind.make("pi")}
      providerDisplayName="Pi"
      isFavorite={false}
      isSelected={false}
      showInstanceBadge={false}
      onToggleFavorite={() => {}}
      {...overrides}
    />
  );
}

it.each([
  ["pi", "Pi", "openai", "openai"],
  ["pi", "Pi", undefined, "Pi"],
  ["opencode", "opencode", "GitHub Copilot", "GitHub Copilot"],
])(
  "shows the underlying provider for %s",
  async (driver, providerDisplayName, subProvider, label) => {
    await using screen = await render(
      row({
        driverKind: ProviderDriverKind.make(driver!),
        providerDisplayName: providerDisplayName!,
        subProvider,
      }),
    );
    await expect.element(screen.getByText(label!, { exact: true })).toBeVisible();
  },
);

it("renders the subprovider label", async () => {
  await using screen = await render(row({ subProvider: "openai" }));
  await expect.element(screen.getByText("openai", { exact: true })).toBeVisible();
});
