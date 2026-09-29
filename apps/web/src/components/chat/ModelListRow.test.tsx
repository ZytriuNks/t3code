import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ModelListRow } from "./ModelListRow";

vi.mock("../ui/combobox", () => ({
  // The real ComboboxItem requires a Combobox.Root ancestor at render
  // time; for ModelListRow we only care about its rendered children.
  ComboboxItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/kbd", () => ({
  Kbd: ({ children }: { children: React.ReactNode }) => <kbd>{children}</kbd>,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));
vi.mock("./ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: () => <span />,
}));

const PI = ProviderDriverKind.make("pi");
const OPENCODE = ProviderDriverKind.make("opencode");

function renderRow(overrides: Partial<Parameters<typeof ModelListRow>[0]> = {}) {
  return renderToStaticMarkup(
    <ModelListRow
      index={0}
      model={{ slug: "gpt-5", name: "GPT-5" }}
      instanceId={ProviderInstanceId.make("pi_work")}
      driverKind={PI}
      providerDisplayName="Pi"
      isFavorite={false}
      isSelected={false}
      showProvider={true}
      onToggleFavorite={() => {}}
      {...overrides}
    />,
  );
}

describe("ModelListRow provider footer", () => {
  it("renders the instance name joined to the sub-provider with a middle dot", () => {
    const markup = renderRow({
      model: { slug: "gpt-5", name: "GPT-5", subProvider: "openai" },
    });

    expect(markup).toContain("Pi · openai");
    expect(markup).not.toContain("Pi/openai");
  });

  it("renders just the instance name when no sub-provider is known", () => {
    const markup = renderRow();

    expect(markup).toContain(">Pi<");
    expect(markup).not.toContain("Pi · ");
  });

  it("uses the same middle-dot separator for OpenCode instances", () => {
    const markup = renderRow({
      driverKind: OPENCODE,
      providerDisplayName: "opencode",
      model: { slug: "claude-opus-4.7", name: "Claude Opus 4.7", subProvider: "GitHub Copilot" },
    });

    expect(markup).toContain("opencode · GitHub Copilot");
    expect(markup).not.toContain("opencode/GitHub Copilot");
  });

  it("omits the provider footer entirely when showProvider is false", () => {
    const markup = renderRow({
      showProvider: false,
      model: { slug: "gpt-5", name: "GPT-5", subProvider: "openai" },
    });

    expect(markup).not.toContain("Pi · openai");
    expect(markup).not.toContain(">Pi<");
  });
});
