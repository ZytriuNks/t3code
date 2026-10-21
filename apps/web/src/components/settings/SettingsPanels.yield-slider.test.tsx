// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { translate } from "../../i18n/messages";
import { SmoothTextYieldDurationSlider } from "./SettingsPanels";

let root: Root;
let container: HTMLDivElement;
let saved: number[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  saved = [];
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  vi.unstubAllGlobals();
});

async function render(value: number | null = 200, locale: "en" | "zh-CN" = "en") {
  await act(() => {
    root.render(
      <SmoothTextYieldDurationSlider
        value={value}
        onCommit={(next) => saved.push(next)}
        ariaLabel={translate(locale, "settings.general.streaming.yield.title")}
        formatValue={(next) =>
          next === null
            ? translate(locale, "settings.general.streaming.mixedValue")
            : translate(locale, "settings.general.streaming.yield.value", { value: next })
        }
      />,
    );
  });
}

function slider() {
  const input = container.querySelector<HTMLInputElement>('input[type="range"]');
  expect(input).not.toBeNull();
  return input!;
}

async function input(value: number) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      slider(),
      value,
    );
    slider().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pointer(type: string) {
  await act(() => {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    slider().dispatchEvent(event);
  });
}

async function key(type: string, key: string) {
  await act(() => slider().dispatchEvent(new KeyboardEvent(type, { bubbles: true, key })));
}

async function blur() {
  await act(() => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}

describe("smooth text yield duration slider", () => {
  it("previews pointer changes and commits once on release", async () => {
    await render();
    expect(slider()).toMatchObject({ min: "100", max: "300", step: "10" });
    await pointer("pointerdown");
    await input(230);
    await input(270);
    expect(container.textContent).toBe("270 ms");
    expect(saved).toEqual([]);
    await pointer("pointerup");
    await blur();
    expect(saved).toEqual([270]);
  });

  it("commits keyboard changes once on key release and avoids a duplicate blur write", async () => {
    await render();
    await key("keydown", "ArrowRight");
    await input(210);
    expect(saved).toEqual([]);
    await key("keyup", "ArrowRight");
    await blur();
    expect(saved).toEqual([210]);
  });

  it("commits a pending change on blur and cancels an active drag without writing", async () => {
    await render();
    await input(230);
    await blur();
    expect(saved).toEqual([230]);
    await pointer("pointerdown");
    await input(280);
    await pointer("pointercancel");
    await blur();
    expect(saved).toEqual([230]);
    expect(slider().value).toBe("230");
  });

  it("clamps committed interaction values to the new bounds", async () => {
    await render();
    await pointer("pointerdown");
    await input(80);
    await pointer("pointerup");
    await pointer("pointerdown");
    await input(1000);
    await pointer("pointerup");
    expect(saved).toEqual([100, 300]);
  });

  it.each([80, 1000])("keeps a legacy %s ms value until an explicit selection", async (value) => {
    await render(value);
    expect(container.textContent).toBe(`${value} ms`);
    const progress = Number.parseFloat(
      slider().style.getPropertyValue("--settings-slider-progress"),
    );
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThanOrEqual(100);
    await blur();
    expect(saved).toEqual([]);
    await pointer("pointerdown");
    await pointer("pointerup");
    expect(saved).toEqual([value === 80 ? 100 : 300]);
  });

  it.each([80, 1000])("accepts a keyboard boundary selection over legacy %s ms", async (value) => {
    await render(value);
    await key("keydown", value === 80 ? "Home" : "End");
    await key("keyup", value === 80 ? "Home" : "End");
    await blur();
    expect(saved).toEqual([value === 80 ? 100 : 300]);
  });

  it.each([
    ["en", "Mixed", "250 ms"],
    ["zh-CN", "不一致", "250 毫秒"],
  ] as const)(
    "shows the %s mixed state while keeping a numeric preview",
    async (locale, mixed, shown) => {
      await render(null, locale);
      expect(container.textContent).toBe(mixed);
      expect(slider().value).toBe("200");
      await pointer("pointerdown");
      await input(250);
      expect(container.textContent).toBe(shown);
      await pointer("pointerup");
      expect(saved).toEqual([250]);
    },
  );
});
