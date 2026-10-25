import { describe, expect, it } from "vite-plus/test";
import type { BrowserImportSource } from "@t3tools/contracts";

import {
  isRetryableReason,
  formatSkippedDomains,
  initialWizardStep,
  initialTargetSelection,
  refreshedSourceProfileDirectory,
  resolveWizardTarget,
} from "./browserImportWizard.logic";

describe("wizard target selection", () => {
  it("treats an existing profile whose id is new as an existing target", () => {
    const profiles = [{ id: "new", name: "Existing new" }];
    const selection = initialTargetSelection(false, profiles);

    expect(selection).toEqual({ kind: "existing", profileId: "new" });
    expect(resolveWizardTarget(selection, "generated", profiles)).toEqual({
      kind: "existing",
      profileId: "new",
      name: "Existing new",
    });
  });

  it("rejects an existing target that is no longer listed", () => {
    expect(
      resolveWizardTarget({ kind: "existing", profileId: "removed" }, "generated", [
        { id: "default", name: "Default" },
      ]),
    ).toBeUndefined();
  });
});

const source = (over: Partial<BrowserImportSource> = {}): BrowserImportSource => ({
  id: "helium",
  name: "Helium",
  profiles: [{ directory: "Default", name: "You" }],
  ...over,
});

describe("initialWizardStep", () => {
  it("handles source availability before checking its profiles", () => {
    expect(
      initialWizardStep(source({ profiles: [], unavailable: "needsKeychainApproval" })),
    ).toEqual({ step: "blocked", reason: "needsKeychainApproval" });
  });
});

describe("refreshedSourceProfileDirectory", () => {
  const refreshed = source({
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work" },
    ],
  });

  it("preserves a selected non-first profile after the browser quits", () => {
    expect(refreshedSourceProfileDirectory("Profile 2", refreshed)).toBe("Profile 2");
  });

  it("falls back only when the old profile vanished and clears an empty result", () => {
    expect(refreshedSourceProfileDirectory("Removed", refreshed)).toBe("Default");
    expect(refreshedSourceProfileDirectory("Removed", source({ profiles: [] }))).toBe("");
  });
});

describe("isRetryableReason", () => {
  it("offers a retry for failures a second attempt can clear", () => {
    expect(isRetryableReason("needsKeychainApproval")).toBe(true);
    expect(isRetryableReason("keychainUnavailable")).toBe(true);
    expect(isRetryableReason("readFailed")).toBe(true);
  });

  it("does not offer a retry for a permanent failure", () => {
    expect(isRetryableReason("unsupportedPlatform")).toBe(false);
    expect(isRetryableReason("unknownSourceProfile")).toBe(false);
    // Retrying the same new-profile import cannot lower the profile count.
    expect(isRetryableReason("profileLimitReached")).toBe(false);
  });

  it("offers a retry once the user has signed in to create the missing key", () => {
    // The blocked copy tells the user to sign in and retry, so the screen
    // has to offer the retry it asks for.
    expect(isRetryableReason("keychainItemMissing")).toBe(true);
  });

  it("offers a retry when the cookies landed but the new profile was not saved", () => {
    expect(isRetryableReason("profileNotSaved")).toBe(true);
  });
});

describe("formatSkippedDomains", () => {
  it("joins a short list naturally", () => {
    expect(formatSkippedDomains([])).toBe("");
    expect(formatSkippedDomains(["a.com"])).toBe("a.com");
    expect(formatSkippedDomains(["a.com", "b.com"])).toBe("a.com and b.com");
    expect(formatSkippedDomains(["a.com", "b.com", "c.com"])).toBe("a.com, b.com and c.com");
  });

  it("summarizes a long list", () => {
    expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"])).toBe(
      "a.com, b.com, c.com and 2 more",
    );
  });

  it("uses Chinese domain punctuation and count copy", () => {
    expect(formatSkippedDomains(["a.com", "b.com"], "zh-CN")).toBe("a.com、b.com");
    expect(formatSkippedDomains(["a.com", "b.com", "c.com", "d.com", "e.com"], "zh-CN")).toBe(
      "a.com、b.com、c.com及另外 2 个",
    );
  });
});
