import {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";

import { encodeShellSnapshotForCache } from "./persistence.ts";

// Generated values can hold untrimmed strings, which a decoded value never
// has. One encode and decode gives a value a client can hold; values that
// fail are dropped. Size 30 makes the generator fill optional fields.
const sampleDecoded = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);
    const generated = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      count: 1000,
      size: 30,
    });
    const decoded = yield* Effect.forEach(generated, (value) =>
      encode(value).pipe(Effect.flatMap(decode), Effect.option),
    );
    return Arr.getSomes(decoded);
  });
const decodeSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ShellSnapshotJson),
);
const serializeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("encodeShellSnapshotForCache", () => {
  it.effect("encodes V2 dates and preserves snapshots through JSON cache storage", () =>
    Effect.gen(function* () {
      const threads = yield* sampleDecoded(OrchestrationV2ThreadShell);
      const projects = yield* sampleDecoded(OrchestrationProjectShell);
      const snapshot: OrchestrationV2ShellSnapshot = {
        schemaVersion: 1,
        snapshotSequence: 1,
        // The generator rarely makes monogram icons, and they are the one
        // project field whose encoding differs from the decoded value.
        projects: projects.map((project, index) =>
          index % 2 === 0
            ? { ...project, projectIcon: { kind: "monogram", text: "T3", color: "blue" } }
            : project,
        ),
        threads,
        archivedThreads: threads.slice(0, 1),
      };

      expect(threads.length).toBeGreaterThan(0);
      expect(projects.length).toBeGreaterThan(0);
      const encoded = yield* encodeShellSnapshotForCache(snapshot);
      expect(typeof encoded.threads[0]?.createdAt).toBe("string");
      expect(typeof encoded.archivedThreads[0]?.createdAt).toBe("string");
      const serialized = yield* serializeSnapshot(encoded);
      expect(yield* decodeSnapshot(serialized)).toEqual(snapshot);
    }),
  );
});
