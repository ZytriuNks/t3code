// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

class TestHighlight extends Set<AbstractRange> {}
let root: Root;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let now: number;
let reducedMotion: boolean;
let styles: HTMLStyleElement;

// jsdom does not load the app stylesheet. These two surface rules let it expose
// the parent visibility/opacity written by the real playback hook.
const surfaceRules = `
  .chat-markdown [data-smooth-surface] { opacity: var(--t3-smooth-surface-opacity, 1); }
  .chat-markdown [data-smooth-inline-pending] { visibility: hidden; pointer-events: none; }
`;

beforeEach(() => {
  frames = new Map();
  now = 0;
  reducedMotion = false;
  let id = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-reduced-motion") && reducedMotion,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, 200, 20),
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [new DOMRect(0, 0, 200, 20)] as unknown as DOMRectList,
  );
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(14, 0, 10, 20),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(14, 0, 10, 20)],
  });
  styles = document.createElement("style");
  styles.textContent = surfaceRules;
  document.head.append(styles);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  styles.remove();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(text: string, props: Partial<ComponentProps<typeof ChatMarkdown>> = {}) {
  await act(() =>
    root.render(
      <ChatMarkdown
        cwd="C:/workspace"
        text={text}
        smoothStreaming
        isStreaming
        smoothTextFadeDurationMs={500}
        {...props}
      />,
    ),
  );
}
async function frame(at: number) {
  now = at;
  const callbacks = [...frames.values()];
  frames.clear();
  await act(() => callbacks.forEach((callback) => callback(now)));
}
function surfaceFor(icon: Element) {
  const surface = icon.closest<HTMLElement>("[data-smooth-surface]");
  expect(surface, "the icon must share the hook-owned entry surface with its label").not.toBeNull();
  return surface!;
}
function opacity(surface: HTMLElement) {
  const computed = getComputedStyle(surface);
  // jsdom preserves var() expressions; the browser resolves the same shipped rule.
  return computed.opacity.startsWith("var(")
    ? Number(computed.getPropertyValue("--t3-smooth-surface-opacity") || 1)
    : Number(computed.opacity || 1);
}
async function begin(text: string) {
  await render(text, { claimInitialSmoothText: () => true });
}
async function enter(surface: HTMLElement) {
  const deadline = now + 80 + (2 * 20) / 0.17045454545454544 + 32;
  while (now < deadline) {
    await frame(now + 16);
    if (opacity(surface) > 0) return now;
  }
  throw new Error("The icon did not enter after its buffer and bounded space pulse");
}

