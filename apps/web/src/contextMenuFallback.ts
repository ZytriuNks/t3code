import type { ContextMenuItem } from "@t3tools/contracts";

import { shouldHideUnavailableContextMenuItems } from "./contextMenuPreferences";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  archive: [
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ],
  check: [{ tag: "path", attrs: { d: "M20 6 9 17l-5-5" } }],
  timer: [
    { tag: "line", attrs: { x1: "10", x2: "14", y1: "2", y2: "2" } },
    { tag: "line", attrs: { x1: "12", x2: "15", y1: "14", y2: "11" } },
    { tag: "circle", attrs: { cx: "12", cy: "14", r: "8" } },
  ],
  "chevron-right": [{ tag: "path", attrs: { d: "m9 19 7-7-7-7" } }],
  "circle-check": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "m9 12 2 2 4-4" } },
  ],
  clock: [
    { tag: "path", attrs: { d: "M12 6v6l4 2" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
  ],
  pencil: [
    {
      tag: "path",
      attrs: {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    },
    { tag: "path", attrs: { d: "m15 5 4 4" } },
  ],
  copy: [
    { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
  ],
  folder: [
    {
      tag: "path",
      attrs: {
        d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      },
    },
  ],
  "git-branch": [
    { tag: "line", attrs: { x1: "6", x2: "6", y1: "3", y2: "15" } },
    { tag: "circle", attrs: { cx: "18", cy: "6", r: "3" } },
    { tag: "circle", attrs: { cx: "6", cy: "18", r: "3" } },
    { tag: "path", attrs: { d: "M18 9a9 9 0 0 1-9 9" } },
  ],
  hash: [
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "9", y2: "9" } },
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "15", y2: "15" } },
    { tag: "line", attrs: { x1: "10", x2: "8", y1: "3", y2: "21" } },
    { tag: "line", attrs: { x1: "16", x2: "14", y1: "3", y2: "21" } },
  ],
  "mail-open": [
    {
      tag: "path",
      attrs: {
        d: "M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z",
      },
    },
    { tag: "path", attrs: { d: "m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" } },
  ],
  "message-square-plus": [
    {
      tag: "path",
      attrs: {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    },
    { tag: "path", attrs: { d: "M12 8v6" } },
    { tag: "path", attrs: { d: "M9 11h6" } },
  ],
  pin: [
    { tag: "path", attrs: { d: "M12 17v5" } },
    {
      tag: "path",
      attrs: {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
      },
    },
  ],
  "pin-off": [
    { tag: "path", attrs: { d: "M12 17v5" } },
    { tag: "path", attrs: { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" } },
    { tag: "path", attrs: { d: "m2 2 20 20" } },
    {
      tag: "path",
      attrs: {
        d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
      },
    },
  ],
  "refresh-cw": [
    { tag: "path", attrs: { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" } },
    { tag: "path", attrs: { d: "M21 3v5h-5" } },
    { tag: "path", attrs: { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" } },
    { tag: "path", attrs: { d: "M8 16H3v5" } },
  ],
  settings: [
    {
      tag: "path",
      attrs: {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "3" } },
  ],
  "folder-tree": [
    {
      tag: "path",
      attrs: {
        d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    { tag: "path", attrs: { d: "M3 5a2 2 0 0 0 2 2h3" } },
    { tag: "path", attrs: { d: "M3 3v13a2 2 0 0 0 2 2h3" } },
  ],
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
    { tag: "line", attrs: { x1: "10", x2: "10", y1: "11", y2: "17" } },
    { tag: "line", attrs: { x1: "14", x2: "14", y1: "11", y2: "17" } },
  ],
};

function createIconElement(name: string, tone: "neutral" | "destructive"): SVGSVGElement | null {
  const paths = ICON_PATHS[name];
  if (!paths || typeof document.createElementNS !== "function") {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute(
    "class",
    tone === "destructive"
      ? "size-4.5 shrink-0 sm:size-4"
      : "size-4.5 shrink-0 text-muted-foreground sm:size-4",
  );
  for (const node of paths) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      child.setAttribute(key, value);
    }
    svg.appendChild(child);
  }
  return svg;
}

function clampMenuPosition(menu: HTMLDivElement, preferredLeft: number, preferredTop: number) {
  const rect = menu.getBoundingClientRect();
  const left = Math.min(
    Math.max(4, preferredLeft),
    Math.max(4, window.innerWidth - rect.width - 4),
  );
  const top = Math.min(
    Math.max(4, preferredTop),
    Math.max(4, window.innerHeight - rect.height - 4),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function isNodeWithinMenuStack(target: EventTarget | null, menuStack: readonly HTMLDivElement[]) {
  if (typeof Node !== "undefined" && target instanceof Node) {
    return menuStack.some((menu) => menu.contains(target));
  }
  if (!target || typeof target !== "object") {
    return false;
  }

  let current: unknown = target;
  while (current && typeof current === "object") {
    if (menuStack.includes(current as HTMLDivElement)) {
      return true;
    }
    current = (current as { parent?: unknown }).parent;
  }
  return false;
}

// Only one renderer menu exists at a time; the active one is
// tracked so a state change (for example a terminal selection clearing) can
// dismiss it with the same result as an outside click or Escape.
function filterUnavailableContextMenuItems<T extends string>(
  items: readonly ContextMenuItem<T>[],
): ReadonlyArray<ContextMenuItem<T>> {
  if (!shouldHideUnavailableContextMenuItems()) return items;

  const visible = items.flatMap((item) => {
    if (item.disabled) return [];
    if (!item.children) return [item];
    const children = filterUnavailableContextMenuItems(item.children);
    return children.length > 0 ? [{ ...item, children }] : [];
  });
  const first = visible[0];
  if (!first?.separatorBefore) return visible;
  const { separatorBefore: _separatorBefore, ...withoutSeparator } = first;
  return [withoutSeparator, ...visible.slice(1)];
}

let activeContextMenuDismiss: (() => void) | null = null;
let contextMenuSequence = 0;

export function isContextMenuOpen(): boolean {
  return activeContextMenuDismiss !== null;
}

/**
 * Closes the currently open fallback context menu, resolving its show() with
 * null (the same result as dismissing by outside click or Escape). No-op when
 * no renderer menu is open.
 */
export function dismissContextMenu(): void {
  activeContextMenuDismiss?.();
  activeContextMenuDismiss = null;
}

/**
 * Imperative DOM-based context menu shared by web and desktop renderers.
 * Supports nested submenus and resolves with the clicked leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
  options: { preserveFocus?: boolean } = {},
): Promise<T | null> {
  const visibleItems = filterUnavailableContextMenuItems(items);
  if (visibleItems.length === 0) return Promise.resolve(null);
  return new Promise<T | null>((resolve) => {
    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menuId = `context-menu-${++contextMenuSequence}`;
    const previousActiveDescendant =
      previouslyFocusedElement?.getAttribute("aria-activedescendant");
    const previousControls = previouslyFocusedElement?.getAttribute("aria-controls");
    const previousSelection = document.getSelection?.();
    const previousRanges = Array.from({ length: previousSelection?.rangeCount ?? 0 }, (_, index) =>
      previousSelection!.getRangeAt(index).cloneRange(),
    );
    const menuStack: HTMLDivElement[] = [];
    const highlightUpdates = new Map<HTMLButtonElement, () => void>();
    const keyboardHandlers = new Map<HTMLButtonElement, (event: KeyboardEvent) => void>();
    let virtualFocusedButton: HTMLButtonElement | undefined;
    let hoveredButton: HTMLButtonElement | undefined;
    let keyboardFocusNavigationActive = false;
    const focusButton = (button: HTMLButtonElement | undefined) => {
      if (!button) return;
      if (!options.preserveFocus) {
        button.focus({ preventScroll: true });
        return;
      }
      const previousButton = virtualFocusedButton;
      virtualFocusedButton = button;
      previouslyFocusedElement?.setAttribute("aria-controls", `${menuId}-0`);
      previouslyFocusedElement?.setAttribute("aria-activedescendant", button.id);
      if (previousButton) highlightUpdates.get(previousButton)?.();
      highlightUpdates.get(button)?.();
    };
    const submenuTriggerStack: Array<HTMLButtonElement | undefined> = [];
    let isDisposed = false;
    let canDismissFromPointer = false;

    const dismiss = () => cleanup(null);

    const cleanup = (result: T | null) => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      if (activeContextMenuDismiss === dismiss) {
        activeContextMenuDismiss = null;
      }
      document.removeEventListener("keydown", onKeyDown, options.preserveFocus === true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      const shouldRestoreFocus = isNodeWithinMenuStack(document.activeElement, menuStack);
      for (const menu of menuStack) {
        menu.remove();
      }
      if (shouldRestoreFocus && previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
        if (previousRanges.length > 0) {
          const selection = document.getSelection?.();
          selection?.removeAllRanges();
          for (const range of previousRanges) {
            if (range.startContainer.isConnected && range.endContainer.isConnected) {
              selection?.addRange(range);
            }
          }
        }
      }
      if (options.preserveFocus && previouslyFocusedElement) {
        if (previousActiveDescendant)
          previouslyFocusedElement.setAttribute("aria-activedescendant", previousActiveDescendant);
        else previouslyFocusedElement.removeAttribute("aria-activedescendant");
        if (previousControls)
          previouslyFocusedElement.setAttribute("aria-controls", previousControls);
        else previouslyFocusedElement.removeAttribute("aria-controls");
      }
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey ? "⌘" : event.ctrlKey ? "Ctrl+" : null;
      if (modifier && !event.altKey && !event.shiftKey) {
        const shortcut = `${modifier}${event.key.toUpperCase()}`;
        const item = items.find(
          (candidate) =>
            candidate.shortcut === shortcut && !candidate.header && !candidate.children?.length,
        );
        if (item) {
          event.preventDefault();
          if (options.preserveFocus) event.stopPropagation();
          if (!item.disabled) cleanup(item.id);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (options.preserveFocus) event.stopPropagation();
        cleanup(null);
        return;
      }
      if (options.preserveFocus) {
        if (virtualFocusedButton) keyboardHandlers.get(virtualFocusedButton)?.(event);
        const editsSelection = [
          "ArrowLeft",
          "ArrowRight",
          "Backspace",
          "Delete",
          "PageUp",
          "PageDown",
          "Insert",
          "Clear",
        ].includes(event.key);
        if (event.defaultPrevented || editsSelection || (!modifier && event.key.length === 1)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      cleanup(null);
    };

    const onContextMenu = (event: MouseEvent) => {
      if (isNodeWithinMenuStack(event.target, menuStack)) {
        event.preventDefault();
        return;
      }
      if (!canDismissFromPointer) return;
      event.preventDefault();
      cleanup(null);
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        submenuTriggerStack.pop()?.setAttribute("aria-expanded", "false");
        menuStack.pop()?.remove();
      }
    };

    const openMenu = (
      entries: readonly ContextMenuItem<T>[],
      preferredLeft: number,
      preferredTop: number,
      level: number,
      parentTrigger?: HTMLButtonElement,
    ) => {
      closeMenusFromLevel(level);

      const menu = document.createElement("div");
      menu.className =
        "dropdown-glass fixed z-[10000] flex min-w-[min(10rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg bg-clip-padding text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)] [-webkit-app-region:no-drag]";
      menu.style.cssText =
        "position:fixed;z-index:10000;display:flex;min-width:min(10rem,calc(100vw - 2rem));max-width:calc(100vw - 2rem);overflow:hidden;border-radius:var(--radius-lg);background-clip:padding-box;color:var(--contrast-popover-foreground);box-shadow:0 16px 40px -18px rgb(0 0 0 / 55%);outline:none;pointer-events:auto;-webkit-app-region:no-drag;";
      menu.id = `${menuId}-${level}`;
      menu.setAttribute("role", "menu");
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);

      const inner = document.createElement("div");
      inner.className = "w-full min-w-0 max-w-sm overflow-x-hidden p-1";
      inner.style.cssText =
        "width:100%;min-width:0;max-width:24rem;overflow-x:hidden;padding:0.25rem;";

      const enabledButtons = () =>
        [...inner.querySelectorAll<HTMLButtonElement>("button")].filter(
          (candidate) => !candidate.disabled,
        );
      const focusAdjacentButton = (button: HTMLButtonElement, direction: 1 | -1) => {
        const buttons = enabledButtons();
        const currentIndex = buttons.indexOf(button);
        if (currentIndex < 0 || buttons.length === 0) return;
        const nextIndex = (currentIndex + direction + buttons.length) % buttons.length;
        focusButton(buttons[nextIndex]);
      };

      for (const item of entries) {
        if (item.separatorBefore === true && inner.children.length > 0) {
          const separator = document.createElement("div");
          separator.className = "mx-2 my-1 h-px bg-border";
          separator.style.cssText =
            "height:1px;margin:0.25rem 0.5rem;background:var(--contrast-border);";
          separator.dataset.contextMenuSeparator = "true";
          separator.setAttribute("role", "separator");
          inner.appendChild(separator);
        }

        if (item.header === true) {
          const header = document.createElement("div");
          header.className = "px-2 py-1.5 font-medium text-muted-foreground text-xs";
          header.textContent = item.label;
          inner.appendChild(header);
          continue;
        }

        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const isLeafDestructive =
          !hasChildren && (item.destructive === true || item.id === ("delete" as T));

        const button = document.createElement("button");
        button.type = "button";
        if (options.preserveFocus) {
          button.id = `${menu.id}-item-${inner.children.length}`;
          button.tabIndex = -1;
        }
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        button.setAttribute(
          "role",
          typeof item.checked === "boolean" ? "menuitemradio" : "menuitem",
        );
        if (isDisabled) {
          button.setAttribute("aria-disabled", "true");
        }
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-base text-foreground outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-7 sm:text-sm";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground opacity-64`
          : isLeafDestructive
            ? `${rowBase} text-destructive-foreground hover:bg-destructive/30 hover:text-destructive-foreground`
            : `${rowBase} text-foreground hover:bg-accent hover:text-accent-foreground`;
        button.style.cssText =
          "border:0;background:transparent;color:var(--contrast-foreground);font-family:var(--font-sans,system-ui,sans-serif);text-align:left;";
        if (isLeafDestructive) {
          button.style.color = "var(--destructive-foreground)";
        }
        if (isDisabled) {
          button.style.color = "var(--contrast-muted-foreground)";
          button.style.opacity = "0.64";
          button.style.pointerEvents = "none";
        }

        if (typeof item.checked === "boolean") {
          // Option rows use the icon slot for the check so labels line up
          // with icon rows. The unselected option keeps the slot empty.
          button.setAttribute("role", "menuitemradio");
          button.setAttribute("aria-checked", item.checked ? "true" : "false");
          const check = item.checked ? createIconElement("check", "neutral") : null;
          if (check) {
            button.appendChild(check);
          } else {
            const spacer = document.createElement("span");
            spacer.className = "size-4.5 shrink-0 sm:size-4";
            spacer.style.cssText = "display:inline-block;width:1rem;height:1rem;flex-shrink:0;";
            spacer.setAttribute("aria-hidden", "true");
            button.appendChild(spacer);
          }
        } else if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isLeafDestructive ? "destructive" : "neutral");
          if (icon) {
            button.appendChild(icon);
          }
        }

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);

        if (item.shortcut) {
          const shortcut = document.createElement("span");
          shortcut.className = "ms-auto ps-4 text-xs tracking-widest text-muted-foreground";
          shortcut.textContent = item.shortcut;
          button.appendChild(shortcut);
        }

        if (hasChildren) {
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("aria-expanded", "false");
          const chevron = createIconElement("chevron-right", "neutral");
          if (chevron) {
            chevron.setAttribute(
              "class",
              "-me-0.5 ms-auto size-4.5 shrink-0 text-muted-foreground opacity-80 sm:size-4",
            );
            chevron.setAttribute("aria-hidden", "true");
            chevron.dataset.contextMenuChevron = "true";
            button.appendChild(chevron);
          }
        }

        let openSubmenu: ((focusFirstItem?: boolean) => void) | undefined;
        if (!isDisabled) {
          let isHovered = false;
          let isKeyboardFocused = false;
          const updateHighlight = () => {
            // Pointer hover and keyboard-driven focus both paint the row.
            // The `aria-activedescendant` virtual focus only paints once
            // the user has actually driven focus with the keyboard, so the
            // menu starts quiet even when the shell routes the request
            // through the preserve-focus path (native editing menus).
            const isHighlighted =
              isHovered ||
              isKeyboardFocused ||
              (keyboardFocusNavigationActive &&
                options.preserveFocus &&
                virtualFocusedButton === button);
            isHovered ||
              (keyboardFocusNavigationActive &&
                options.preserveFocus &&
                virtualFocusedButton === button);
            button.style.background = isHighlighted
              ? isLeafDestructive
                ? "color-mix(in srgb, var(--destructive) 30%, transparent)"
                : "var(--accent)"
              : "transparent";
            button.style.color = isHighlighted
              ? isLeafDestructive
                ? "var(--destructive-foreground)"
                : "var(--contrast-accent-foreground)"
              : isLeafDestructive
                ? "var(--destructive-foreground)"
                : "var(--contrast-foreground)";
          };
          highlightUpdates.set(button, updateHighlight);
          button.addEventListener("mouseenter", () => {
            // Pointer hover transfers real DOM focus to the row so keyboard
            // activation still works, but `isKeyboardFocused` stays false so
            // the highlight is purely visual. Blur whichever row currently
            // owns focus so opening a nested submenu doesn't leave its first
            // row focused.
            if (document.activeElement && document.activeElement !== button) {
              (document.activeElement as HTMLElement).blur();
            }
            button.focus({ preventScroll: true });
            hoveredButton = button;
            isHovered = true;
            updateHighlight();
          });
          button.addEventListener("mouseleave", () => {
            isHovered = false;
            if (hoveredButton === button) hoveredButton = undefined;
            // Drop DOM focus the pointer transferred so the row stops
            // highlighting once the cursor leaves the menu.
            if (document.activeElement === button) button.blur();
            updateHighlight();
          });
          button.addEventListener("focus", () => {
            // `tabindex` is `0`, so DOM focus can also arrive from a
            // pointer-driven call to `focusButton(...)` (open time, sibling
            // mouseenter, ArrowLeft returning to the parent trigger). Treat
            // those as silent — only real keyboard navigation should paint.
            if (keyboardFocusNavigationActive) {
              isKeyboardFocused = true;
            }
            updateHighlight();
          });
          button.addEventListener("blur", () => {
            isKeyboardFocused = false;
            updateHighlight();
          });

          if (hasChildren) {
            openSubmenu = (focusFirstItem = false) => {
              const rect = button.getBoundingClientRect();
              const nextLeft = rect.right + 4;
              const nextTop = rect.top;
              openMenu(item.children!, nextLeft, nextTop, level + 1, button);
              button.setAttribute("aria-expanded", "true");

              const childMenu = menuStack[level + 1];
              if (!childMenu) {
                return;
              }
              const childRect = childMenu.getBoundingClientRect();
              if (childRect.right > window.innerWidth) {
                clampMenuPosition(childMenu, rect.left - childRect.width - 4, rect.top);
              }
              if (focusFirstItem) {
                focusButton(
                  [...childMenu.querySelectorAll<HTMLButtonElement>("button")].find(
                    (childButton) => !childButton.disabled,
                  ),
                );
              }
            };
            button.addEventListener("mouseenter", () => {
              openSubmenu?.();
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
              openSubmenu?.(true);
            });
          } else {
            button.addEventListener("mouseenter", () => {
              closeMenusFromLevel(level + 1);
            });
            button.addEventListener("click", () => {
              if (canDismissFromPointer) cleanup(item.id);
            });
          }

          const onButtonKeyDown = (event: KeyboardEvent) => {
            keyboardFocusNavigationActive = true;
            switch (event.key) {
              case "ArrowDown":
                event.preventDefault();
                focusAdjacentButton(button, 1);
                return;
              case "ArrowUp":
                event.preventDefault();
                focusAdjacentButton(button, -1);
                return;
              case "Home":
                event.preventDefault();
                focusButton(enabledButtons()[0]);
                return;
              case "End": {
                event.preventDefault();
                const buttons = enabledButtons();
                focusButton(buttons.at(-1));
                return;
              }
              case "ArrowRight":
                if (openSubmenu) {
                  event.preventDefault();
                  openSubmenu(true);
                }
                return;
              case "ArrowLeft":
                if (level > 0) {
                  event.preventDefault();
                  closeMenusFromLevel(level);
                  focusButton(parentTrigger);
                }
                return;
              case "Enter":
              case " ":
                event.preventDefault();
                if (openSubmenu) {
                  openSubmenu(true);
                } else {
                  cleanup(item.id);
                }
                return;
              case "Tab":
                event.preventDefault();
                cleanup(null);
                return;
            }
          };
          keyboardHandlers.set(button, onButtonKeyDown);
          button.addEventListener("keydown", onButtonKeyDown);
        }

        inner.appendChild(button);
      }

      menu.appendChild(inner);
      if (options.preserveFocus) {
        // Native editing menus must not blur inputs that commit/reset drafts on blur.
        menu.addEventListener("pointerdown", (event) => event.preventDefault());
      }

      // Mouse leaving a submenu dismisses that submenu (and any deeper
      // submenus it owned) so the user does not leave an orphaned menu
      // on screen. The root menu stays mounted until the user clicks
      // outside, presses Escape, or another dismissal path fires; only
      // moves into another menu in the tree are ignored.
      menu.addEventListener("mouseleave", (event) => {
        const related = event.relatedTarget as Node | null;
        if (related) {
          for (let l = 0; l < menuStack.length; l++) {
            if (menuStack[l]?.contains(related)) return;
          }
        }
        if (level === 0) {
          closeMenusFromLevel(level + 1);
        } else {
          closeMenusFromLevel(level);
        }
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;
      submenuTriggerStack[level] = parentTrigger;

      if (level === 0 || menuStack[level - 1] !== undefined) {
        focusButton(enabledButtons()[0]);
      }

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
      });
    };

    document.addEventListener("keydown", onKeyDown, options.preserveFocus === true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    openMenu(visibleItems, position?.x ?? 0, position?.y ?? 0, 0);
    // Only one renderer menu can be open at a time: a new show must dismiss
    // any prior one, or its DOM and listeners leak and close() can only ever
    // reach the newest menu.
    if (activeContextMenuDismiss) {
      activeContextMenuDismiss();
    }
    activeContextMenuDismiss = dismiss;

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}
