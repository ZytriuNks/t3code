// @vitest-environment jsdom

import { type LegendListRef } from "@legendapp/list/react";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { Textarea } from "./textarea";
import { Command, CommandInput } from "./command";
import { CommandPaletteVirtualizedResults } from "../CommandPaletteResults";
import { type CommandPaletteRow } from "../CommandPalette.logic";
import { BranchPicker } from "../BranchPicker";
import { ComboboxTrigger } from "./combobox";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeScrollable(viewport: HTMLElement) {
  // jsdom 的平台方法补丁保留实际 offset 和 scroll 事件，滚动条和状态派生不替换。
  viewport.scrollTo = (options: ScrollToOptions | number = {}, y: number = viewport.scrollTop) => {
    viewport.scrollTop = typeof options === "number" ? y : (options.top ?? viewport.scrollTop);
    viewport.dispatchEvent(new Event("scroll"));
  };
}

function reachEnd(region: ParentNode, viewport: HTMLElement) {
  const lane = region.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
  expect(lane).not.toBeNull();
  makeScrollable(viewport);
  act(() => lane!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(viewport.scrollTop).toBe(800);
  expect(lane!.getAttribute("aria-valuenow")).toBe("800");
}

describe("shared scrollbar consumers", () => {
  it("keeps the branch virtualizer and its scroll pagination reachable", async () => {
    const branches = Array.from({ length: 50 }, (_, index) => `branch-${index}`);
    const onLoadNext = vi.fn();
    await act(async () =>
      root.render(
        <BranchPicker
          items={branches}
          filteredItems={branches}
          value={null}
          query=""
          resultsQuery=""
          onQueryChange={() => undefined}
          open
          onOpenChange={() => undefined}
          onSelectItem={() => undefined}
          hasNextPage
          isFetchingNextPage={false}
          onLoadNext={onLoadNext}
          statusText={null}
          popupProps={{}}
          renderItem={(branch) => <span>{branch}</span>}
        >
          <ComboboxTrigger>Branches</ComboboxTrigger>
        </BranchPicker>,
      ),
    );
    const list = document.querySelector<HTMLElement>('[data-slot="combobox-list"]')!;
    const lane = list.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
    expect(lane).not.toBeNull();
    const viewport = lane!.parentElement!.firstElementChild as HTMLElement;
    act(() => viewport.dispatchEvent(new Event("scroll")));
    reachEnd(list, viewport);
    expect(onLoadNext).toHaveBeenCalledOnce();
  });

  it("scrolls the search virtualizer through its actual scroll node", async () => {
    const listRef = createRef<LegendListRef>();
    const rows: CommandPaletteRow[] = Array.from({ length: 50 }, (_, index) => ({
      kind: "item",
      key: `action-${index}`,
      itemIndex: index,
      item: {
        kind: "action",
        value: `action-${index}`,
        title: `Action ${index}`,
        icon: null,
        searchTerms: [],
        run: async () => undefined,
      },
    }));
    await act(async () =>
      root.render(
        <Command virtualized items={rows.map((row) => row.key)}>
          <CommandInput />
          <CommandPaletteVirtualizedResults
            rows={rows}
            listRef={listRef}
            isActionsOnly
            keybindings={[]}
            onExecuteItem={() => undefined}
          />
        </Command>,
      ),
    );
    const viewport = listRef.current?.getScrollableNode();
    expect(viewport).toBeInstanceOf(HTMLElement);
    const lane = host.querySelector<HTMLElement>(
      '[role="scrollbar"][aria-orientation="vertical"]',
    )!;
    const frame = lane.parentElement!;
    vi.useFakeTimers();
    act(() => lane.dispatchEvent(new Event("pointerenter")));
    expect(frame.style.getPropertyValue("--compact-scrollbar-reveal")).toBe("1");
    reachEnd(host, viewport as HTMLElement);
    act(() => lane.dispatchEvent(new Event("pointerleave")));
    act(() => vi.advanceTimersByTime(700));
    expect(frame.style.getPropertyValue("--compact-scrollbar-reveal")).toBe("0");
  });

  it("scrolls a capped textarea without replacing its native input or losing its value", async () => {
    await act(async () => root.render(<Textarea defaultValue="Keep this draft" />));
    const textarea = host.querySelector("textarea")!;
    reachEnd(host, textarea);
    expect(textarea.value).toBe("Keep this draft");
    expect(host.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("scrolls persistent popover content without remounting its draft", async () => {
    await act(async () =>
      root.render(
        <Popover open>
          <PopoverTrigger>Details</PopoverTrigger>
          <PopoverPopup keepMounted>
            <input aria-label="Popover draft" defaultValue="Keep this popover draft" />
          </PopoverPopup>
        </Popover>,
      ),
    );
    const viewport = document.querySelector<HTMLElement>('[data-slot="popover-viewport"]')!;
    const input = viewport.querySelector("input")!;
    reachEnd(document.querySelector('[data-slot="popover-popup"]')!, viewport);
    expect(document.querySelector('[aria-label="Popover draft"]')).toBe(input);
    expect(input.value).toBe("Keep this popover draft");
  });
});
