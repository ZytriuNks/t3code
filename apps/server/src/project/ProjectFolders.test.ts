import { DEFAULT_SERVER_SETTINGS, ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectFolders from "./ProjectFolders.ts";

const makeHarness = (inRepository: boolean | ((cwd: string) => boolean) = false) => {
  const projects = new Map<string, Project>();
  let creates = 0;
  let iconUpdates = 0;
  let scratchBaseDirectory = "";
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-folders-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(
    config,
    NodeServices.layer,
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.sync(() => ({ ...DEFAULT_SERVER_SETTINGS, scratchBaseDirectory })),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: (cwd) =>
        Effect.succeed(typeof inRepository === "function" ? inRepository(cwd) : inRepository),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      readConfigValue: () => Effect.succeed(null),
      execute: () =>
        Effect.succeed({
          stdout: "",
          stderr: "",
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) => Effect.sync(() => Option.fromUndefinedOr(projects.get(root))),
      create: (input) =>
        Effect.suspend(() => {
          const existing = projects.get(input.workspaceRoot);
          if (existing)
            return Effect.fail(
              new ProjectService.ProjectConflictError({
                projectId: input.projectId,
                workspaceRoot: input.workspaceRoot,
                conflictingProjectId: existing.id,
              }),
            );
          creates += 1;
          const project: Project = {
            id: input.projectId,
            title: input.title,
            workspaceRoot: input.workspaceRoot,
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-10-05T00:00:00.000Z",
            updatedAt: "2026-10-05T00:00:00.000Z",
            deletedAt: null,
          };
          projects.set(project.workspaceRoot, project);
          return Effect.succeed(project);
        }),
      update: (input) =>
        Effect.sync(() => {
          iconUpdates += 1;
          const project = [...projects.values()].find((item) => item.id === input.projectId)!;
          const updated = { ...project, projectIcon: input.projectIcon ?? null };
          projects.set(project.workspaceRoot, updated);
          return updated;
        }),
    }),
  );
  return {
    layer: ProjectFolders.layer.pipe(Layer.provideMerge(dependencies)),
    projects,
    counts: () => ({ creates, iconUpdates }),
    setBaseDirectory: (directory: string) => {
      scratchBaseDirectory = directory;
    },
  };
};

it.effect(
  "reuses the scratch project under concurrent requests and preserves its customized icon",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const folders = yield* ProjectFolders.ProjectFolders;
      const results = yield* Effect.all([folders.ensureScratch, folders.ensureScratch], {
        concurrency: "unbounded",
      });
      assert.equal(results[0].projectId, results[1].projectId);
      yield* folders.ensureScratch;
      assert.deepEqual(harness.counts(), { creates: 1, iconUpdates: 1 });
      const root = yield* folders.scratchWorkspaceRoot;
      const files = yield* FileSystem.FileSystem;
      assert.isTrue(yield* files.exists(root!));
      yield* files.remove(root!, { recursive: true });
      yield* folders.ensureScratch;
      assert.isTrue(yield* files.exists(root!));
      assert.equal(harness.counts().creates, 1);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("hides scratch when the data directory belongs to a checkout", () =>
  Effect.gen(function* () {
    const folders = yield* ProjectFolders.ProjectFolders;
    assert.isUndefined(yield* folders.scratchWorkspaceRoot);
    assert.equal((yield* Effect.flip(folders.ensureScratch))._tag, "ProjectFolderError");
  }).pipe(Effect.provide(makeHarness(true).layer)),
);

it.effect(
  "isolates scratch threads, handles short-id collisions, and retains an existing folder",
  () =>
    Effect.gen(function* () {
      const folders = yield* ProjectFolders.ProjectFolders;
      const path = yield* Path.Path;
      const workspaceRoot = (yield* folders.scratchWorkspaceRoot)!;
      const input = {
        workspaceRoot,
        worktreePath: null,
        createdAt: "2026-10-05T00:00:00.000Z",
        text: "../Review ../../the change",
      };
      const first = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("12345678-aaaa"),
      });
      const second = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("12345678-bbbb"),
      });
      assert.notEqual(first, second);
      assert.equal(path.dirname(first!), workspaceRoot);
      assert.equal(path.dirname(second!), workspaceRoot);
      assert.equal(
        yield* folders.prepareThreadFolder({
          ...input,
          threadId: ThreadId.make("12345678-aaaa"),
          worktreePath: first,
        }),
        first,
      );
      assert.isNull(
        yield* folders.prepareThreadFolder({
          ...input,
          workspaceRoot: path.join(workspaceRoot, "ordinary-project"),
          threadId: ThreadId.make("ordinary"),
        }),
      );
    }).pipe(Effect.provide(makeHarness().layer)),
);

