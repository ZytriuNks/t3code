import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { acpReadTextFile, acpWriteTextFile, makeAcpClientFileSystem } from "./clientFs.ts";
import { makeAcpClientPolicyGrants, type AcpClientPolicyContext } from "./clientPolicy.ts";

const withTempDir = <A, E>(
  use: (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly directory: string;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-client-fs-" });
    return yield* use({ fileSystem, path, directory });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("AcpClientFs policy boundary", () => {
  it.effect("denies unapproved reads and writes without touching disk", () =>
    withTempDir(({ path, directory }) =>
      Effect.gen(function* () {
        const client = makeAcpClientFileSystem(
          FileSystem.makeNoop({
            readFileString: () => Effect.die("unapproved read reached disk"),
            makeDirectory: () => Effect.die("unapproved write reached disk"),
          }),
        );
        const context: AcpClientPolicyContext = {
          policy: { runtimeMode: "approval-required", cwd: directory },
          turnKey: "turn-1",
          grants: makeAcpClientPolicyGrants(),
        };
        const request = {
          sessionId: "session",
          path: path.join(directory, "file.txt"),
          content: "blocked",
        };
        expect(
          (yield* Effect.flip(client.readTextFile(request, directory, context))).message,
        ).toContain("requires approval");
        expect(
          (yield* Effect.flip(client.writeTextFile(request, directory, context))).message,
        ).toContain("requires approval");
      }),
    ),
  );

  it.effect.each(["turn", "session"] as const)(
    "honors %s approvals only for the approved operation, path and lifetime",
    (scope) =>
      withTempDir(({ fileSystem, path, directory }) =>
        Effect.gen(function* () {
          const filePath = path.join(directory, "approved.txt");
          yield* fileSystem.writeFileString(filePath, "original");
          const client = makeAcpClientFileSystem(fileSystem);
          const grants = makeAcpClientPolicyGrants();
          const policy = { runtimeMode: "approval-required" as const, cwd: directory };
          const context = { policy, turnKey: "turn-1", grants };
          const request = { sessionId: "session", path: filePath, content: "approved" };
          grants.recordApproval({
            kind: "file-read",
            scope,
            turnKey: "turn-1",
            locations: [filePath],
            cwd: directory,
          });
          expect((yield* client.readTextFile(request, directory, context)).content).toBe(
            "original",
          );
          expect(
            (yield* Effect.flip(client.writeTextFile(request, directory, context))).message,
          ).toContain("requires approval");
          grants.recordApproval({
            kind: "file-change",
            scope,
            turnKey: "turn-1",
            locations: [filePath],
            cwd: directory,
          });
          yield* client.writeTextFile(request, directory, context);
          expect(yield* fileSystem.readFileString(filePath)).toBe("approved");
          expect(
            (yield* Effect.flip(
              client.writeTextFile(
                { ...request, path: path.join(directory, "other.txt") },
                directory,
                context,
              ),
            )).message,
          ).toContain("requires approval");
          const next = { ...context, turnKey: "turn-2" };
          if (scope === "turn") {
            expect(
              (yield* Effect.flip(client.writeTextFile(request, directory, next))).message,
            ).toContain("requires approval");
            expect(
              (yield* Effect.flip(client.readTextFile(request, directory, next))).message,
            ).toContain("requires approval");
          } else {
            yield* client.writeTextFile(request, directory, next);
            expect((yield* client.readTextFile(request, directory, next)).content).toBe("approved");
          }
          const readonly = {
            ...context,
            policy: { ...policy, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
          };
          expect(
            (yield* Effect.flip(client.writeTextFile(request, directory, readonly))).message,
          ).toContain("does not allow");
        }),
      ),
  );

  it.effect(
    "enforces workspace-write policy for new files inside and outside the current workspace",
    () =>
      withTempDir(({ fileSystem, path, directory }) =>
        Effect.gen(function* () {
          const workspace = path.join(directory, "workspace");
          yield* fileSystem.makeDirectory(workspace);
          const client = makeAcpClientFileSystem(fileSystem);
          const context = {
            policy: {
              runtimeMode: "full-access" as const,
              cwd: workspace,
              approvalPolicy: "never",
              sandboxPolicy: { type: "workspaceWrite" },
            },
            turnKey: "turn",
            grants: makeAcpClientPolicyGrants(),
          };
          const request = {
            sessionId: "session",
            path: path.join(workspace, "new", "file.txt"),
            content: "inside",
          };
          yield* client.writeTextFile(request, workspace, context);
          expect(yield* fileSystem.readFileString(request.path)).toBe("inside");
          const outside = path.join(directory, "outside.txt");
          expect(
            (yield* Effect.flip(
              client.writeTextFile({ ...request, path: outside }, workspace, context),
            )).message,
          ).toContain("does not allow");
          expect(yield* fileSystem.exists(outside)).toBe(false);
        }),
      ),
  );
});

describe("AcpClientFs", () => {
  it.effect("reads whole files and 1-based line windows", () =>
    withTempDir(({ fileSystem, path, directory }) =>
      Effect.gen(function* () {
        const filePath = path.join(directory, "notes.txt");
        yield* fileSystem.writeFileString(filePath, "one\ntwo\nthree\nfour");

        const whole = yield* acpReadTextFile(fileSystem, {
          sessionId: "session",
          path: filePath,
        });
        expect(whole.content).toBe("one\ntwo\nthree\nfour");

        const windowed = yield* acpReadTextFile(fileSystem, {
          sessionId: "session",
          path: filePath,
          line: 2,
          limit: 2,
        });
        expect(windowed.content).toBe("two\nthree");
      }),
    ),
  );

  it.effect("rejects relative paths and missing files with typed request errors", () =>
    withTempDir(({ fileSystem, path, directory }) =>
      Effect.gen(function* () {
        const relative = yield* Effect.flip(
          acpReadTextFile(fileSystem, { sessionId: "session", path: "notes.txt" }),
        );
        expect(relative.message).toContain("absolute path");

        const missing = yield* Effect.flip(
          acpReadTextFile(fileSystem, {
            sessionId: "session",
            path: path.join(directory, "missing.txt"),
          }),
        );
        expect(missing.message).toContain("Could not read text file");
      }),
    ),
  );

  it.effect("writes files, creating parent directories", () =>
    withTempDir(({ fileSystem, path, directory }) =>
      Effect.gen(function* () {
        const filePath = path.join(directory, "nested", "deep", "config.json");
        yield* acpWriteTextFile(fileSystem, {
          sessionId: "session",
          path: filePath,
          content: '{"ok":true}',
        });
        expect(yield* fileSystem.readFileString(filePath)).toBe('{"ok":true}');
      }),
    ),
  );
});
