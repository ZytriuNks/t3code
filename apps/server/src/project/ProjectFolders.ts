import {
  CommandId,
  ProjectId,
  type ProjectCreateNewInput,
  type ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import * as NewProject from "./NewProject.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "./ProjectService.ts";

export class ProjectFolderError extends Schema.TaggedError<ProjectFolderError>()(
  "ProjectFolderError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class ProjectFolders extends Context.Service<
  ProjectFolders,
  {
    readonly scratchWorkspaceRoot: Effect.Effect<string | undefined>;
    readonly newProjectsRoot: string;
    readonly ensureScratch: Effect.Effect<{ readonly projectId: ProjectId }, ProjectFolderError>;
    readonly createNamedProject: (input: ProjectCreateNewInput) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly commitError?: string;
      },
      ProjectFolderError
    >;
    readonly prepareThreadFolder: (input: {
      readonly threadId: ThreadId;
      readonly workspaceRoot: string;
      readonly worktreePath: string | null;
      readonly createdAt: string;
      readonly text: string;
    }) => Effect.Effect<string | null, ProjectFolderError>;
  }
>()("t3/project/ProjectFolders") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const git = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const files = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* GitVcsDriver.GitVcsDriver;
  const settings = yield* ServerSettings.ServerSettingsService;
  const newProjectsRoot = path.resolve(config.baseDir, "projects");
  // Scratch must not inherit a surrounding checkout's status or checkpoints.
  const [cachedRoot, invalidateRoot] = yield* Effect.cachedInvalidateWithTTL(
    git.isRepository(config.baseDir).pipe(
      Effect.map((isRepository) =>
        isRepository ? undefined : path.resolve(config.baseDir, "scratch"),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(undefined),
      ),
    ),
    Duration.infinity,
  );
  const scratchWorkspaceRoot = cachedRoot.pipe(Effect.onInterrupt(() => invalidateRoot));
  const failure = (message: string) => (cause: unknown) =>
    new ProjectFolderError({ message, cause });

  const ensureScratch = Effect.gen(function* () {
    const workspaceRoot = yield* scratchWorkspaceRoot;
    if (workspaceRoot === undefined) {
      return yield* new ProjectFolderError({
        message: "Threads without a project are not available on this environment.",
      });
    }
    yield* files
      .makeDirectory(workspaceRoot, { recursive: true })
      .pipe(Effect.mapError(failure("Failed to create the folder for threads without a project.")));
    const find = projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(Effect.mapError(failure("Failed to look up the home for threads without a project.")));
    const existing = yield* find;
    if (Option.isSome(existing)) return { projectId: existing.value.id };
    const projectId = ProjectId.make(yield* randomUuidV4);
    return yield* Effect.gen(function* () {
      yield* projects.create({
        commandId: CommandId.make(`scratch-create:${projectId}`),
        projectId,
        title: "No project",
        workspaceRoot,
      });
      yield* projects.update({
        commandId: CommandId.make(`scratch-icon:${projectId}`),
        projectId,
        projectIcon: { kind: "lucide", name: "message-square-dashed", color: "gray" },
      });
      return { projectId };
    }).pipe(
      Effect.mapError(failure("Failed to create the home for threads without a project.")),
      Effect.catch((error) =>
        find.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(error),
              onSome: (project) => Effect.succeed({ projectId: project.id }),
            }),
          ),
        ),
      ),
    );
  });

  const createNamedProject = Effect.fn("ProjectFolders.createNamedProject")(function* (
    input: ProjectCreateNewInput,
  ) {
    const folder = yield* NewProject.createNewProjectFolder({
      root: newProjectsRoot,
      name: input.name,
    }).pipe(
      Effect.provideService(GitVcsDriver.GitVcsDriver, vcs),
      Effect.provideService(FileSystem.FileSystem, files),
      Effect.provideService(Path.Path, path),
      Effect.mapError(failure("Failed to create the project folder.")),
    );
    const projectId = ProjectId.make(yield* randomUuidV4);
    yield* projects
      .create({
        commandId: CommandId.make(`project-create-new:${projectId}`),
        projectId,
        title: input.name,
        workspaceRoot: folder.workspaceRoot,
      })
      .pipe(
        // Only a rejected command proves that the folder is unused. Preserve it on interruption.
        Effect.tapError(() =>
          files.remove(folder.workspaceRoot, { recursive: true }).pipe(Effect.ignore),
        ),
        Effect.mapError(failure("Failed to register the new project.")),
      );
    return {
      projectId,
      workspaceRoot: folder.workspaceRoot,
      ...(folder.commitError === undefined ? {} : { commitError: folder.commitError }),
    };
  });

  const prepareThreadFolder: ProjectFolders["Service"]["prepareThreadFolder"] = Effect.fn(
    "ProjectFolders.prepareThreadFolder",
  )(function* (input) {
    if (input.worktreePath !== null) return input.worktreePath;
    const scratchRoot = yield* scratchWorkspaceRoot;
    if (
      scratchRoot === undefined ||
      normalizeProjectPathForComparison(input.workspaceRoot) !==
        normalizeProjectPathForComparison(scratchRoot)
    )
      return null;
    // Keep the scratch project's identity stable; only new thread folders follow the setting.
    const { scratchBaseDirectory } = yield* settings.getSettings.pipe(
      Effect.mapError(failure("Failed to read the base directory for threads without a project.")),
    );
    let root = scratchRoot;
    if (scratchBaseDirectory !== "") {
      const expanded = expandHomePathWith(scratchBaseDirectory, path);
      if (!path.isAbsolute(expanded)) {
        return yield* new ProjectFolderError({
          message:
            "The base directory for threads without a project must be an absolute path or start with ~/.",
        });
      }
      root = path.resolve(expanded);
    }
    const words = input.text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .slice(0, 5)
      .join("-")
      .slice(0, 48)
      .replace(/-+$/, "");
    const id = input.threadId.toLowerCase().replace(/[^a-z0-9]/g, "");
    const folderFor = (part: string) =>
      path.join(root, [input.createdAt.slice(0, 10), words, part].filter(Boolean).join("-"));
    yield* files
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError(failure("Failed to create the scratch root.")));
    if (
      scratchBaseDirectory !== "" &&
      (yield* git
        .isRepository(root)
        .pipe(
          Effect.mapError(
            failure("Failed to check the base directory for threads without a project."),
          ),
        ))
    ) {
      return yield* new ProjectFolderError({
        message:
          "The base directory for threads without a project must be outside a Git repository.",
      });
    }
    const claim = (folder: string) =>
      files.makeDirectory(folder).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError(failure("Failed to create the thread's folder.")),
      );
    const shortFolder = folderFor(id.slice(0, 8));
    if (yield* claim(shortFolder)) return shortFolder;
    const fullFolder = folderFor(id);
    yield* claim(fullFolder);
    return fullFolder;
  });

  return ProjectFolders.of({
    scratchWorkspaceRoot,
    newProjectsRoot,
    ensureScratch,
    createNamedProject,
    prepareThreadFolder,
  });
});

export const layer = Layer.effect(ProjectFolders, make);
