import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

export function getLegacySidebarPinFailureMessage(
  result: AtomCommandResult<unknown, unknown>,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

export type LegacySidebarArchiveResult<TResult extends { readonly _tag: "Success" | "Failure" }> =
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Archived" }
  | {
      readonly _tag: "ArchiveFailure";
      readonly failure: Extract<TResult, { readonly _tag: "Failure" }>;
    }
  | {
      readonly _tag: "FollowupFailure";
      readonly failure: Extract<TResult, { readonly _tag: "Failure" }>;
    };

export async function archiveLegacySidebarContextMenuThread<
  TResult extends { readonly _tag: "Success" | "Failure" },
>(input: {
  readonly confirmationEnabled: boolean;
  readonly confirm: () => Promise<boolean>;
  readonly archive: (onArchived: () => void) => Promise<TResult>;
}): Promise<LegacySidebarArchiveResult<TResult>> {
  if (input.confirmationEnabled && !(await input.confirm())) {
    return { _tag: "Cancelled" };
  }

  let didArchive = false;
  const result = await input.archive(() => {
    didArchive = true;
  });
  if (result._tag === "Success") return { _tag: "Archived" };
  return didArchive
    ? { _tag: "FollowupFailure", failure: result as Extract<TResult, { readonly _tag: "Failure" }> }
    : { _tag: "ArchiveFailure", failure: result as Extract<TResult, { readonly _tag: "Failure" }> };
}
