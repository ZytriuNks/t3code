import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export class ThreadLifecycleResourceBlockedError extends Schema.TaggedError<ThreadLifecycleResourceBlockedError>()(
  "ThreadLifecycleResourceBlockedError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["inactive", "ownership", "cleanup", "unavailable"]),
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Thread resources are blocked: ${this.reason}.`;
  }
}
