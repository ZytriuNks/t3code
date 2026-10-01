import { ProviderSetupError } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { CodexEffectiveRuntime } from "../../provider/CodexManagedRuntime.ts";
import type { ProviderAuthController } from "../../provider/Services/ProviderAuthService.ts";
import type { CodexAppServerClientFactoryShape } from "./CodexAdapterV2.ts";

export const makeCodexManagedClientV2 = Effect.fn("makeCodexManagedClientV2")(function* (options: {
  readonly factory: CodexAppServerClientFactoryShape;
  readonly input: Parameters<CodexAppServerClientFactoryShape["open"]>[0];
  readonly resolveRuntime: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
  readonly withAccess: NonNullable<ProviderAuthController["withAccess"]>;
}) {
  type Client = CodexClient.CodexAppServerClient["Service"];
  const registrations: Array<(client: Client) => Effect.Effect<void>> = [];
  const parent = yield* Scope.Scope;
  const permit = yield* Semaphore.make(1);
  const open = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Scope.addFinalizer(parent, Scope.close(scope, Exit.void));
    return yield* options
      .withAccess(
        Effect.gen(function* () {
          const effective = yield* options.resolveRuntime;
          const client = yield* options.factory.open({
            ...options.input,
            settings: effective.config,
            environment: effective.environment,
          });
          return { client, scope, revision: effective.revision };
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
  });
  let current = yield* open;
  // 原生处理器绑定到新进程；适配器保留同一个事件队列、turn 状态和子代理投影。
  const register = (bind: (client: Client) => Effect.Effect<void>) =>
    Effect.sync(() => registrations.push(bind)).pipe(Effect.andThen(bind(current.client)));
  const client: Client = {
    ...current.client,
    raw: {
      ...current.client.raw,
      get notifications() {
        return current.client.raw.notifications;
      },
      get requests() {
        return current.client.raw.requests;
      },
      request: (method, payload) =>
        Effect.suspend(() => current.client.raw.request(method, payload)),
      notify: (method, payload) => Effect.suspend(() => current.client.raw.notify(method, payload)),
      respond: (id, value) => Effect.suspend(() => current.client.raw.respond(id, value)),
      respondError: (id, error) => Effect.suspend(() => current.client.raw.respondError(id, error)),
    },
    request: (method, payload) => Effect.suspend(() => current.client.request(method, payload)),
    notify: (method, payload) => Effect.suspend(() => current.client.notify(method, payload)),
    handleServerRequest: (method, handler) =>
      register((next) => next.handleServerRequest(method, handler)),
    handleServerNotification: (method, handler) =>
      register((next) => next.handleServerNotification(method, handler)),
    handleUnknownServerRequest: (handler) =>
      register((next) => next.handleUnknownServerRequest(handler)),
    handleUnknownServerNotification: (handler) =>
      register((next) => next.handleUnknownServerNotification(handler)),
  };
  const refresh = (
    resumeParams: Pick<CodexSchema.V2ThreadResumeParams, "threadId" | "cwd" | "model" | "config">,
    canRestart: boolean,
  ) =>
    permit.withPermit(
      Effect.gen(function* () {
        const effective = yield* options.withAccess(options.resolveRuntime).pipe(Effect.scoped);
        if (effective.revision === current.revision) return;
        if (!canRestart)
          return yield* new ProviderSetupError({
            instanceId: options.input.instanceId,
            operation: "refresh",
            detail:
              "Codex must finish its active and background work before renewing this session. Try again after it finishes.",
          });
        const next = yield* open;
        yield* Effect.gen(function* () {
          yield* next.client.request("initialize", {
            clientInfo: { name: "t3code_desktop", title: "T3 Code Desktop", version: "0.1.0" },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: ["turn/diff/updated"],
            },
          });
          yield* next.client.notify("initialized", undefined);
          for (const bind of registrations) yield* bind(next.client);
          yield* next.client.raw.request("thread/resume", {
            ...resumeParams,
            excludeTurns: true,
          });
        }).pipe(Effect.onError(() => Scope.close(next.scope, Exit.void)));
        const previous = current;
        current = next;
        yield* Scope.close(previous.scope, Exit.void);
      }),
    );
  return { client, refresh };
});
