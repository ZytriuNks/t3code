import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { derive, nativeStorageScope } from "./IdAllocator.ts";

it("lifecycle session incarnations preserve legacy bytes and reuse only the same thread revision", () => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  const input = { providerInstanceId };
  const incarnation = { threadId: ThreadId.make("A"), lifecycleRevision: 2 };
  const session = derive.providerSession({ ...input, incarnation });
  expect(derive.providerSession(input)).toBe("provider-session:provider-instance:codex:shared");
  expect(session).not.toBe(derive.providerSession(input));
  expect(session).toBe(derive.providerSession({ ...input, incarnation: { ...incarnation } }));
  expect(session).not.toBe(
    derive.providerSession({ ...input, incarnation: { ...incarnation, lifecycleRevision: 4 } }),
  );
  expect(session).not.toBe(
    derive.providerSession({
      ...input,
      incarnation: { ...incarnation, threadId: ThreadId.make("B") },
    }),
  );
});

it("lifecycle source tokens isolate owner generations and reuse the same incarnation", () => {
  const input = { providerInstanceId: ProviderInstanceId.make("codex") };
  const incarnation = { threadId: ThreadId.make("C"), sourceToken: "owner-generation-2" };
  const session = derive.providerSession({ ...input, incarnation });
  expect(session).toBe(derive.providerSession({ ...input, incarnation: { ...incarnation } }));
  expect(session).not.toBe(derive.providerSession(input));
  expect(session).not.toBe(
    derive.providerSession({
      ...input,
      incarnation: { ...incarnation, sourceToken: "owner-generation-4" },
    }),
  );
  expect(session).not.toBe(
    derive.providerSession({
      ...input,
      incarnation: { ...incarnation, threadId: ThreadId.make("B") },
    }),
  );
});

it("storage scopes isolate new ids while omitted scopes preserve legacy bytes", () => {
  const input = {
    driver: ProviderDriverKind.make("codex"),
    nativeThreadId: "same-id",
    providerInstanceId: ProviderInstanceId.make("codex"),
  };
  expect(derive.providerThread(input)).toBe(
    "provider-thread:provider:codex:provider-instance:codex:native-thread:same-id",
  );
  expect(derive.threadFromProviderThread(input)).toBe(
    "thread:provider:codex:provider-instance:codex:native-thread:same-id",
  );
  expect(derive.providerThread({ ...input, storageScope: "scope-X" })).not.toBe(
    derive.providerThread({ ...input, storageScope: "scope-Y" }),
  );
  expect(derive.threadFromProviderThread({ ...input, storageScope: "scope-X" })).not.toBe(
    derive.threadFromProviderThread({ ...input, storageScope: "scope-Y" }),
  );
});

it("storage identity hashes canonical evidence without exposing paths", () => {
  const input = {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "same",
    storage: { type: "resolved" as const, canonicalRoot: "/private/store/X" },
  };
  const scope = nativeStorageScope(input);
  expect(scope).toMatch(/^[0-9a-f]{64}$/);
  expect(nativeStorageScope(input)).toBe(scope);
  expect(
    nativeStorageScope({
      ...input,
      storage: { type: "resolved", canonicalRoot: "/private/store/Y" },
    }),
  ).not.toBe(scope);
  expect(
    nativeStorageScope({
      ...input,
      storage: { type: "unresolved", reason: "legacy_missing_locator" },
    }),
  ).toBeUndefined();
  expect(derive.providerThread({ driver: input.driver, nativeThreadId: "native/id" })).toBe(
    "provider-thread:provider:codex:native-thread:native%2Fid",
  );
  expect(
    derive.threadFromProviderThread({ driver: input.driver, nativeThreadId: "native/id" }),
  ).toBe("thread:provider:codex:native-thread:native%2Fid");
});
