import { type LegendListRef } from "@legendapp/list/react";
import { createRef } from "react";
import { act, render } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";

import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { Textarea } from "./textarea";
import { Command, CommandInput } from "./command";
import { CommandPaletteVirtualizedResults } from "../CommandPaletteResults";
import { type CommandPaletteRow } from "../CommandPalette.logic";
import { BranchPicker } from "../BranchPicker";
import { ComboboxTrigger } from "./combobox";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "../chat/ModelPickerContent";

async function reachEnd(region: ParentNode, viewport: HTMLElement, drag = false) {
  let lane: HTMLElement | null = null;
  await vi.waitFor(() => {
    lane = region.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
    expect(lane).not.toBeNull();
    expect(viewport.clientHeight).toBeGreaterThan(0);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(Number(lane!.getAttribute("aria-valuemax"))).toBe(
      viewport.scrollHeight - viewport.clientHeight,
    );
  });
  if (drag) {
    const thumb = lane!.querySelector<HTMLElement>('[data-slot="overlay-scrollbar-thumb"]')!;
    const track = lane!.getBoundingClientRect();
    const bounds = thumb.getBoundingClientRect();
    using _capture = vi.spyOn(thumb, "setPointerCapture").mockImplementation(() => {});
    using _release = vi.spyOn(thumb, "releasePointerCapture").mockImplementation(() => {});
    await act(() => {
      thumb.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          clientY: bounds.top + 1,
        }),
      );
      thumb.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: track.bottom }),
      );
      thumb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    });
  } else {
    lane!.focus();
    await userEvent.keyboard("{End}");
  }
  await vi.waitFor(() => {
    expect(
      Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)),
    ).toBeLessThanOrEqual(1);
    expect(Number(lane!.getAttribute("aria-valuenow"))).toBeCloseTo(viewport.scrollTop, 0);
  });
}

describe("shared scrollbar consumers", () => {
  it("binds the model picker thumb before the reader scrolls and reaches the last model", async () => {
    const instanceId = ProviderInstanceId.make("pi");
    const models = Array.from({ length: 35 }, (_, index) => ({
      slug: `audit-${String(index).padStart(2, "0")}`,
      name: `Audit model ${String(index).padStart(2, "0")}`,
      isCustom: false,
      capabilities: {},
    }));
    const entries = deriveProviderInstanceEntries([
      {
        instanceId,
        driver: ProviderDriverKind.make("pi"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-25T00:00:00.000Z",
        models,
        skills: [],
        slashCommands: [],
      },
    ]);
    const select = vi.fn();
    await using screen = await render(
      <ModelPickerContent
        environmentId={null}
        activeInstanceId={instanceId}
        model="audit-00"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map([[instanceId, models]])}
        terminalOpen={false}
        onInstanceModelChange={select}
      />,
    );
    await expect.element(screen.getByPlaceholder("Search models...")).toBeVisible();
    const viewport = screen.container.querySelector<HTMLElement>(".overlay-scroll-viewport")!;
    await reachEnd(screen.container, viewport, true);
    await screen.getByRole("option").filter({ hasText: "Audit model 34" }).click();
    expect(select).toHaveBeenCalledWith(instanceId, "audit-34");
    await screen.getByPlaceholder("Search models...").fill("Audit model 01");
    await expect
      .element(screen.getByRole("option").filter({ hasText: "Audit model 01" }))
      .toBeVisible();
    await screen.getByRole("option").filter({ hasText: "Audit model 01" }).click();
    expect(select).toHaveBeenLastCalledWith(instanceId, "audit-01");
    await screen.getByPlaceholder("Search models...").fill("");
    await reachEnd(screen.container, viewport);
    await expect
      .element(screen.getByRole("option").filter({ hasText: "Audit model 34" }))
      .toBeVisible();
  });

  it("keeps the branch virtualizer and its scroll pagination reachable", async () => {
    const branches = Array.from({ length: 50 }, (_, index) => `branch-${index}`);
    const onLoadNext = vi.fn();
    await using _screen = await render(
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
        renderItem={(branch) => <div style={{ height: 28 }}>{branch}</div>}
      >
        <ComboboxTrigger>Branches</ComboboxTrigger>
      </BranchPicker>,
    );
    await expect.element(page.getByText("branch-0", { exact: true })).toBeVisible();
    const list = document.querySelector<HTMLElement>('[data-slot="combobox-list"]')!;
    const lane = list.querySelector<HTMLElement>('[role="scrollbar"][aria-orientation="vertical"]');
    expect(lane).not.toBeNull();
    const viewport = lane!.parentElement!.firstElementChild as HTMLElement;
    await act(() => viewport.dispatchEvent(new Event("scroll")));
    await reachEnd(list, viewport, true);
    await vi.waitFor(() => expect(onLoadNext).toHaveBeenCalledOnce());
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
    await using screen = await render(
      <div style={{ maxHeight: 224, width: 400 }}>
        <Command virtualized items={rows.map((row) => row.key)}>
          <CommandInput />
          <CommandPaletteVirtualizedResults
            rows={rows}
            listRef={listRef}
            isActionsOnly
            keybindings={[]}
            onExecuteItem={() => undefined}
          />
        </Command>
      </div>,
    );
    await vi.waitFor(() =>
      expect(listRef.current?.getScrollableNode()).toBeInstanceOf(HTMLElement),
    );
    const viewport = listRef.current?.getScrollableNode();
    expect(viewport).toBeInstanceOf(HTMLElement);
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="scrollbar"]')).not.toBeNull(),
    );
    const lane = screen.container.querySelector<HTMLElement>(
      '[role="scrollbar"][aria-orientation="vertical"]',
    )!;
    const frame = lane.parentElement!;
    await act(() => lane.dispatchEvent(new Event("pointerenter")));
    await vi.waitFor(() =>
      expect(frame.style.getPropertyValue("--compact-scrollbar-reveal")).toBe("1"),
    );
    await reachEnd(screen.container, viewport as HTMLElement);
    await act(() => lane.dispatchEvent(new Event("pointerleave")));
    await vi.waitFor(() =>
      expect(frame.style.getPropertyValue("--compact-scrollbar-reveal")).toBe("0"),
    );
  });

  it("scrolls a capped textarea without replacing its native input or losing its value", async () => {
    const draft = Array.from({ length: 60 }, (_, index) => `Keep this draft ${index}`).join("\n");
    await using screen = await render(<Textarea defaultValue={draft} />);
    const textarea = screen.container.querySelector("textarea")!;
    await reachEnd(screen.container, textarea);
    expect(textarea.value).toBe(draft);
    expect(screen.container.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("scrolls persistent popover content without remounting its draft", async () => {
    await using _screen = await render(
      <Popover open>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverPopup keepMounted>
          <div style={{ height: 1800, width: 220 }}>
            <input aria-label="Popover draft" defaultValue="Keep this popover draft" />
          </div>
        </PopoverPopup>
      </Popover>,
    );
    const viewport = document.querySelector<HTMLElement>('[data-slot="popover-viewport"]')!;
    const input = viewport.querySelector("input")!;
    await reachEnd(document.querySelector('[data-slot="popover-popup"]')!, viewport);
    expect(document.querySelector('[aria-label="Popover draft"]')).toBe(input);
    expect(input.value).toBe("Keep this popover draft");
  });
});
