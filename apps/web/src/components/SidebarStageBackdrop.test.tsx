import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBe("Alpha");
    expect(resolveEnvironmentIdentificationPillLabel(" experimental ")).toBe("Experimental");
    expect(resolveEnvironmentIdentificationPillLabel("unknown")).toBeNull();
  });

  it.each([
    ["Alpha", "artwork", "Alpha"],
    ["Alpha", "pill", "Alpha"],
    ["Alpha", "none", null],
    ["Experimental", "artwork", "Experimental"],
    ["Experimental", "pill", "Experimental"],
    ["Experimental", "none", null],
    ["Dev", "artwork", null],
    ["Dev", "pill", "Dev"],
    ["Dev", "none", null],
    ["Nightly", "artwork", null],
    ["Nightly", "pill", "Nightly"],
    ["Nightly", "none", null],
    ["Latest", "artwork", null],
    ["Latest", "pill", null],
  ] as const)("resolves %s identification in %s mode", (stage, mode, expected) => {
    expect(resolveEnvironmentIdentificationPillLabel(stage, mode)).toBe(expected);
  });

  it.each(["nightly", "dev"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
