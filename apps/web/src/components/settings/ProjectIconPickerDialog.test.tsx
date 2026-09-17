import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: { readonly language: "zh-CN" }) => T) =>
    selector({ language: "zh-CN" }),
}));

vi.mock("../ui/button", () => ({
  Button: ({ children }: { readonly children?: ReactNode }) => <button>{children}</button>,
}));

vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Container,
    DialogDescription: Container,
    DialogFooter: Container,
    DialogHeader: Container,
    DialogPanel: Container,
    DialogPopup: Container,
    DialogTitle: Container,
  };
});

vi.mock("../ui/input", () => ({ Input: () => <input /> }));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/toggle-group", () => ({
  Toggle: ({ children, value }: { readonly children?: ReactNode; readonly value: string }) => (
    <button data-value={value}>{children}</button>
  ),
  ToggleGroup: ({
    children,
    value,
  }: {
    readonly children?: ReactNode;
    readonly value: readonly string[];
  }) => <div data-current={value.join(",")}>{children}</div>,
}));

import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";
import { I18nProvider } from "../../i18n/I18nProvider";

describe("ProjectIconPickerDialog", () => {
  it("shows icons first and selects them for an automatic project", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ProjectIconPickerDialog
          current={null}
          projectName="Test"
          open
          onOpenChange={() => {}}
          onSelect={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('data-current="lucide"');
    expect(markup.indexOf(">图标<")).toBeLessThan(markup.indexOf(">表情符号<"));
    expect(markup).toContain('aria-label="图标颜色"');
    expect(markup).toContain("选择项目图标");
  });
});
