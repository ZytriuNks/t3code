import { describe, expect, it, vi } from "vite-plus/test";

import {
  ensureSmoothTextMotionStyles,
  refreshSmoothTextMotionStyles,
  smoothGlyphOpacity,
  SMOOTH_TEXT_FADE_NAMES,
} from "./smoothLineMotion";

const STYLE_ID = "t3-smooth-text-motion-styles";
function setup() {
  const highlights = CSS.highlights;
  return {
    highlights,
    [Symbol.dispose]() {
      document.getElementById(STYLE_ID)?.remove();
      for (const name of SMOOTH_TEXT_FADE_NAMES) highlights.delete(name);
    },
  };
}

function styles() {
  return document.getElementById(STYLE_ID) as HTMLStyleElement;
}

describe("active smooth motion styles", () => {
  it("keeps idle history free of unused highlight rules", async () => {
    using _fixture = setup();
    ensureSmoothTextMotionStyles(document);
    await Promise.resolve();
    expect(styles().textContent).toBe("");
    expect(styles().sheet?.cssRules.length).toBe(0);
  });

  it("preserves each region's exact alpha while coalescing a frame", async () => {
    using fixture = setup();
    const { highlights } = fixture;
    ensureSmoothTextMotionStyles(document);
    await Promise.resolve();
    using mutation = vi.spyOn(styles(), "textContent", "set");
    highlights.set(SMOOTH_TEXT_FADE_NAMES[7]!, new Highlight());
    refreshSmoothTextMotionStyles(document);
    highlights.set(SMOOTH_TEXT_FADE_NAMES[3]!, new Highlight());
    refreshSmoothTextMotionStyles(document);
    await Promise.resolve();

    expect(mutation).toHaveBeenCalledTimes(1);
    const css = styles().textContent!;
    expect(css).toContain(`::highlight(${SMOOTH_TEXT_FADE_NAMES[7]})`);
    expect(css).toContain(`::highlight(${SMOOTH_TEXT_FADE_NAMES[3]})`);
    expect(css).toContain(
      `color:color-mix(in srgb, var(--t3-smooth-foreground, currentColor) ${smoothGlyphOpacity(7) * 100}%`,
    );
    expect(css).toContain(
      `color:color-mix(in srgb, var(--t3-smooth-foreground, currentColor) ${smoothGlyphOpacity(3) * 100}%`,
    );
    // A glyph displacement used to be a text-shadow over the whole run, which
    // repainted every glyph around it. Only alpha is left per region.
    expect(css).not.toContain("text-shadow");
    expect((css.match(/::highlight\(/g) ?? []).length).toBe(SMOOTH_TEXT_FADE_NAMES.length);

    refreshSmoothTextMotionStyles(document);
    await Promise.resolve();
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("moves between alpha buckets without rewriting CSS and removes the last palette", async () => {
    using fixture = setup();
    const { highlights } = fixture;
    ensureSmoothTextMotionStyles(document);
    highlights.set(SMOOTH_TEXT_FADE_NAMES[1]!, new Highlight());
    highlights.set(SMOOTH_TEXT_FADE_NAMES[2]!, new Highlight());
    await Promise.resolve();
    using mutation = vi.spyOn(styles(), "textContent", "set");
    highlights.delete(SMOOTH_TEXT_FADE_NAMES[1]!);
    refreshSmoothTextMotionStyles(document);
    await Promise.resolve();
    expect(mutation).not.toHaveBeenCalled();
    expect(styles().textContent).toContain(`::highlight(${SMOOTH_TEXT_FADE_NAMES[2]})`);

    highlights.delete(SMOOTH_TEXT_FADE_NAMES[2]!);
    refreshSmoothTextMotionStyles(document);
    await Promise.resolve();
    expect(styles().textContent).toBe("");
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("recreates a removed stylesheet using the current shared registry", async () => {
    using fixture = setup();
    const { highlights } = fixture;
    ensureSmoothTextMotionStyles(document);
    await Promise.resolve();
    const previous = styles();
    previous.remove();
    highlights.set(SMOOTH_TEXT_FADE_NAMES[5]!, new Highlight());
    ensureSmoothTextMotionStyles(document);
    await Promise.resolve();
    expect(styles()).not.toBe(previous);
    expect(styles().textContent).toContain(`::highlight(${SMOOTH_TEXT_FADE_NAMES[5]})`);
    expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
  });
});
