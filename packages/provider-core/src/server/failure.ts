import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";

import * as IdAllocator from "./IdAllocator.ts";
import type { ProviderAdapterFailureReason } from "./ProviderAdapter.ts";
import * as Schema from "effect/Schema";

export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.";
  }
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

const legacyManagedFailures = {
  subscription_sharing_v2_user_not_eligible:
    "ChatGPT sharing is unavailable for this account or workspace. Use another provider or check its sharing policy.",
  subscription_sharing_usage_limit_exceeded:
    "Your ChatGPT usage limit was reached. Check ChatGPT Usage settings for your available allowance.",
  subscription_sharing_workplace_individual_usage_limit_exceeded:
    "You reached your workspace's limit for using ChatGPT in other apps. Ask your workspace admin to increase it.",
  subscription_sharing_usage_unavailable:
    "ChatGPT usage is temporarily unavailable. Try again shortly.",
  subscription_sharing_unsupported_capability:
    "Codex used a feature that ChatGPT sharing does not support. Use another provider for this request.",
  subscription_sharing_v2_client_not_enabled:
    "This app is not enabled for this ChatGPT connection. Use your existing CLI or another provider.",
  subscription_sharing_v2_route_not_supported: "ChatGPT does not support this request route.",
  subscription_sharing_v2_invalid_user:
    "ChatGPT could not validate this connection. Check the selected account and sharing permissions.",
  subscription_sharing_v2_user_unavailable:
    "ChatGPT is temporarily unavailable. Try again shortly.",
} as const;
const managedFailures = {
  ...legacyManagedFailures,
  subscription_sharing_user_not_eligible:
    legacyManagedFailures.subscription_sharing_v2_user_not_eligible,
  subscription_sharing_route_not_supported:
    legacyManagedFailures.subscription_sharing_v2_route_not_supported,
  subscription_sharing_invalid_user: legacyManagedFailures.subscription_sharing_v2_invalid_user,
  subscription_sharing_user_unavailable:
    legacyManagedFailures.subscription_sharing_v2_user_unavailable,
  chatpass_v2_scope_not_authorized:
    "This ChatGPT grant does not authorize the request. Check the connection's sharing permissions.",
  chatpass_v2_invalid_authorization_context:
    "ChatGPT could not authorize this connection. Check the client and sharing permissions.",
};

