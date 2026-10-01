import { assert, it } from "@effect/vitest";
import { CodexSettings, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { makeCodexManagedClientV2 } from "./CodexManagedClientV2.ts";

it.effect(
  "rotates the managed process before a turn, rebinds handlers and resumes its native thread",
  () =>
    Effect.gen(function* () {
      let revision = "fixture-first";
      const opened: string[] = [];
      const closed: string[] = [];
      const requests: string[] = [];
      const resumeRequests: unknown[] = [];
      const resumeParams = {
        threadId: "native-thread",
        cwd: "/current-worktree",
        model: "current-model",
        config: {
          mcp_servers: {
            "t3-code": {
              url: "http://127.0.0.1:1234/mcp",
              http_headers: { Authorization: "Bearer fixture-only" },
            },
          },
        },
      };
      const registrations: string[] = [];
      const scope = yield* Scope.make();
      const managed = yield* makeCodexManagedClientV2({
        input: {
          instanceId: ProviderInstanceId.make("managed"),
          providerSessionId: ProviderSessionId.make("session"),
          threadId: ThreadId.make("thread"),
          runtimePolicy: {
            cwd: "/fixture",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          settings: Schema.decodeSync(CodexSettings)({}),
          environment: {},
        },
        resolveRuntime: Effect.sync(() => ({
          config: Schema.decodeSync(CodexSettings)({ binaryPath: "managed-codex" }),
          environment: { ACCESS_TOKEN: revision },
          revision,
        })),
        withAccess: (effect) => effect,
        factory: {
          open: (input) =>
            Effect.gen(function* () {
              const token = input.environment.ACCESS_TOKEN!;
              opened.push(token);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed.push(token);
                }),
              );
              const context = yield* Layer.build(
                Layer.mock(CodexClient.CodexAppServerClient)({
                  request: (method) =>
                    Effect.sync(() => {
                      requests.push(`${token}:${method}`);
                      return {};
                    }),
                  notify: () => Effect.void,
                  raw: {
                    request: (method, payload) =>
                      Effect.sync(() => {
                        requests.push(`${token}:${method}`);
                        if (method === "thread/resume") resumeRequests.push(payload);
                        return {};
                      }),
                  },
                  handleServerNotification: (method) =>
                    Effect.sync(() => {
                      registrations.push(`${token}:${method}`);
                    }),
                }),
              );
              return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(context),
              );
            }),
        },
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* managed.client.handleServerNotification("error", () => Effect.void);
      yield* managed.refresh(resumeParams, true);
      assert.deepEqual(opened, ["fixture-first"]);
      revision = "fixture-second";
      const busy = yield* managed.refresh(resumeParams, false).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(busy));
      assert.deepEqual(closed, []);
      yield* managed.refresh(resumeParams, true);
      assert.deepEqual(resumeRequests, [{ ...resumeParams, excludeTurns: true }]);
      assert.deepEqual(opened, ["fixture-first", "fixture-second"]);
      assert.deepEqual(registrations, ["fixture-first:error", "fixture-second:error"]);
      assert.deepEqual(requests, ["fixture-second:initialize", "fixture-second:thread/resume"]);
      assert.deepEqual(closed, ["fixture-first"]);
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(closed, ["fixture-first", "fixture-second"]);
    }).pipe(Effect.scoped),
);
