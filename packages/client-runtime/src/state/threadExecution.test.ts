import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { deriveActiveNativeProviderTurn } from "./threadExecution.ts";

const projection = (overrides: Record<string, unknown> = {}) =>
  ({
    thread: { activeProviderThreadId: "provider-thread" },
    runs: [],
    messages: [],
    providerTurns: [],
    ...overrides,
  }) as never;

const nativeTurn = (overrides: Record<string, unknown> = {}) => ({
  id: "provider-turn",
  providerThreadId: "provider-thread",
  nodeId: "node",
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
  ...overrides,
});

describe("deriveActiveNativeProviderTurn", () => {
  it("selects the newest pending or running turn for the active provider thread", () => {
    const active = nativeTurn({ id: "newest", ordinal: 2, status: "pending" });
    const result = deriveActiveNativeProviderTurn(
      projection({
        providerTurns: [
          nativeTurn({ id: "old", ordinal: 1, status: "running" }),
          nativeTurn({ id: "other-thread", providerThreadId: "other", ordinal: 3 }),
          active,
        ],
      }),
    );

    expect(result).toBe(active);
  });

  it("ignores a native turn after the current provider thread has a newer terminal turn", () => {
    const result = deriveActiveNativeProviderTurn(
      projection({
        providerTurns: [
          nativeTurn({ id: "running", ordinal: 1 }),
          nativeTurn({
            id: "completed",
            ordinal: 2,
            status: "completed",
            completedAt: "2026-01-01T00:00:01Z",
          }),
        ],
      }),
    );

    expect(result).toBeNull();
  });

  it("does not compete with an application run", () => {
    const result = deriveActiveNativeProviderTurn(
      projection({
        runs: [
          {
            id: "application-run",
            ordinal: 1,
            status: "running",
            requestedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
            startedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
            completedAt: null,
          },
        ],
        providerTurns: [nativeTurn()],
      }),
    );

    expect(result).toBeNull();
  });
});
