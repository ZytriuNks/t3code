import { describe, expect, it } from "vite-plus/test";

import { resolveThreadPanelPresentation } from "./rightPanelLayout";

describe("resolveThreadPanelPresentation", () => {
  it("keeps details behind the toolbar button when automatic expansion is disabled", () => {
    expect(resolveThreadPanelPresentation(null, 0, false, false)).toBe("popover");
    expect(resolveThreadPanelPresentation(2_000, 0, false, false)).toBe("popover");
    expect(resolveThreadPanelPresentation(1_400, 540, false, false)).toBe("popover");
    expect(resolveThreadPanelPresentation(2_000, 0, false, true)).toBe("inline");
  });

  it("uses the stable workspace width minus the real right panel width", () => {
    expect(resolveThreadPanelPresentation(null, 0, false)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_104, 0, false)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_103, 0, false)).toBe("popover");

    expect(resolveThreadPanelPresentation(1_400, 0, false)).toBe("inline");
    expect(resolveThreadPanelPresentation(1_400, 540, false)).toBe("popover");
    expect(resolveThreadPanelPresentation(1_644, 540, false)).toBe("inline");
  });

  it("uses a popover while the real right panel is maximized", () => {
    expect(resolveThreadPanelPresentation(2_000, 0, true)).toBe("popover");
  });
});
