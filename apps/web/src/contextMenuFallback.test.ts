import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopSystemContextMenuRequest } from "@t3tools/contracts";
import { setHideUnavailableContextMenuItems } from "./contextMenuPreferences";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { installDesktopSystemContextMenu } from "./lib/desktopSystemContextMenu";

type FakeListener = (event: FakeDomEvent) => void;

class FakeDomEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    init: Record<string, unknown> = {},
  ) {
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {}
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> & { cssText?: string } = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  disabled = false;
  focused = false;
  type = "";
  private textValue = "";
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly tagName: string) {}

  get isConnected() {
    let current: FakeElement | null = this;
    while (current?.parent) {
      current = current.parent;
    }
    return current?.tagName === "body";
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  focus() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      return;
    }
    fakeDocument.activeElement?.blur();
    fakeDocument.activeElement = this;
    this.focused = true;
    this.dispatchEvent(new FakeDomEvent("focus"));
  }

  blur() {
    const fakeDocument = document as unknown as FakeDocument;
    if (fakeDocument.activeElement === this) {
      fakeDocument.activeElement = null;
    }
    this.focused = false;
    this.dispatchEvent(new FakeDomEvent("blur"));
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get textContent() {
    return `${this.textValue}${this.children.map((child) => child.textContent).join("")}`;
  }

  querySelectorAll(tagName: string): FakeElement[] {
    const matches: FakeElement[] = [];
    if (this.tagName === tagName) {
      matches.push(this);
    }
    for (const child of this.children) {
      matches.push(...child.querySelectorAll(tagName));
    }
    return matches;
  }

  getBoundingClientRect() {
    const left = Number.parseInt(this.style.left ?? "0", 10) || 0;
    const top = Number.parseInt(this.style.top ?? "0", 10) || 0;
    const width = this.tagName === "div" ? 180 : 140;
    const height = this.tagName === "div" ? 120 : 28;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

class FakeBody extends FakeElement {
  private html = "";

  constructor() {
    super("body");
  }

  set innerHTML(value: string) {
    this.html = value;
    this.children = [];
  }

  get innerHTML() {
    return this.html;
  }
}

class FakeDocument {
  body = new FakeBody();
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, FakeListener[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  dispatchEvent(event: FakeDomEvent) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  removeEventListener(type: string, listener: FakeListener) {
    const existing = this.listeners.get(type);
    if (!existing) {
      return;
    }
    const index = existing.indexOf(listener);
    if (index >= 0) {
      existing.splice(index, 1);
    }
  }

  querySelectorAll(tagName: string) {
    return this.body.querySelectorAll(tagName);
  }
}

function findButton(label: string): FakeElement | undefined {
  return (document as unknown as FakeDocument)
    .querySelectorAll("button")
    .find((button) => button.textContent.includes(label));
}

beforeEach(() => {
  setHideUnavailableContextMenuItems(false);
  vi.stubGlobal("document", new FakeDocument());
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("window", {
    innerWidth: 1280,
    innerHeight: 800,
  });
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal(
    "MouseEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
  vi.stubGlobal(
    "KeyboardEvent",
    class extends FakeDomEvent {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type, init);
      }
    },
  );
});

afterEach(() => {
  setHideUnavailableContextMenuItems(false);
  vi.unstubAllGlobals();
});

describe("showContextMenuFallback", () => {
  it("renders one separator between menu sections", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "archive", label: "Archive", separatorBefore: true },
    ]);
    const separators = (document as unknown as FakeDocument)
      .querySelectorAll("div")
      .filter((element) => element.dataset.contextMenuSeparator === "true");

    expect(separators).toHaveLength(1);
    expect(separators[0]?.attributes.get("role")).toBe("separator");
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("resolves a clicked flat menu item", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);

    const renameButton = findButton("Rename");
    expect(renameButton).toBeTruthy();
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it.each(["delete", "remove:project-a"])(
    "highlights destructive action %s immediately on hover and focus",
    async (id) => {
      const selectionPromise = showContextMenuFallback([
        { id: "rename", label: "Rename" },
        { id, label: "Remove", destructive: true },
      ]);
      const renameButton = findButton("Rename");
      const removeButton = findButton("Remove");
      expect(removeButton?.style.background).not.toBe(
        "color-mix(in srgb, var(--destructive) 10%, transparent)",
      );
      removeButton?.dispatchEvent(new MouseEvent("mouseenter"));
      expect(removeButton?.style.background).toBe(
        "color-mix(in srgb, var(--destructive) 10%, transparent)",
      );
      expect(removeButton?.style.color).toBe("var(--destructive-foreground)");
      renameButton?.focus();
      removeButton?.dispatchEvent(new MouseEvent("mouseleave"));
      expect(removeButton?.style.background).toBe("transparent");
      renameButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      expect(removeButton?.style.background).toBe(
        "color-mix(in srgb, var(--destructive) 10%, transparent)",
      );
      removeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await expect(selectionPromise).resolves.toBe(id);
    },
  );

  it("restores selected content before resolving an editing action", async () => {
    const invoker = (document as unknown as FakeDocument).createElement("input");
    (document as unknown as FakeDocument).body.appendChild(invoker);
    invoker.focus();
    const capturedRange = { startContainer: invoker, endContainer: invoker };
    const selection = {
      rangeCount: 1,
      getRangeAt: vi.fn(() => ({ cloneRange: () => capturedRange })),
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    Object.assign(document, { getSelection: () => selection });
    const selectionPromise = showContextMenuFallback([{ id: "copy", label: "Copy" }]);
    findButton("Copy")?.dispatchEvent(new MouseEvent("click"));
    await expect(selectionPromise).resolves.toBe("copy");
    expect(invoker.focused).toBe(true);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange.mock.calls).toHaveLength(1);
    expect(selection.addRange.mock.calls[0]?.[0] === capturedRange).toBe(true);
  });

  it.each([
    { id: "copy", shortcut: "Ctrl+C", key: "c", ctrlKey: true },
    { id: "paste", shortcut: "⌘V", key: "v", metaKey: true },
  ])(
    "activates enabled editing shortcut $shortcut and restores focus",
    async ({ id, shortcut, ...key }) => {
      const input = (document as unknown as FakeDocument).createElement("input");
      (document as unknown as FakeDocument).body.appendChild(input);
      input.focus();
      const selectionPromise = showContextMenuFallback([{ id, label: id, shortcut }]);
      const event = new KeyboardEvent("keydown", key);
      (document as unknown as FakeDocument).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await expect(selectionPromise).resolves.toBe(id);
      expect(input.focused).toBe(true);
    },
  );

  it("does not activate a disabled editing shortcut", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "cut", label: "Cut", shortcut: "Ctrl+X", disabled: true },
      { id: "copy", label: "Copy", shortcut: "Ctrl+C" },
    ]);
    const event = new KeyboardEvent("keydown", { key: "x", ctrlKey: true });
    (document as unknown as FakeDocument).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(findButton("Copy")).toBeDefined();
    findButton("Copy")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(selectionPromise).resolves.toBe("copy");
  });

  it("supports keyboard navigation and activation", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete" },
    ]);

    const renameButton = findButton("Rename");
    const deleteButton = findButton("Delete");
    expect(renameButton?.focused).toBe(true);

    renameButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(deleteButton?.focused).toBe(true);
    deleteButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await expect(selectionPromise).resolves.toBe("delete");
  });

  it("ignores a click from the gesture that opened the menu", async () => {
    let enablePointerSelection: ((time: number) => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      enablePointerSelection = callback;
      return 0;
    });

    const selectionPromise = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const renameButton = findButton("Rename");

    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    enablePointerSelection?.(0);
    renameButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("opens nested submenus and resolves the clicked leaf id", async () => {
    const selectionPromise = showContextMenuFallback([
      {
        id: "rename:submenu",
        label: "Rename project",
        children: [
          { id: "rename:project-a", label: "/tmp/project-a" },
          { id: "rename:project-b", label: "/tmp/project-b" },
        ],
      },
    ]);

    const parentButton = findButton("Rename project");
    expect(parentButton).toBeTruthy();
    parentButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    const childButton = findButton("/tmp/project-b");
    expect(childButton).toBeTruthy();
    childButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("rename:project-b");
  });

  it("opens and focuses nested submenus when the parent is activated", async () => {
    const invoker = (document as unknown as FakeDocument).createElement("button");
    (document as unknown as FakeDocument).body.appendChild(invoker);
    invoker.focus();
    const selectionPromise = showContextMenuFallback([
      {
        id: "copy:submenu",
        label: "Copy",
        children: [
          { id: "copy:path", label: "Path" },
          { id: "copy:branch", label: "Branch" },
        ],
      },
    ]);

    const parentButton = findButton("Copy");
    expect(parentButton).toBeTruthy();
    expect(parentButton?.attributes.get("aria-haspopup")).toBe("menu");
    expect(parentButton?.attributes.get("aria-expanded")).toBe("false");
    parentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(parentButton?.attributes.get("aria-expanded")).toBe("true");

    const childButton = findButton("Path");
    const siblingButton = findButton("Branch");
    expect(childButton).toBeTruthy();
    expect(siblingButton).toBeTruthy();
    expect(childButton?.focused).toBe(true);
    expect(childButton?.style.background).toBe("transparent");
    expect(childButton?.style.color).toBe("var(--contrast-foreground)");
    siblingButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(childButton?.focused).toBe(false);
    expect(childButton?.style.background).toBe("transparent");
    expect(siblingButton?.focused).toBe(true);
    expect(siblingButton?.style.background).toBe("var(--accent)");
    siblingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await expect(selectionPromise).resolves.toBe("copy:branch");
    expect(invoker.focused).toBe(true);
  });

  it("clears a hover highlight when the pointer leaves the menu", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete", destructive: true },
    ]);
    const renameButton = findButton("Rename");
    const deleteButton = findButton("Delete");
    deleteButton?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(deleteButton?.style.background).toBe(
      "color-mix(in srgb, var(--destructive) 10%, transparent)",
    );
    // Move focus off the destructive row so the highlight drops when its
    // hover state is cleared (real browsers behave the same way).
    renameButton?.focus();
    deleteButton?.dispatchEvent(
      new MouseEvent("mouseleave", { bubbles: true, relatedTarget: document.body }),
    );
    expect(deleteButton?.style.background).toBe("transparent");
    dismissContextMenu();
    await expect(selectionPromise).resolves.toBeNull();
  });

  it("hides disabled items when the preference is enabled", async () => {
    setHideUnavailableContextMenuItems(true);
    const selectionPromise = showContextMenuFallback([
      { id: "copy", label: "Copy", disabled: true },
      { id: "rename", label: "Rename" },
    ]);
    expect(findButton("Copy")).toBeUndefined();
    expect(findButton("Rename")).toBeDefined();
    findButton("Rename")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect(selectionPromise).resolves.toBe("rename");
  });

  it("resolves immediately when every item is disabled and hidden", async () => {
    setHideUnavailableContextMenuItems(true);
    await expect(
      showContextMenuFallback([{ id: "copy", label: "Copy", disabled: true }]),
    ).resolves.toBeNull();
  });
});

