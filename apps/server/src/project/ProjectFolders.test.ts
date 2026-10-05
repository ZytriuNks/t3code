import { ProjectId, ThreadId, type Project } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectFolders from "./ProjectFolders.ts";

const makeHarness = (inRepository = false) => {
  const projects = new Map<string, Project>();
  let creates = 0;
  let iconUpdates = 0;
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-folders-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(
    config,
    NodeServices.layer,
    Layer.mock(GitWorkflow.GitWorkflowService)({
      isRepository: () => Effect.succeed(inRepository),
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
