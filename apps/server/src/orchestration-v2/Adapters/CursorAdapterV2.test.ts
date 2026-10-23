import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeCursorAdapterV2 } from "../../../../../packages/provider-cursor/src/server/adapter.ts";

it.effect("sends discovered skills as native slash invocations with runtime instructions", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-skills-" });
    const skillDirectory = path.join(workspace, ".cursor", "skills", "review");
    yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: review\n---\nReview the changes.",
    );
    const sentMessages: string[] = [];
    const instanceId = ProviderInstanceId.make("cursor");
    const threadId = ThreadId.make("cursor-skills-thread");
    const modelSelection = { instanceId, model: "composer-2.5" };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: workspace,
    });
    const adapter = yield* makeCursorAdapterV2({
      instanceId,
      settings: yield* Schema.decodeEffect(CursorSettings)({}),
      environment: { HOME: workspace },
    }).pipe(
      Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
        assertComplete: Effect.void,
        open: () =>
          Effect.succeed({
            agentId: "native-cursor-skills",
            listMessages: Effect.succeed([]),
            close: Effect.void,
            send: (input) =>
              Effect.sync(() => {
                sentMessages.push(
                  typeof input.message === "string" ? input.message : input.message.text,
                );
                return {
                  agentId: "native-cursor-skills",
                  runId: "native-cursor-run",
                  wait: Effect.succeed({
                    id: "native-cursor-run",
                    requestId: "native-request",
                    status: "finished" as const,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  }),
                  cancel: Effect.void,
                };
              }),
          }),
      }),
      Effect.provide(TestProviderHost.layer({ cwd: workspace })),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("cursor-skills-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make("cursor-skills-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("cursor-skills-attempt"),
      rootNodeId: NodeId.make("cursor-skills-root"),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("cursor-skills-project"),
        createdBy: "user",
        creationSource: "web",
        title: "Cursor skills",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      message: {
        messageId: MessageId.make("cursor-skills-message"),
        createdBy: "user",
        creationSource: "web",
        text: "$review this with $HOME and $missing",
        attachments: [],
      },
    });
    yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.runHead,
    );
    assert.lengthOf(sentMessages, 1);
    assert.isTrue(sentMessages[0]!.startsWith("/review this with $HOME and $missing\n\n"));
    assert.include(sentMessages[0]!, "Cursor");
    assert.include(sentMessages[0]!, "T3 Code");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  ),
);
