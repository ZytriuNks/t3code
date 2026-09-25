import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { CreateThreadsTool, DelegateTaskTool } from "../../mcp/toolkits/orchestrator/tools.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

it("routes Pi's durable child work through T3 tools in the injected system prompt and tool catalog", async () => {
  const handlers = new Map<string, (event: { systemPrompt: string }) => { systemPrompt: string }>();
  const registered: Array<{
    name: string;
    description: string;
    promptSnippet: string;
    execute: (id: string, params: object) => Promise<{ content: Array<{ text: string }> }>;
  }> = [];
  const calls: string[] = [];
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  const fetch = async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id?: number; method: string };
    calls.push(request.method);
    const tools =
      request.method === "tools/list"
        ? [
            {
              name: "delegate_task",
              inputSchema: { type: "object" },
              description: DelegateTaskTool.description,
            },
            {
              name: "create_threads",
              inputSchema: { type: "object" },
              description: CreateThreadsTool.description,
            },
          ]
        : [];
    const result =
      request.method === "tools/call"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({ taskId: "task:1", childThreadId: "thread:1" }),
              },
            ],
          }
        : { tools };
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ id: request.id, result }),
    };
  };
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: { T3_MCP_URL: "http://localhost/mcp", T3_MCP_BEARER_TOKEN: "test-token" } },
    Type: { Unsafe: (value: unknown) => value },
    AbortSignal,
    fetch,
    pi: {
      on: (name: string, handler: (event: { systemPrompt: string }) => { systemPrompt: string }) =>
        handlers.set(name, handler),
      registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
    },
  });
  const hook = handlers.get("before_agent_start");
  assert.isDefined(hook);
  const prompt = hook!({ systemPrompt: "Pi base prompt" }).systemPrompt;
  assert.include(prompt, "mcp__t3-code__delegate_task");
  assert.include(prompt, "native asynchronous subagents");
  assert.notInclude(prompt, "Prefer the current provider's native subagent tools");
  assert.deepEqual(calls, ["initialize", "notifications/initialized", "tools/list"]);
  assert.equal(registered.length, 2);
  for (const tool of registered) {
    assert.include(tool.description, "delegate_task");
    assert.notInclude(tool.description.toLowerCase(), "prefer native subagent");
    assert.include(tool.description, "mcp__t3-code__delegate_task");
    assert.include(tool.promptSnippet, "delegate_task");
    assert.notInclude(
      tool.description,
      "call delegate_task for cross-provider or explicitly T3-owned child tasks",
    );
    assert.notInclude(
      tool.description,
      "Use this for cross-provider work, when native delegation is unavailable",
    );
  }
  const delegated = registered.find((tool) => tool.name === "mcp__t3-code__delegate_task");
  assert.isDefined(delegated);
  const response = await delegated!.execute("call:1", { task: "inspect", mode: "async" });
  assert.deepEqual(JSON.parse(response.content[0]!.text), {
    taskId: "task:1",
    childThreadId: "thread:1",
  });
  assert.equal(calls.at(-1), "tools/call");
});

describe("Pi upstream output-budget workaround", () => {
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    it(`caps ${key} without changing the conversation or tools`, async () => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    });
  }

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});
