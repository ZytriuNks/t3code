import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2ThreadHistoryPage,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import {
  ThreadHistoryController,
  threadHistoryControllerLayer,
} from "./threadHistoryController.ts";
import {
  makeEnvironmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const RECENT_RUN: OrchestrationV2Run = {
  id: RunId.make("run-recent"),
  threadId: THREAD_ID,
  ordinal: 2,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-recent"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: v2Now,
  checkpointId: null,
  contextHandoffId: null,
};

function row(index: number, runId: RunId | null = null) {
  const item = {
    id: TurnItemId.make(`item-${index}`),
    type: "command_execution",
    threadId: THREAD_ID,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed",
    title: `Command ${index}`,
    input: `cmd-${index}`,
    output: `out-${index}`,
    exitCode: 0,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  } satisfies OrchestrationV2TurnItem;
  return {
    position: index,
    visibility: "local" as const,
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  };
}

const OLDER_ROW = row(0);
const RECENT_ROW = row(1, RECENT_RUN.id);
const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runs: [RECENT_RUN],
  turnItems: [RECENT_ROW.item],
  visibleTurnItems: [{ ...RECENT_ROW, position: 0 }],
};
const HISTORY = {
  historyCursor: "cursor-1",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: RECENT_ROW.item.ordinal,
};
const WINDOWED_SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = {
  snapshotSequence: 10,
  projection: BASE_PROJECTION,
  ...HISTORY,
};
const OLDER_PAGE: OrchestrationV2ThreadHistoryPage = {
  snapshotSequence: 10,
  items: [OLDER_ROW],
  nextCursor: null,
  hasMoreHistory: false,
};
const encodePage = Schema.encodeSync(OrchestrationV2ThreadHistoryPage);
const pageResponse = (page: OrchestrationV2ThreadHistoryPage = OLDER_PAGE) =>
  Response.json(encodePage(page));

type SubscribeInput = Parameters<
  WsRpcProtocolClient[typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread]
>[0];

const makeHarness = Effect.fn("TestThreadPagination.makeHarness")(function* (options?: {
  readonly initialResponse?: ThreadSnapshotLoadResult;
  readonly cached?: OrchestrationV2ThreadDetailSnapshot;
  readonly historyPaging?: "no-http" | "no-controller";
}) {
  const inputs = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const subscriptions = yield* Queue.unbounded<SubscribeInput>();
  const loaderCalls = yield* Ref.make(0);
  const historyCursors = yield* Ref.make<ReadonlyArray<string | null>>([]);
  const pendingPages = yield* Queue.unbounded<Deferred.Deferred<Response>>();
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: SubscribeInput) =>
      Stream.unwrap(Queue.offer(subscriptions, input).pipe(Effect.as(Stream.fromQueue(inputs)))),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({} as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisorSession = yield* SubscriptionRef.make(Option.some(session));
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: () =>
      Ref.update(loaderCalls, (count) => count + 1).pipe(
        Effect.as(
          options?.initialResponse ??
            ({
              _tag: "present",
              snapshot: WINDOWED_SNAPSHOT,
              history: HISTORY,
            } satisfies ThreadSnapshotLoadResult),
        ),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.fromUndefinedOr(options?.cached)),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const historyController = yield* ThreadHistoryController.pipe(
    Effect.provide(threadHistoryControllerLayer),
  );
  let makeState = makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
  );
  if (options?.historyPaging !== "no-controller") {
    makeState = makeState.pipe(Effect.provideService(ThreadHistoryController, historyController));
  }
  if (options?.historyPaging !== "no-http") {
    makeState = makeState.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request, url) =>
          Effect.gen(function* () {
            const response = yield* Deferred.make<Response>();
            yield* Ref.update(historyCursors, (current) => [
              ...current,
              url.searchParams.get("cursor"),
            ]);
            yield* Queue.offer(pendingPages, response);
            return HttpClientResponse.fromWeb(request, yield* Deferred.await(response));
          }),
        ),
      ),
    );
  }
  const threadState = yield* makeState;
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) => Queue.offer(observed, state)),
    Effect.forkScoped,
  );
  const subscribeInput = yield* Queue.take(subscriptions);
  return {
    inputs,
    threadState,
    subscribeInput,
    loaderCalls,
    historyCursors,
    nextPage: Queue.take(pendingPages),
    loadEarlier: () => historyController.loadEarlier(TARGET.environmentId, THREAD_ID),
    awaitState: (predicate: (state: EnvironmentThreadState) => boolean) =>
      Queue.take(observed).pipe(Effect.repeat({ until: predicate })),
  };
});

