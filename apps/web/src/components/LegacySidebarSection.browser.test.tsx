import { useState, type ReactNode } from "react";
import { render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { LEGACY_SIDEBAR_SECTION_ACTION_CLASS, LegacySidebarSection } from "./LegacySidebarSection";

vi.mock("./ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("morphicons/react", () => ({ MorphIcon: () => <svg /> }));

describe("legacy sidebar section disclosure", () => {
  it("keeps section actions large enough for coarse pointers", () => {
    expect(LEGACY_SIDEBAR_SECTION_ACTION_CLASS).toContain("pointer-coarse:after:min-h-11");
    expect(LEGACY_SIDEBAR_SECTION_ACTION_CLASS).toContain("pointer-coarse:after:min-w-11");
  });
  it("removes collapsed content and reintroduces it for list enter/leave animation while keeping header actions available", async () => {
    let actionCount = 0;
    function Content() {
      return <button>Thread</button>;
    }
    function Section() {
      const [expanded, setExpanded] = useState(true);
      return (
        <LegacySidebarSection
          section="projects"
          label="Projects"
          expanded={expanded}
          onToggle={() => setExpanded((current) => !current)}
          actions={
            <button
              onClick={() => {
                actionCount++;
              }}
            >
              Add project
            </button>
          }
        >
          <Content />
        </LegacySidebarSection>
      );
    }
    await using screen = await render(<Section />);
    await expect.element(screen.getByRole("button", { name: "Thread" })).toBeVisible();
    await screen.getByRole("button", { name: "Projects", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Thread" })).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Add project" }).click();
    expect(actionCount).toBe(1);
    await screen.getByRole("button", { name: "Projects", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Thread" })).toBeVisible();
  });
});