describe("desktop editing menu", () => {
  function installBridge() {
    let listener: ((request: DesktopSystemContextMenuRequest) => void) | undefined;
    let complete: ((response: { requestId: string; itemId: string | null }) => void) | undefined;
    const completed = new Promise<{ requestId: string; itemId: string | null }>((resolve) => {
      complete = resolve;
    });
    const unsubscribe = installDesktopSystemContextMenu({
      onSystemContextMenu: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
      resolveSystemContextMenu: async (response) => {
        complete?.(response);
        return true;
      },
    });
    return {
      receive: (request: DesktopSystemContextMenuRequest) => listener?.(request),
      unsubscribe,
      completed,
    };
  }

  const request: DesktopSystemContextMenuRequest = {
    requestId: "native:1",
    position: { x: 120, y: 80 },
    items: [
      { id: "cut", label: "Cut", shortcut: "Ctrl+X", disabled: true },
      { id: "copy", label: "Copy", shortcut: "Ctrl+C" },
    ],
  };

  it("draws editing shortcuts and restores input focus before dispatching the native action", async () => {
    const bridge = installBridge();
    const input = (document as unknown as FakeDocument).createElement("input");
    (document as unknown as FakeDocument).body.appendChild(input);
    input.focus();
    bridge.receive(request);
    expect(findButton("Cut")?.disabled).toBe(true);
    expect(findButton("Copy")?.textContent).toBe("CopyCtrl+C");
    findButton("Copy")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(bridge.completed).resolves.toEqual({ requestId: "native:1", itemId: "copy" });
    expect(input.focused).toBe(true);
    bridge.unsubscribe?.();
  });

  it("keeps an application-specific menu instead of overriding it with editing actions", async () => {
    const appSelection = showContextMenuFallback([{ id: "rename", label: "Rename thread" }]);
    const bridge = installBridge();
    bridge.receive(request);
    await expect(bridge.completed).resolves.toEqual({ requestId: "native:1", itemId: null });
    expect(findButton("Copy")).toBeUndefined();
    findButton("Rename thread")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(appSelection).resolves.toBe("rename");
    bridge.unsubscribe?.();
  });

  it("stops accepting shell menu requests after unmount", () => {
    const bridge = installBridge();
    bridge.unsubscribe?.();
    bridge.receive(request);
    expect(findButton("Copy")).toBeUndefined();
    expect(installDesktopSystemContextMenu(undefined)).toBeUndefined();
  });
});

describe("dismissContextMenu", () => {
  it("resolves an open menu with null", async () => {
    const selectionPromise = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Delete" },
    ]);
    expect(findButton("Rename")).toBeTruthy();

    dismissContextMenu();

    await expect(selectionPromise).resolves.toBeNull();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("is a no-op when no menu is open", async () => {
    dismissContextMenu();
    expect(findButton("Rename")).toBeUndefined();
  });

  it("dismisses the prior menu when a new one opens", async () => {
    const firstPromise = showContextMenuFallback([{ id: "first", label: "First" }]);
    expect(findButton("First")).toBeTruthy();

    const secondPromise = showContextMenuFallback([{ id: "second", label: "Second" }]);

    await expect(firstPromise).resolves.toBeNull();
    expect(findButton("First")).toBeUndefined();
    expect(findButton("Second")).toBeTruthy();

    dismissContextMenu();
    await expect(secondPromise).resolves.toBeNull();
  });
});
