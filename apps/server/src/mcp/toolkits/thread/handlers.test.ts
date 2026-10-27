import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

it.effect.each(["archive", "unarchive"] as const)(
  "organize %s returns the lifecycle receipt and dispatches only the selected root",
  (action) =>
    Effect.gen(function* () {
      const root = ThreadId.make("root");
      const shell = liveThreadShell(root);
      const commands: OrchestrationV2ServerCommand[] = [];
      const lifecycle = {
        commandId: CommandId.make("receipt"),
        rootThreadId: root,
        affectedThreadIds: [root, ThreadId.make("child")],
        cleanup: { pendingCount: 2, failedCount: 1 },
      };
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("test"),
          requestNamespace: "client:test",
          thread: undefined,
          client: { sessionId: "test", label: "Test", access: "full-access" },
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
          getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: 17, storedEvents: [], lifecycle });
          },
        }),
      );
      const toolkit = yield* ThreadToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const results = yield* toolkit
        .handle("t3_thread_organize", { threadId: root, action })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      assert.deepEqual(results.at(-1)?.result, { sequence: 17, lifecycle });
      assert.lengthOf(commands, 1);
      assert.deepInclude(commands[0], { type: `thread.${action}`, threadId: root });
    }),
);