// Mount the real ChatMarkdown and useSmoothText; tests never invoke completion callbacks.
describe("Markdown link icon entry timing", () => {
  it.each([
    ["plain", "[reference](https://timing-plain.com)"],
    ["formatted", "[**reference**](https://timing-rich.com)"],
    ["URL label", "<https://timing-url.com>"],
    ["brand", "[repository](https://github.com/example/repo)"],
    ["pending destination", "[unfinished"],
    ["file", "[source](./src/main.ts)"],
  ])("hides and fades the %s icon with its parent for 500ms", async (_kind, text) => {
    await begin(text);
    const icon = container.querySelector("a svg, button svg")!;
    expect(icon, container.innerHTML).not.toBeNull();
    const surface = surfaceFor(icon);
    expect(getComputedStyle(icon).visibility).toBe("hidden");
    expect(opacity(surface)).toBe(0);
    const enteredAt = await enter(surface);
    const initial = opacity(surface);
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(0.2);
    expect(getComputedStyle(icon).visibility).toBe("visible");
    await frame(enteredAt + 250);
    expect(opacity(surface)).toBeGreaterThan(initial);
    expect(opacity(surface)).toBeLessThan(1);
    await frame(enteredAt + 450);
    expect(opacity(surface)).toBeLessThan(1);
    await frame(enteredAt + 520);
    expect(opacity(surface)).toBe(1);
    expect(surface.hasAttribute("data-smooth-inline-pending")).toBe(false);
  });

  it.each(["load", "error"])(
    "keeps a delayed favicon %s inside its original fade",
    async (event) => {
      await begin(`[reference](https://timing-${event}.com)`);
      const image = container.querySelector("a img")!;
      const surface = surfaceFor(image);
      await act(() => image.dispatchEvent(new Event(event)));
      expect(surfaceFor(container.querySelector("a svg, a img")!)).toBe(surface);
      expect(getComputedStyle(surface).visibility).toBe("hidden");
      expect(opacity(surface)).toBe(0);
      const enteredAt = await enter(surface);
      await frame(enteredAt + 250);
      expect(opacity(surface)).toBeGreaterThan(0);
      expect(opacity(surface)).toBeLessThan(1);
      await frame(enteredAt + 520);
      expect(opacity(surface)).toBe(1);
    },
  );

  it("does not restart or escape a fade when the favicon loads halfway through", async () => {
    await begin("[reference](https://timing-midpoint.com)");
    const image = container.querySelector("a img")!;
    const surface = surfaceFor(image);
    const enteredAt = await enter(surface);
    await frame(enteredAt + 250);
    const midpoint = opacity(surface);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(surfaceFor(image)).toBe(surface);
    expect(opacity(surface)).toBe(midpoint);
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(1);
    await frame(enteredAt + 520);
    expect(opacity(surface)).toBe(1);
  });

  it("retains the entry surface when a pending reference resolves during its fade", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const source = "[reference][ref]\n\n";
    await begin(source);
    const anchor = container.querySelector("a")!;
    const surface = surfaceFor(anchor.querySelector("svg")!);
    const enteredAt = await enter(surface);
    await frame(enteredAt + 250);
    const midpoint = opacity(surface);
    await render(source + "[ref]: https://timing-resolved.com\n");
    await act(() => vi.advanceTimersByTimeAsync(120));
    expect(container.querySelector("a")).toBe(anchor);
    expect(anchor.href).toBe("https://timing-resolved.com/");
    const image = anchor.querySelector("img")!;
    expect(surfaceFor(image)).toBe(surface);
    expect(opacity(surface)).toBe(midpoint);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(opacity(surface)).toBe(midpoint);
    await frame(enteredAt + 520);
    expect(opacity(surface)).toBe(1);
  });

  it("keeps a settled link visible when a favicon finishes much later", async () => {
    await begin("[reference](https://timing-late.com)");
    const image = container.querySelector("a img")!;
    const surface = surfaceFor(image);
    const enteredAt = await enter(surface);
    await frame(enteredAt + 520);
    await frame(5000);
    await act(() => image.dispatchEvent(new Event("load")));
    expect(surface.contains(image)).toBe(true);
    expect(opacity(surface)).toBe(1);
    expect(image.closest("[data-smooth-inline-pending], [data-smooth-surface]")).toBeNull();
  });

  it.each(["reduced motion", "history", "disabled"])(
    "shows icons normally for %s",
    async (kind) => {
      reducedMotion = kind === "reduced motion";
      const props =
        kind === "history"
          ? { isStreaming: false, smoothComplete: true }
          : kind === "disabled"
            ? { smoothStreaming: false }
            : {};
      await render("[reference](https://timing-static.com)", {
        claimInitialSmoothText: () => kind !== "history",
        ...props,
      });
      const icon = container.querySelector("a svg")!;
      expect(icon).not.toBeNull();
      expect(getComputedStyle(icon).visibility).toBe("visible");
      expect(icon.closest("[data-smooth-inline-pending], [data-smooth-surface]")).toBeNull();
      const image = container.querySelector("a img")!;
      await act(() => image.dispatchEvent(new Event("load")));
      expect(getComputedStyle(image).visibility).toBe("visible");
      expect(image.closest("[data-smooth-inline-pending], [data-smooth-surface]")).toBeNull();
    },
  );
});
