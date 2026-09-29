import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  isQueuedMessageDue,
  useQueuedMessageStore,
  useQueuedMessages,
} from "../queuedMessageStore";
import { derivePhase } from "../session-logic";
import {
  useServerConfigs,
  useThreadProjection,
  useThreadShell,
  useThreadStatus,
} from "../state/entities";
import { useEnvironment } from "../state/environments";
import {
  hasServerAcknowledgedLocalDispatch,
  latestCompletedToolTurnItemId,
} from "./ChatView.logic";
import { sendQueuedMessage } from "./chat/sendQueuedMessage";

/**
 * Sends queued messages when they are due, for every thread with a queue,
 * whether or not the thread is on screen. Mounted once at the root.
 */
export function QueuedMessageSender() {
  const threadKeys = useQueuedMessageStore(
    useShallow((state) => Object.keys(state.queuesByThreadKey)),
  );
  return threadKeys.map((threadKey) => <ThreadQueueSender key={threadKey} threadKey={threadKey} />);
}

/**
 * Watches one thread while it has queued messages. Reading the thread keeps
 * its detail subscribed, so tool boundaries and the end of the turn are
 * visible while the user is elsewhere.
 */
function ThreadQueueSender({ threadKey }: { threadKey: string }) {
  const threadRef = useMemo(() => parseScopedThreadKey(threadKey), [threadKey]);
  const thread = useThreadProjection(threadRef);
  const shell = useThreadShell(threadRef);
  const threadStatus = useThreadStatus(threadRef);
  const environmentId = threadRef?.environmentId ?? null;
  const environment = useEnvironment(environmentId);
  const serverConfigs = useServerConfigs();
  const serverConfigLoaded = environmentId !== null && serverConfigs.has(environmentId);
  const rewinding = useComposerDraftStore((store) => store.rewindingThreadKeys.has(threadKey));
  const queue = useQueuedMessages(threadKey);
  const next = queue[0];
  const sending = queue.some((message) => message.sending);
  const projection = thread?.projection;
  const turnItems = projection?.turnItems;
  const latestToolActivityId = useMemo(
    () => latestCompletedToolTurnItemId(turnItems ?? []),
    [turnItems],
  );
  const pendingRequests = useMemo(
    () =>
      projection === undefined
        ? { approvals: [], userInputs: [] }
        : derivePendingThreadRequests(projection),
    [projection],
  );
  const phase = derivePhase(shell?.runtime ?? null);

  // A send that starts a new turn leaves the thread idle until the server
  // picks it up. Hold the next message until then, as the composer does for
  // its own sends.
  const lastDispatch = useQueuedMessageStore(
    (state) => state.lastDispatchByThreadKey[threadKey]?.thread ?? null,
  );
  const latestUserMessageId = projection?.messages.findLast((m) => m.role === "user")?.id ?? null;
  const waitingForServer =
    lastDispatch !== null &&
    !hasServerAcknowledgedLocalDispatch({
      localDispatch: lastDispatch,
      phase,
      latestRun: shell?.latestRun ?? null,
      latestUserMessageId,
      runtime: shell?.runtime ?? null,
      hasPendingApproval: pendingRequests.approvals.length > 0,
      hasPendingUserInput: pendingRequests.userInputs.length > 0,
      threadError: shell?.runtime?.lastError ?? null,
    });

  // Approvals and questions block the agent; a steer landing on top of them
  // would answer nothing and confuse the turn, so the queue holds until the
  // user resolves them.
  const blocked =
    threadRef === null ||
    thread === null ||
    shell === null ||
    threadStatus !== "live" ||
    (environment !== null && environment.connection.phase !== "connected") ||
    !serverConfigLoaded ||
    rewinding ||
    sending ||
    waitingForServer ||
    pendingRequests.approvals.length > 0 ||
    pendingRequests.userInputs.length > 0;
  const due =
    next !== undefined &&
    !blocked &&
    isQueuedMessageDue({ message: next, phase, latestToolActivityId });
  const nextId = next?.id;
  useEffect(() => {
    if (!due || !threadRef || nextId === undefined) return;
    void sendQueuedMessage(threadRef, nextId);
  }, [due, nextId, threadRef]);
  return null;
}
