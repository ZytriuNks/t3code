import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

it.effect(
  "--fix reclaims space with the service paused and keeps the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const doctor = (dryRun: boolean) =>
        runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        TestConsole.layer,
        Layer.mock(BootService.BootService)({
          withStopped: (operation) =>
            Effect.sync(() => calls.push("pause")).pipe(
              Effect.andThen(operation),
              Effect.ensuring(Effect.sync(() => calls.push("resume"))),
            ),
        }),
        Layer.succeed(DatabaseMaintenance, {
          // An unconverted database: reclaiming space is recommended.
          // A database from before 0.1.0 sits beside it; --fix must keep it.
          inspect: () =>
            Effect.succeed({
              databaseBytes: 2000,
              reclaimableBytes: 1000,
              incrementalVacuumEnabled: false,
              legacyDatabaseBytes: 4000,
            }),
          compact: () =>
            Effect.sync(() => {
              calls.push("compact");
              return {
                beforeBytes: 2000,
                afterBytes: 1000,
                deletedEventCount: 1,
                deletedReceiptCount: 0,
                reclamation: {
                  reclaimedThreadCount: 2,
                  skippedThreads: [
                    {
                      threadId: ThreadId.make("thread:private-path"),
                      blockerCodes: ["shared_native_session"],
                    },
                  ],
                  deletedEventCount: 2,
                  deletedReceiptCount: 1,
                  deletedProjectionRowCount: 4,
                  deletedTurnItemPositionCount: 1,
                  deletedOutboxCount: 2,
                },
              };
            }),
          removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
        }),
      );
      yield* Effect.gen(function* () {
        yield* doctor(true);
        assert.deepEqual(calls, []);
        yield* doctor(false);
        assert.deepEqual(calls, ["pause", "compact", "resume"]);
        const output = yield* TestConsole.logLines;
        const summaryLine =
          "Done: 2 KiB -> 1 KiB, 1 superseded events removed; " +
          "deleted-thread reclamation: 2 threads reclaimed, " +
          "10 dependent rows removed, skipped threads: 1.";
        assert.isTrue(output.includes(summaryLine));
        assert.isFalse(output.some((line) => String(line).includes("thread:private-path")));
      }).pipe(Effect.provide(layer));
    }),
);