export function classifyCodexManagedError(value: unknown) {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (current: unknown, depth: number): void => {
    if (depth >= 16 || current == null || seen.has(current)) return;
    if (typeof current === "string") {
      texts.push(current);
      return;
    }
    if (typeof current !== "object") return;
    seen.add(current);
    try {
      if (Cause.isCause(current)) {
        visit(Cause.squash(current), depth + 1);
        return;
      }
      // Read only error metadata; never serialize arbitrary provider payloads or call toJSON.
      for (const key of ["code", "errorMessage", "message", "data", "error", "cause"]) {
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
    } catch {
      // Provider causes may contain proxies or throwing accessors.
    }
  };
  visit(value, 0);
  const text = texts.join("\n");
  for (const [code, defaultMessage] of Object.entries(managedFailures)) {
    if (!text.includes(code)) continue;
    const message =
      code === "subscription_sharing_unsupported_capability"
        ? text.includes("tool 'namespace'")
          ? "Codex sent a tool namespace that ChatGPT sharing does not support. Use another provider for this request."
          : text.includes("additional_tools")
            ? "Codex sent an input item that ChatGPT sharing does not support. Use another provider for this request."
            : defaultMessage
        : defaultMessage;
    return { code, message, revoke: false };
  }
  return undefined;
}

const PROVIDER_FAILURE_CATEGORIES: Partial<
  Record<string, { readonly summary: string; readonly guidance: string }>
> = {
  ProviderAdapterTurnStartError: {
    summary: "The provider could not start this turn",
    guidance: "Retry the turn; if it keeps failing, check the provider setup and server logs.",
  },
  ProviderAdapterEventStreamError: {
    summary: "The provider event stream closed unexpectedly",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
  ProviderAdapterOpenSessionError: {
    summary: "The provider session could not be opened",
    guidance: "Check that the provider is installed and signed in, then retry the turn.",
  },
  ProviderAdapterResumeThreadError: {
    summary: "The provider conversation could not be resumed",
    guidance: "Retry the turn; if it keeps failing, check the provider and server logs.",
  },
};

const PROVIDER_FAILURE_REASONS: Record<ProviderAdapterFailureReason, string> = {
  previous_turn_active: "the previous turn is still running",
  attachment_unreadable: "an attachment could not be read",
};

/**
 * Walks a cause chain for curated text without reading arbitrary provider
 * defect text. `known` is the message of a domain error T3 raised itself;
 * `category` is the generic message of the innermost provider wrapper seen.
 */
function curatedCauseMessages(cause: unknown): {
  readonly known: string | undefined;
  readonly category: string | undefined;
} {
  const seen = new Set<unknown>();
  let category: (typeof PROVIDER_FAILURE_CATEGORIES)[string];
  let reason: string | undefined;
  const categoryMessage = () => {
    if (category === undefined) return undefined;
    return reason
      ? `${category.summary}: ${reason}. ${category.guidance}`
      : `${category.summary}. ${category.guidance}`;
  };
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      const tag = (cause as Record<string, unknown>)._tag;
      switch (tag) {
        case "ContextHandoffBudgetError":
          return { known: new ContextHandoffBudgetError().message, category: categoryMessage() };
        case "AcpModelSelectionError":
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
        case "ClaudeAppendSystemPromptFileError":
        case "ClaudeAppendSystemPromptMissingValueError":
        case "CursorModelUnavailableError":
          return { known: stringField(cause, "message"), category: categoryMessage() };
        case "ContextHandoffDeliveryUncertainError":
          return {
            known:
              "T3 could not confirm whether conversation history reached the provider. Retry the turn to recover the session.",
            category: categoryMessage(),
          };
        case "ProviderAdapterProtocolError": {
          const typedReason = (cause as Record<string, unknown>).reason;
          if (
            category !== undefined &&
            typeof typedReason === "string" &&
            Object.hasOwn(PROVIDER_FAILURE_REASONS, typedReason)
          ) {
            reason ??= PROVIDER_FAILURE_REASONS[typedReason as ProviderAdapterFailureReason];
          }
          break;
        }
      }
      if (typeof tag === "string" && Object.hasOwn(PROVIDER_FAILURE_CATEGORIES, tag)) {
        category = PROVIDER_FAILURE_CATEGORIES[tag];
        reason = undefined;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return { known: undefined, category: categoryMessage() };
}

/**
 * The curated message of a domain error in a failure's cause chain, if any.
 * Callers that pass their own `message` to `makeProviderFailure` check it
 * first, so a known reason is not hidden behind a wrapper's text.
 */
export function knownProviderFailureMessage(cause: unknown): string | undefined {
  return curatedCauseMessages(cause).known;
}

function stringField(value: unknown, key: "message" | "code"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

function redactProviderFailureText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
}): OrchestrationV2ProviderFailure {
  const managedFailure = classifyCodexManagedError(input.cause);
  const curated = curatedCauseMessages(input.cause);
  const rawMessage =
    input.message ??
    managedFailure?.message ??
    curated.known ??
    curated.category ??
    DEFAULT_PROVIDER_FAILURE_MESSAGE;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const rawCode = input.code ?? managedFailure?.code ?? stringField(input.cause, "code") ?? null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;

  return {
    class: input.class ?? (managedFailure === undefined ? "unknown" : "provider_error"),
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code,
    retryable: input.retryable ?? null,
    ...(input.class === "usage_limit" &&
    input.resetAt != null &&
    Number.isFinite(Date.parse(input.resetAt))
      ? { resetAt: DateTime.formatIso(DateTime.makeUnsafe(input.resetAt)) }
      : {}),
  };
}

export function makeProviderFailureTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error",
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

export function makeProviderRetryTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = input.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
