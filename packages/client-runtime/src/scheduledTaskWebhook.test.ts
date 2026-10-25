import { MAX_WEBHOOK_FILTERS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseWebhookFilterDrafts, type WebhookFilterDraft } from "./scheduledTaskWebhook.ts";

describe("webhook filter drafts", () => {
  it("normalizes list input and discards editor identity without changing request values", () => {
    expect(
      parseWebhookFilterDrafts([
        { id: "header", path: " headers.x-event ", op: "equals", value: "push" },
        { id: "actions", path: "body.action", op: "in", value: "opened, , reopened " },
        { id: "present", path: "query.flag", op: "exists", value: "ignored" },
      ]),
    ).toEqual({
      filters: [
        { path: "headers.x-event", op: "equals", value: "push" },
        { path: "body.action", op: "in", value: ["opened", "reopened"] },
        { path: "query.flag", op: "exists" },
      ],
    });
  });

  it("rejects empty membership lists and paths outside the request schema", () => {
    for (const draft of [
      { id: "empty", path: "body.action", op: "in", value: " , " },
      { id: "outside", path: "request.secret", op: "exists", value: "" },
    ] satisfies WebhookFilterDraft[]) {
      expect(parseWebhookFilterDrafts([draft])).toHaveProperty("error");
    }
  });

  it("enforces the schema's filter count before validating individual rows", () => {
    const drafts = Array.from({ length: MAX_WEBHOOK_FILTERS + 1 }, (_, index) => ({
      id: String(index),
      path: "body.action",
      op: "exists" as const,
      value: "",
    }));
    expect(parseWebhookFilterDrafts(drafts)).toEqual({
      error: `Use at most ${MAX_WEBHOOK_FILTERS} filters.`,
    });
  });
});
