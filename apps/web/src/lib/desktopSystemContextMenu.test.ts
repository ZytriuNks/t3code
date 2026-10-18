// @vitest-environment jsdom
import type { DesktopSystemContextMenuRequest } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { dismissContextMenu } from "../contextMenuFallback";
import { installDesktopSystemContextMenu } from "./desktopSystemContextMenu";

const request: DesktopSystemContextMenuRequest = {
  requestId: "editing:1",
  items: [
    { id: "copy", label: "Copy", shortcut: "Ctrl+C" },
    { id: "paste", label: "Paste", shortcut: "Ctrl+V" },
  ],
  position: { x: 10, y: 20 },
};

function openMenu() {
  let receive: ((request: DesktopSystemContextMenuRequest) => void) | undefined;
  let complete: ((response: { requestId: string; itemId: string | null }) => void) | undefined;
  const result = new Promise<{ requestId: string; itemId: string | null }>((resolve) => {
    complete = resolve;
  });
  const unsubscribe = installDesktopSystemContextMenu({
    onSystemContextMenu: (listener) => {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
    resolveSystemContextMenu: async (response) => {
      complete?.(response);
      return true;
    },
  });
  receive?.(request);
  return { result, unsubscribe };
}

function createAddressInput() {
  const input = document.createElement("input");
  input.value = "https://committed.example";
  document.body.appendChild(input);
  input.focus();
  // The preview address bar resets its draft on blur and selects the committed URL on focus.
  input.addEventListener("blur", () => {
    input.value = "https://committed.example";
  });
  input.addEventListener("focus", () => {
    input.value = "https://committed.example";
    input.select();
  });
  input.value = "uncommitted search draft";
  input.setSelectionRange(2, 8);
  return input;
}

afterEach(() => {
  dismissContextMenu();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("desktop editing menu preserves the editing target", () => {
  it("keeps an uncommitted input draft and partial selection while opening, hovering and clicking", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const input = createAddressInput();
    const menu = openMenu();
    expect(document.activeElement).toBe(input);
    const paste = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Paste"),
    );
    expect(paste).toBeDefined();
    paste!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.activeElement).toBe(input);
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    paste!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    paste!.click();
    await expect(menu.result).resolves.toEqual({ requestId: "editing:1", itemId: "paste" });
    expect(input.value).toBe("uncommitted search draft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
    menu.unsubscribe?.();
  });

  it.each([
    { key: "Escape", itemId: null, ctrlKey: false },
    { key: "Enter", itemId: "paste", ctrlKey: false },
    { key: "c", itemId: "copy", ctrlKey: true },
  ])(
    "routes navigation and $key before input handlers can submit or discard the draft",
    async ({ key, itemId, ctrlKey }) => {
      const input = createAddressInput();
      input.addEventListener("keydown", () => {
        input.value = "discarded";
      });
      const menu = openMenu();
      expect(
        document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent,
      ).toContain("Copy");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      expect(
        document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent,
      ).toContain("Paste");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
      );
      await expect(menu.result).resolves.toEqual({ requestId: "editing:1", itemId });
      expect(input.getAttribute("aria-activedescendant")).toBeNull();
      expect(input.getAttribute("aria-controls")).toBeNull();
      expect(input.value).toBe("uncommitted search draft");
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
      menu.unsubscribe?.();
    },
  );

  it.each(["ArrowLeft", "ArrowRight", "Backspace", "Delete", "PageUp", "PageDown"])(
    "consumes $0 instead of editing the input behind the menu",
    async (key) => {
      const input = createAddressInput();
      input.addEventListener("keydown", () => {
        input.value = "edited behind menu";
        input.setSelectionRange(0, 0);
      });
      const menu = openMenu();
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(input.value).toBe("uncommitted search draft");
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await expect(menu.result).resolves.toEqual({ requestId: "editing:1", itemId: null });
      menu.unsubscribe?.();
    },
  );

  it("prevents a second right click inside the menu from creating a stale native request", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    createAddressInput();
    const menu = openMenu();
    const copy = document.querySelector("button")!;
    const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    copy.dispatchEvent(rightClick);
    expect(rightClick.defaultPrevented).toBe(true);
    copy.click();
    await expect(menu.result).resolves.toEqual({ requestId: "editing:1", itemId: "copy" });
    menu.unsubscribe?.();
  });
});
