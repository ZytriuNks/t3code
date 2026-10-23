// @vitest-environment jsdom
import { act } from "react";
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
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: () => {} }),
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  useEnvironmentScope: () => false,
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
let page: HTMLDivElement;
let now: number;
let frames: Map<number, FrameRequestCallback>;
const originalBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  now = 0;
  frames = new Map();
  let next = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("Highlight", TestHighlight);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return this.toString().trim() ? new DOMRect(0, 4, 200, 12) : new DOMRect();
    },
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      const rect = this.getBoundingClientRect();
      return rect.height ? [rect] : [];
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const explicit = Number.parseFloat(this.style.height);
    return new DOMRect(
      0,
      0,
      300,
      this.hasAttribute("data-smooth-text-frame") && Number.isFinite(explicit)
        ? explicit
        : this.textContent
          ? 20
          : 0,
    );
  });
  page = document.createElement("div");
  document.body.append(page);
  root = createRoot(page);
});

afterEach(async () => {
  await act(() => root.unmount());
  page.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalBounds)
    Object.defineProperty(Range.prototype, "getBoundingClientRect", originalBounds);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  if (originalRects) Object.defineProperty(Range.prototype, "getClientRects", originalRects);
  else Reflect.deleteProperty(Range.prototype, "getClientRects");
});

describe("ChatMarkdown yield duration", () => {
  it.each([undefined, 80, 1000])(
    "opens real body space with the %s ms duration independently of glyph fade",
    async (duration) => {
      await act(() =>
        root.render(
          <ChatMarkdown
            text="BODY"
            cwd={undefined}
            isStreaming
            smoothStreaming
            smoothTextYieldDurationMs={duration}
            smoothTextFadeDurationMs={500}
            claimInitialSmoothText={() => true}
          />,
        ),
      );
      const frame = page.querySelector<HTMLElement>("[data-smooth-text-frame]")!;
      const samples = new Map<number, number>();
      const milliseconds = duration ?? 200;
      for (now = 0; now <= milliseconds; now++) {
        const callbacks = [...frames.values()];
        frames.clear();
        await act(() => callbacks.forEach((callback) => callback(now)));
        samples.set(now, Number.parseFloat(frame.style.height));
      }
      expect(samples.get(milliseconds / 4)).toBeCloseTo(2.5832386, 5);
      expect(samples.get(milliseconds / 2)).toBeCloseTo(10, 7);
      expect(samples.get(milliseconds)).toBe(20);
      const fading = [...CSS.highlights.entries()].filter(
        ([name]) => name.startsWith("t3-smooth-fade") && CSS.highlights.get(name)!.size > 0,
      );
      expect(fading.length).toBeGreaterThan(0);
    },
  );
});