const visibleIds = (state: EnvironmentThreadState) =>
  Option.getOrThrow(state.data).visibleTurnItems.map((entry) => entry.sourceItemId);

const titleEvent = (title: string, sequence: number): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-title-${sequence}`),
    type: "thread.metadata-updated",
    threadId: THREAD_ID,
    occurredAt: v2Now,
    payload: { ...v2Projection.thread, title },
  },
});

const itemEvent = (
  item: OrchestrationV2TurnItem,
  sequence: number,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-item-${sequence}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: v2Now,
    payload: item,
  },
});

const rollbackEvent = (sequence: number): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-rollback-${sequence}`),
    type: "run.updated",
    threadId: THREAD_ID,
    runId: RECENT_RUN.id,
    occurredAt: v2Now,
    payload: { ...RECENT_RUN, status: "rolled_back" },
  },
});

const replacementSnapshot = (bounded: boolean): OrchestrationV2ThreadStreamItem => ({
  kind: "snapshot",
  snapshotSequence: 20,
  projection: {
    ...BASE_PROJECTION,
    thread: { ...BASE_PROJECTION.thread, title: "Replacement snapshot" },
  },
  ...(bounded ? { ...HISTORY, historyCursor: "cursor-2" } : {}),
});

describe("thread pagination state", () => {
  it.effect("keeps reasoning rows across initial, older and live V2 reads", () =>
    Effect.gen(function* () {
      const reasoning: OrchestrationV2TurnItem = {
        ...OLDER_ROW.item,
        type: "reasoning",
        text: "Earlier reasoning",
        streaming: false,
      };
      const recentReasoning: OrchestrationV2TurnItem = {
        ...RECENT_ROW.item,
        type: "reasoning",
        text: "Recent reasoning",
        streaming: false,
      };
      const projection = {
        ...BASE_PROJECTION,
        turnItems: [recentReasoning],
        visibleTurnItems: [{ ...RECENT_ROW, item: recentReasoning, position: 0 }],
      };
      const harness = yield* makeHarness({
        initialResponse: {
          _tag: "present",
          snapshot: { snapshotSequence: 10, projection },
          history: HISTORY,
        },
      });
      expect(
        Option.getOrThrow((yield* SubscriptionRef.get(harness.threadState)).data).turnItems,
      ).toEqual([recentReasoning]);
      const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
      yield* Deferred.succeed(
        yield* harness.nextPage,
        pageResponse({ ...OLDER_PAGE, items: [{ ...OLDER_ROW, item: reasoning }] }),
      );
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      const continued = { ...reasoning, text: "Earlier reasoning continued" };
      yield* Queue.offer(harness.inputs, itemEvent(continued, 11));
      const state = yield* harness.awaitState((value) =>
        Option.exists(value.data, (projection) =>
          projection.turnItems.some((item) => item === continued),
        ),
      );
      expect(Option.getOrThrow(state.data).visibleTurnItems.map((entry) => entry.item)).toEqual([
        continued,
        recentReasoning,
      ]);
    }),
  );

  it.effect("installs the initial history window and negotiates bounded socket fallback", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const state = yield* SubscriptionRef.get(harness.threadState);
      expect(state.history).toEqual({
        ...HISTORY,
        loading: false,
        error: null,
        expanded: false,
      });
      expect(harness.subscribeInput.afterSequence).toBe(10);
      expect(harness.subscribeInput.acceptBoundedSnapshot).toBe(true);
    }),
  );

  for (const historyPaging of ["no-http", "no-controller"] as const) {
    it.effect(`does not negotiate bounded snapshots with ${historyPaging}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          historyPaging,
          initialResponse: {
            _tag: "present",
            snapshot: { snapshotSequence: 10, projection: BASE_PROJECTION },
          },
        });
        expect(harness.subscribeInput.acceptBoundedSnapshot).toBeUndefined();
        expect(yield* harness.loadEarlier()).toEqual({ _tag: "noop" });
        expect(yield* Ref.get(harness.historyCursors)).toEqual([]);
      }),
    );
  }

  it.effect("merges older rows in order, dedupes overlap and clears the cursor", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
      const pending = yield* harness.nextPage;
      expect((yield* SubscriptionRef.get(harness.threadState)).history.loading).toBe(true);
      expect(yield* harness.loadEarlier()).toEqual({ _tag: "busy" });
      yield* Deferred.succeed(
        pending,
        pageResponse({ ...OLDER_PAGE, items: [OLDER_ROW, RECENT_ROW] }),
      );
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      const state = yield* SubscriptionRef.get(harness.threadState);
      expect(visibleIds(state)).toEqual([OLDER_ROW.sourceItemId, RECENT_ROW.sourceItemId]);
      expect(state.history).toEqual({
        historyCursor: null,
        hasMoreHistory: false,
        loading: false,
        error: null,
        expanded: true,
        latestLocalTurnOrdinal: RECENT_ROW.item.ordinal,
      });
      expect(yield* harness.loadEarlier()).toEqual({ _tag: "noop" });
      expect(yield* Ref.get(harness.historyCursors)).toEqual(["cursor-1"]);
    }),
  );

  it.effect("does not resurrect rows rolled back while an older page is in flight", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
      const pending = yield* harness.nextPage;
      yield* Queue.offer(harness.inputs, rollbackEvent(11));
      yield* harness.awaitState((state) =>
        Option.exists(state.data, (projection) => projection.runs[0]?.status === "rolled_back"),
      );
      yield* Deferred.succeed(
        pending,
        pageResponse({ ...OLDER_PAGE, items: [OLDER_ROW, RECENT_ROW] }),
      );
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      const state = yield* SubscriptionRef.get(harness.threadState);
      expect(visibleIds(state)).toEqual([OLDER_ROW.sourceItemId]);
      expect(Option.getOrThrow(state.data).runs[0]?.status).toBe("rolled_back");
    }),
  );

  for (const bounded of [false, true]) {
    it.effect(`discards an in-flight page after a replacement snapshot (bounded: ${bounded})`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
        const pending = yield* harness.nextPage;
        yield* Queue.offer(harness.inputs, replacementSnapshot(bounded));
        const replacement = yield* harness.awaitState((state) =>
          Option.exists(
            state.data,
            (projection) => projection.thread.title === "Replacement snapshot",
          ),
        );
        yield* Deferred.succeed(pending, pageResponse());
        expect(yield* Fiber.join(loading)).toEqual({ _tag: "noop" });
        const state = yield* SubscriptionRef.get(harness.threadState);
        expect(visibleIds(state)).toEqual([RECENT_ROW.sourceItemId]);
        expect(state.history).toEqual(replacement.history);
        expect(state.history.historyCursor).toBe(bounded ? "cursor-2" : null);
      }),
    );
  }

  for (const failed of [false, true]) {
    it.effect(
      `keeps a replacement request loading when the stale request finishes (failed: ${failed})`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const oldLoading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
          const oldPending = yield* harness.nextPage;
          yield* Queue.offer(harness.inputs, replacementSnapshot(true));
          yield* harness.awaitState((state) => state.history.historyCursor === "cursor-2");
          const newLoading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
          const newPending = yield* harness.nextPage;
          yield* Deferred.succeed(
            oldPending,
            failed ? new Response(null, { status: 503 }) : pageResponse(),
          );
          expect(yield* Fiber.join(oldLoading)).toEqual({ _tag: "noop" });
          const state = yield* SubscriptionRef.get(harness.threadState);
          expect(state.history).toMatchObject({
            historyCursor: "cursor-2",
            loading: true,
            error: null,
          });
          expect(visibleIds(state)).toEqual([RECENT_ROW.sourceItemId]);
          yield* Deferred.succeed(newPending, pageResponse());
          expect(yield* Fiber.join(newLoading)).toEqual({ _tag: "loaded" });
          expect(visibleIds(yield* SubscriptionRef.get(harness.threadState))).toEqual([
            OLDER_ROW.sourceItemId,
            RECENT_ROW.sourceItemId,
          ]);
          expect(yield* Ref.get(harness.historyCursors)).toEqual(["cursor-1", "cursor-2"]);
        }),
    );
  }

  it.effect(
    "an older projection page cannot overwrite updates received while it was in flight",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
        const pending = yield* harness.nextPage;
        const liveItem = { ...RECENT_ROW.item, output: "newer live output" };
        yield* Queue.offerAll(harness.inputs, [
          itemEvent(liveItem, 11),
          titleEvent("Updated while loading", 12),
        ]);
        yield* harness.awaitState((state) =>
          Option.exists(
            state.data,
            (projection) => projection.thread.title === "Updated while loading",
          ),
        );
        yield* Deferred.succeed(
          pending,
          pageResponse({ ...OLDER_PAGE, snapshotSequence: 5, items: [OLDER_ROW, RECENT_ROW] }),
        );
        expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
        const projection = Option.getOrThrow(
          (yield* SubscriptionRef.get(harness.threadState)).data,
        );
        expect(projection.thread.title).toBe("Updated while loading");
        expect(projection.visibleTurnItems.map((entry) => entry.item)).toEqual([
          OLDER_ROW.item,
          liveItem,
        ]);
      }),
  );

  it.effect("a history page never advances the live-event dedupe sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
      yield* Deferred.succeed(
        yield* harness.nextPage,
        pageResponse({ ...OLDER_PAGE, snapshotSequence: 12 }),
      );
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      yield* Queue.offer(harness.inputs, rollbackEvent(11));
      const state = yield* harness.awaitState((value) =>
        Option.exists(value.data, (projection) => projection.runs[0]?.status === "rolled_back"),
      );
      expect(visibleIds(state)).toEqual([OLDER_ROW.sourceItemId]);
    }),
  );

  it.effect("live updates after a newer history page replace content without duplicating it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
      const continued = { ...OLDER_ROW.item, output: "out-0 continued" };
      yield* Deferred.succeed(
        yield* harness.nextPage,
        pageResponse({
          ...OLDER_PAGE,
          snapshotSequence: 12,
          items: [{ ...OLDER_ROW, item: continued }],
        }),
      );
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      yield* Queue.offerAll(harness.inputs, [
        itemEvent(continued, 11),
        titleEvent("Caught up with history", 12),
      ]);
      const state = yield* harness.awaitState((value) =>
        Option.exists(
          value.data,
          (projection) => projection.thread.title === "Caught up with history",
        ),
      );
      expect(Option.getOrThrow(state.data).visibleTurnItems.map((entry) => entry.item)).toEqual([
        continued,
        RECENT_ROW.item,
      ]);
    }),
  );

  it.effect("a rollback retains the history cursor without refreshing the snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, rollbackEvent(11));
      const state = yield* harness.awaitState((value) =>
        Option.exists(value.data, (projection) => projection.runs[0]?.status === "rolled_back"),
      );
      expect(visibleIds(state)).toEqual([]);
      expect(state.history.historyCursor).toBe("cursor-1");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.historyCursors)).toEqual([]);
    }),
  );

  it.effect("a full replacement of a cached window clears load-earlier state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT });
      expect(harness.subscribeInput.afterSequence).toBe(10);
      yield* Queue.offer(harness.inputs, replacementSnapshot(false));
      const state = yield* harness.awaitState((value) =>
        Option.exists(
          value.data,
          (projection) => projection.thread.title === "Replacement snapshot",
        ),
      );
      expect(state.history).toMatchObject({ historyCursor: null, hasMoreHistory: false });
      expect(yield* harness.loadEarlier()).toEqual({ _tag: "noop" });
      expect(yield* Ref.get(harness.historyCursors)).toEqual([]);
    }),
  );

  it.effect("resumes a cached history window and loads earlier rows without another snapshot", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: WINDOWED_SNAPSHOT });
      expect(harness.subscribeInput.afterSequence).toBe(10);
      expect((yield* SubscriptionRef.get(harness.threadState)).history.historyCursor).toBe(
        "cursor-1",
      );
      const loading = yield* harness.loadEarlier().pipe(Effect.forkScoped);
      yield* Deferred.succeed(yield* harness.nextPage, pageResponse());
      expect(yield* Fiber.join(loading)).toEqual({ _tag: "loaded" });
      expect(visibleIds(yield* SubscriptionRef.get(harness.threadState))).toEqual([
        OLDER_ROW.sourceItemId,
        RECENT_ROW.sourceItemId,
      ]);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.historyCursors)).toEqual(["cursor-1"]);
    }),
  );
});
