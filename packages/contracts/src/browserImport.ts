import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

const BROWSER_IMPORT_SOURCE_IDS = [
  "chrome",
  "edge",
  "brave",
  "vivaldi",
  "opera",
  "arc",
  "helium",
  "firefox",
  "safari",
] as const;

export const BrowserImportSourceId = Schema.Literals(BROWSER_IMPORT_SOURCE_IDS);
export type BrowserImportSourceId = typeof BrowserImportSourceId.Type;

export const BrowserImportUnavailableReason = Schema.Literals([
  "notInstalled",
  "needsKeychainApproval",
  "keychainItemMissing",
  "needsFullDiskAccess",
  "browserRunning",
  "unsupportedPlatform",
]);
export type BrowserImportUnavailableReason = typeof BrowserImportUnavailableReason.Type;

export const BrowserImportFailureReason = Schema.Literals([
  ...BrowserImportUnavailableReason.literals,
  "keychainUnavailable",
  "unknownSource",
  "unknownSourceProfile",
  "sessionUnavailable",
  "profileNotSaved",
  "profileLimitReached",
  "readFailed",
]);
export type BrowserImportFailureReason = typeof BrowserImportFailureReason.Type;

export const BrowserImportSourceProfile = Schema.Struct({
  directory: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  cookieCount: Schema.optional(Schema.Int),
});
export type BrowserImportSourceProfile = typeof BrowserImportSourceProfile.Type;

export const BrowserImportSource = Schema.Struct({
  id: BrowserImportSourceId,
  name: TrimmedNonEmptyString,
  profiles: Schema.Array(BrowserImportSourceProfile),
  unavailable: Schema.optional(BrowserImportUnavailableReason),
});
export type BrowserImportSource = typeof BrowserImportSource.Type;

export const BrowserImportInput = Schema.Struct({
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
});
export type BrowserImportInput = typeof BrowserImportInput.Type;

export const DesktopPreviewImportCookiesInputSchema = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  sourceId: BrowserImportSourceId,
  sourceProfileDirectory: TrimmedNonEmptyString,
  targetProfileId: BrowserProfileId,
});

export const BrowserImportResult = Schema.Struct({
  imported: Schema.Int,
  skipped: Schema.Int,
  skippedDomains: Schema.Array(Schema.String),
});
export type BrowserImportResult = typeof BrowserImportResult.Type;
