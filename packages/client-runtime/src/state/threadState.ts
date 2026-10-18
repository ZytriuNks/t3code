import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface ThreadTextPlaybackState {
  readonly generation: number;
  readonly phase: "pending" | "synchronized" | "legacy";
  /** Turn-item IDs (including inherited visible items), not message IDs. */
  readonly baselineByItemId: ReadonlyMap<
    string,
    { readonly runId: string | null; readonly text: string }
  >;
  readonly legacyRunIds: ReadonlySet<string>;
}

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Progressive history cursor for bounded hydration. Absent/cleared on full
   * snapshot paths. Errors here are thread/history-local and must not be
   * promoted into the environment disconnect path.
   */
  readonly history: ThreadHistoryMeta;
  readonly textPlayback?: ThreadTextPlaybackState;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};