it.effect(
  "uses the configured base for isolated new threads, preserves existing folders, and supports reset",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const folders = yield* ProjectFolders.ProjectFolders;
      const files = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const workspaceRoot = (yield* folders.scratchWorkspaceRoot)!;
      const project = yield* folders.ensureScratch;
      const input = {
        workspaceRoot,
        worktreePath: null,
        createdAt: "2026-10-06T00:00:00.000Z",
        text: "Convert files",
      };
      const original = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("original-thread"),
      });
      const customRoot = path.join(config.baseDir, "custom chats", "对话");
      harness.setBaseDirectory(customRoot);
      assert.deepEqual(yield* folders.ensureScratch, project);
      const first = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("12345678-aaaa"),
      });
      const second = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("12345678-bbbb"),
      });
      assert.equal(path.dirname(first!), customRoot);
      assert.equal(path.dirname(second!), customRoot);
      assert.notEqual(first, second);
      assert.isTrue(yield* files.exists(first!));
      assert.isTrue(yield* files.exists(second!));
      assert.equal(
        yield* folders.prepareThreadFolder({
          ...input,
          threadId: ThreadId.make("original-thread"),
          worktreePath: original,
        }),
        original,
      );
      assert.isNull(
        yield* folders.prepareThreadFolder({
          ...input,
          threadId: ThreadId.make("ordinary"),
          workspaceRoot: path.join(config.baseDir, "ordinary-project"),
        }),
      );
      const nextRoot = path.join(config.baseDir, "next-chats");
      harness.setBaseDirectory(nextRoot);
      const next = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("next-thread"),
      });
      assert.equal(path.dirname(next!), nextRoot);
      harness.setBaseDirectory("");
      const restored = yield* folders.prepareThreadFolder({
        ...input,
        threadId: ThreadId.make("restored-thread"),
      });
      assert.equal(path.dirname(restored!), workspaceRoot);
      assert.equal(
        yield* folders.prepareThreadFolder({
          ...input,
          threadId: ThreadId.make("12345678-aaaa"),
          worktreePath: first,
        }),
        first,
      );
      assert.deepEqual(yield* folders.ensureScratch, project);
      assert.isTrue(yield* files.exists(original!));
      assert.isTrue(yield* files.exists(first!));
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("rejects relative paths and files as the custom base directory", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const folders = yield* ProjectFolders.ProjectFolders;
    const files = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const input = {
      workspaceRoot: (yield* folders.scratchWorkspaceRoot)!,
      worktreePath: null,
      createdAt: "2026-10-06T00:00:00.000Z",
      text: "Test invalid directory",
      threadId: ThreadId.make("invalid-directory"),
    };
    harness.setBaseDirectory("relative/chats");
    assert.include(
      (yield* Effect.flip(folders.prepareThreadFolder(input))).message,
      "absolute path",
    );
    const file = path.join(config.baseDir, "existing-file");
    yield* files.writeFileString(file, "keep this content");
    harness.setBaseDirectory(file);
    assert.equal(
      (yield* Effect.flip(folders.prepareThreadFolder(input)))._tag,
      "ProjectFolderError",
    );
    assert.equal(yield* files.readFileString(file), "keep this content");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("rejects custom roots inside a Git checkout", () => {
  const harness = makeHarness((cwd) => cwd.endsWith("git-checkout"));
  return Effect.gen(function* () {
    const folders = yield* ProjectFolders.ProjectFolders;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    harness.setBaseDirectory(path.join(config.baseDir, "git-checkout"));
    const error = yield* Effect.flip(
      folders.prepareThreadFolder({
        workspaceRoot: (yield* folders.scratchWorkspaceRoot)!,
        worktreePath: null,
        createdAt: "2026-10-06T00:00:00.000Z",
        text: "Keep scratch separate",
        threadId: ThreadId.make("git-checkout-thread"),
      }),
    );
    assert.include(error.message, "outside a Git repository");
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "registers named projects through the project service and gives duplicate names separate folders",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const folders = yield* ProjectFolders.ProjectFolders;
      const files = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* folders.createNamedProject({ name: "My Project" });
      const second = yield* folders.createNamedProject({ name: "My Project" });
      assert.notEqual(first.projectId, second.projectId);
      assert.notEqual(first.workspaceRoot, second.workspaceRoot);
      assert.equal(harness.projects.get(first.workspaceRoot)?.id, first.projectId);
      assert.isTrue(yield* files.exists(path.join(first.workspaceRoot, "README.md")));
      assert.isTrue(yield* files.exists(path.join(first.workspaceRoot, "assets/icon.svg")));
    }).pipe(Effect.provide(harness.layer));
  },
);
