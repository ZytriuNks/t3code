import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { translate } from "../../i18n/messages";
import { SmoothTextFadeDurationSlider } from "./SettingsPanels";

async function setup(value: number | null = 200, locale: "en" | "zh-CN" = "en") {
  const saved: number[] = [];
  const ui = (value: number | null = 200, locale: "en" | "zh-CN" = "en") => (
    <SmoothTextFadeDurationSlider
      value={value}
      onCommit={(next) => saved.push(next)}
      ariaLabel={translate(locale, "settings.general.streaming.fade.title")}
      formatValue={(next) =>
        next === null
          ? translate(locale, "settings.general.streaming.mixedValue")
          : next === 0
            ? translate(locale, "settings.general.streaming.fade.off")
            : translate(locale, "settings.general.streaming.fade.value", { value: next })
      }
    />
  );
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(ui(value, locale)));
  const container = screen.container;
  function slider() {
    const input = container.querySelector<HTMLInputElement>("input");
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

  async function pointer(type: string, pointerId = 1) {
    using _capture = vi.spyOn(slider(), "setPointerCapture").mockImplementation(() => {});
    await act(() => {
      const event = new PointerEvent(type, { bubbles: true, button: 0, pointerId });
      slider().dispatchEvent(event);
    });
  }

  async function key(type: string, key: string) {
    await act(() => slider().dispatchEvent(new KeyboardEvent(type, { bubbles: true, key })));
  }

  async function blur() {
    await act(() => slider().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  }

  function expectShown(value: string, label: string) {
    expect(slider().value).toBe(value);
    expect(container.textContent).toBe(label);
  }

  const owned = stack.move();
  return {
    saved,
    container,
    screen,
    slider,
    input,
    pointer,
    key,
    blur,
    expectShown,
    rerender: (value: number | null = 200, locale: "en" | "zh-CN" = "en") =>
      screen.rerender(ui(value, locale)),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe("text fade duration slider interactions", () => {
  it("previews a drag locally and saves once on release without reverting before acknowledgement", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, blur, expectShown } = fixture;
    await pointer("pointerdown");
    await input(350);
    await input(650);
    expectShown("650", "650 ms");
    expect(saved).toEqual([]);

    await pointer("pointerup");
    expect(saved).toEqual([650]);
    expectShown("650", "650 ms");
    await fixture.rerender(200);
    expectShown("650", "650 ms");
    await blur();
    await pointer("pointerup");
    expect(saved).toEqual([650]);
    await fixture.rerender(650);
    expectShown("650", "650 ms");
  });

  it.each([
    ["ArrowLeft", 150],
    ["ArrowRight", 250],
    ["ArrowUp", 250],
    ["ArrowDown", 150],
    ["Home", 0],
    ["End", 1000],
    ["PageUp", 300],
    ["PageDown", 100],
  ] as const)(
    "saves a keyboard adjustment once on %s release and not again on blur",
    async (adjustment, next) => {
      await using fixture = await setup();
      const { saved, input, key, blur, expectShown } = fixture;
      await key("keydown", adjustment);
      await input(next);
      expect(saved).toEqual([]);
      await key("keyup", adjustment);
      expect(saved).toEqual([next]);
      expectShown(String(next), next === 0 ? "Off" : `${next} ms`);
      await blur();
      expect(saved).toEqual([next]);
    },
  );

  it("flushes an unfinished edit on blur only once", async () => {
    await using fixture = await setup();
    const { saved, input, blur, expectShown } = fixture;
    await input(500);
    await blur();
    await blur();
    expect(saved).toEqual([500]);
    expectShown("500", "500 ms");
  });

  it("does not write when an interaction returns to its already saved value", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, blur, expectShown } = fixture;
    await pointer("pointerdown");
    await input(250);
    await input(200);
    await pointer("pointerup");
    await blur();
    expect(saved).toEqual([]);
    expectShown("200", "200 ms");
  });

  it("cancels a drag without persisting it on a later release or blur", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, blur, expectShown } = fixture;
    await pointer("pointerdown");
    await input(800);
    await pointer("pointercancel");
    expectShown("200", "200 ms");
    await pointer("pointerup");
    await blur();
    expect(saved).toEqual([]);
  });

  it("cancels back to the latest saved preview even before the parent acknowledges it", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, blur, expectShown } = fixture;
    await input(400);
    await blur();
    await pointer("pointerdown");
    await input(900);
    await pointer("pointercancel");
    await blur();
    expectShown("400", "400 ms");
    expect(saved).toEqual([400]);
  });

  it("lets an external reset replace a pending saved preview", async () => {
    await using fixture = await setup(400);
    const { saved, input, key, blur, expectShown } = fixture;
    await input(700);
    await blur();
    await fixture.rerender(200);
    expectShown("200", "200 ms");
    await blur();
    expect(saved).toEqual([700]);
    await input(250);
    await key("keyup", "ArrowRight");
    expect(saved).toEqual([700, 250]);
  });

  it("ignores releases and cancellation from a different pointer", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, expectShown } = fixture;
    await pointer("pointerdown", 1);
    await input(450);
    await pointer("pointercancel", 2);
    await pointer("pointerup", 2);
    expectShown("450", "450 ms");
    expect(saved).toEqual([]);
    await pointer("pointerup", 1);
    expect(saved).toEqual([450]);
  });

  it("deduplicates a later interaction with the saved preview while settings are delayed", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, blur, expectShown } = fixture;
    await input(450);
    await blur();
    await pointer("pointerdown");
    await input(500);
    await input(450);
    await pointer("pointerup");
    await blur();
    expectShown("450", "450 ms");
    expect(saved).toEqual([450]);
  });

  it("uses native 50 ms steps and clamps at both ends", async () => {
    await using fixture = await setup(950);
    const { saved, slider, blur, expectShown } = fixture;
    await act(() => {
      slider().stepUp();
      slider().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expectShown("1000", "1000 ms");
    await blur();
    expect(saved).toEqual([1000]);
    await act(() => {
      slider().stepUp();
      slider().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await blur();
    expect(saved).toEqual([1000]);
    await fixture.rerender(50);
    await act(() => {
      slider().stepDown();
      slider().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expectShown("0", "Off");
    await blur();
    expect(saved).toEqual([1000, 0]);
    await act(() => {
      slider().stepDown();
      slider().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await blur();
    expect(saved).toEqual([1000, 0]);
  });

  it("does not let an active draft overwrite an external value update", async () => {
    await using fixture = await setup();
    const { saved, input, pointer, blur, expectShown } = fixture;
    await pointer("pointerdown");
    await input(600);
    await fixture.rerender(350);
    expectShown("350", "350 ms");
    await pointer("pointerup");
    await blur();
    expect(saved).toEqual([]);
  });

  it.each([
    ["en", "Mixed", "Off", "1000 ms"],
    ["zh-CN", "不一致", "关闭", "1000 毫秒"],
  ] as const)(
    "preserves mixed and disabled labels in %s while adjusting the range",
    async (locale, mixed, off, maximum) => {
      await using fixture = await setup(null, locale);
      const { saved, input, pointer, expectShown } = fixture;
      expectShown("200", mixed);
      await pointer("pointerdown");
      await input(0);
      expectShown("0", off);
      await pointer("pointerup");
      expect(saved).toEqual([0]);
      await fixture.rerender(0, locale);
      await pointer("pointerdown");
      await input(1000);
      await pointer("pointerup");
      expectShown("1000", maximum);
      expect(saved).toEqual([0, 1000]);
      await fixture.rerender(null, locale);
      expectShown("200", mixed);
    },
  );
});

it("commits a native keyboard change once", async () => {
  await using fixture = await setup();
  fixture.slider().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(fixture.screen.getByRole("slider")).toHaveValue("250");
  expect(fixture.saved).toEqual([250]);
  fixture.slider().blur();
  expect(fixture.saved).toEqual([250]);
});
