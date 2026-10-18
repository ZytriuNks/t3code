import { act, useEffect, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LEGACY_SIDEBAR_SECTION_ACTION_CLASS, LegacySidebarSection } from "./LegacySidebarSection";

vi.mock("./ui/sidebar", () => ({
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("morphicons/react", () => ({ MorphIcon: () => <svg /> }));

let renderer: ReactTestRenderer | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("legacy sidebar section disclosure", () => {
  it("keeps section actions large enough for coarse pointers", () => {
    expect(LEGACY_SIDEBAR_SECTION_ACTION_CLASS).toContain("pointer-coarse:after:min-h-11");
    expect(LEGACY_SIDEBAR_SECTION_ACTION_CLASS).toContain("pointer-coarse:after:min-w-11");
  });
  it("removes collapsed content and reintroduces it for list enter/leave animation while keeping header actions available", async () => {
    let contentMounted = false;
    let actionCount = 0;
    function Content() {
      useEffect(() => {
        contentMounted = true;
        return () => {
          contentMounted = false;
        };
      }, []);
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
    await act(() => {
      renderer = create(<Section />);
    });
    expect(contentMounted).toBe(true);
    await act(() =>
      renderer!.root
        .findByProps({ "aria-controls": "legacy-sidebar-section-projects" })
        .props.onClick(),
    );
    expect(contentMounted).toBe(false);
    await act(() =>
      renderer!.root
        .findAllByType("button")
        .find((button) => button.props.children === "Add project")!
        .props.onClick(),
    );
    expect(actionCount).toBe(1);
    await act(() =>
      renderer!.root
        .findByProps({ "aria-controls": "legacy-sidebar-section-projects" })
        .props.onClick(),
    );
    expect(contentMounted).toBe(true);
  });
});
