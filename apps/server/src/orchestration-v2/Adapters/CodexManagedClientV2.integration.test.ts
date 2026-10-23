import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ServerConfig } from "../../config.ts";
import {
  CODEX_DRIVER_KIND,
  makeCodexAdapterV2,
  type CodexAppServerClientFactoryShape,
} from "./CodexAdapterV2.ts";

it.effect(
  "the production Codex adapter refreshes changed managed credentials before a turn and refuses rotation while busy",
  () =>
    Effect.gen(function* () {
      let revision = "first";
      const opened: string[] = [];
      const closed: string[] = [];
      const calls: string[] = [];
      const bindings: string[] = [];
      const resumes: unknown[] = [];
      const initializations: unknown[] = [];
      const settings = yield* Schema.decodeEffect(CodexSettings)({});
      const factory: CodexAppServerClientFactoryShape = {
        open: (input) =>
          Effect.gen(function* () {
            const credential = input.environment.FIXTURE_REVISION!;
            opened.push(credential);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed.push(credential);
              }),
            );
            const context = yield* Layer.build(
              Layer.mock(CodexClient.CodexAppServerClient)({
                request: (method, payload) =>
                  Effect.sync(() => {
                    calls.push(`${credential}:${method}`);
                    if (method === "initialize") initializations.push(payload);
                    return { turn: { id: "native-turn", startedAt: 1 } } as never;
                  }),
                notify: () => Effect.void,
                raw: {
                  notifications: Stream.empty,
                  requests: Stream.empty,
                  request: (method, payload) =>
                    Effect.sync(() => {
                      calls.push(`${credential}:${method}`);
                      if (method === "thread/resume") resumes.push(payload);
                      return {};
                    }),
                  notify: () => Effect.void,
                  respond: () => Effect.void,
                  respondError: () => Effect.void,
                },
                handleServerRequest: (method) =>
                  Effect.sync(() => {
                    bindings.push(`${credential}:${method}`);
                  }),
                handleServerNotification: (method) =>
                  Effect.sync(() => {
                    bindings.push(`${credential}:${method}`);
                  }),
                handleUnknownServerRequest: () => Effect.void,
                handleUnknownServerNotification: () => Effect.void,
              }),
            );
            return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
          }),
      };
      const instanceId = ProviderInstanceId.make("managed");
      const threadId = ThreadId.make("thread-managed-integration");
      const providerSessionId = ProviderSessionId.make("session-managed-integration");
      const modelSelection = { instanceId, model: "gpt-test" };
      const runtimePolicy = {
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };
      const adapter = yield* makeCodexAdapterV2({
        instanceId,
        settings,
        environment: {},
        clientFactory: factory,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig,
        resolveRuntime: Effect.sync(() => ({
          config: settings,
          environment: { FIXTURE_REVISION: revision },
          revision,
        })),
        withRuntimeAccess: (effect) => effect,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("provider-thread-managed-integration"),
        driver: CODEX_DRIVER_KIND,
        providerInstanceId: instanceId,
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CODEX_DRIVER_KIND,
          nativeId: "native-managed-thread",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const turn: ProviderAdapter.ProviderAdapterV2TurnInput = {
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("run-managed-integration"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-managed-integration"),
        rootNodeId: NodeId.make("node-managed-integration"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("project-managed-integration"),
          createdBy: "user",
          creationSource: "web",
          title: "Managed credentials",
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
          messageId: MessageId.make("message-managed-integration"),
          createdBy: "user",
          creationSource: "web",
          text: "hello",
          attachments: [],
        },
      };
      revision = "second";
      yield* runtime.startTurn(turn);
      assert.deepEqual(opened, ["first", "second"]);
      assert.deepEqual(closed, ["first"]);
      assert.deepEqual(calls, ["second:initialize", "second:thread/resume", "second:turn/start"]);
      assert.isNotEmpty(
        (initializations[0] as { capabilities: { extensions: object } }).capabilities.extensions,
      );
      assert.equal((resumes[0] as { threadId: string }).threadId, "native-managed-thread");
      assert.isTrue((resumes[0] as { excludeTurns: boolean }).excludeTurns);
      assert.sameMembers(
        bindings
          .filter((binding) => binding.startsWith("first:"))
          .map((binding) => binding.slice(6)),
        bindings
          .filter((binding) => binding.startsWith("second:"))
          .map((binding) => binding.slice(7)),
      );
      revision = "third";
      const error = yield* runtime.startTurn(turn).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterTurnStartError");
      assert.deepEqual(opened, ["first", "second"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          IdAllocator.layer,
          McpProviderSessions.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "codex-managed-integration-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
);
