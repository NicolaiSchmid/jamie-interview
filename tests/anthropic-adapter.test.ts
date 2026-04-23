import { describe, expect, it } from "bun:test"

import { AnthropicModelAdapter } from "../src/index.js"

describe("AnthropicModelAdapter", () => {
  it("parses a tool call from the Anthropic SDK response", async () => {
    const adapter = new AnthropicModelAdapter({
      model: "claude-test",
      client: {
        messages: {
          create: async () => ({
            content: [
              { type: "text", text: "Planning" },
              {
                type: "tool_use",
                id: "toolu_123",
                name: "runTS",
                input: {
                  language: "typescript",
                  code: 'return { ok: true }',
                },
              },
            ],
            stop_reason: "tool_use",
          }),
        },
      },
    })

    const result = await adapter.runTurn({
      runId: "run-1",
      messages: [
        {
          id: "m1",
          runId: "run-1",
          role: "user",
          content: { prompt: "Do the work" },
          createdAt: new Date().toISOString(),
        },
      ],
      tool: {
        name: "runTS",
        description: "Execute TypeScript",
        inputSchema: { type: "object" },
      },
      functions: [],
    })

    expect(result).toEqual({
      kind: "run_ts",
      assistantMessage: {
        provider: "anthropic",
        content: [
          { type: "text", text: "Planning" },
          {
            type: "tool_use",
            id: "toolu_123",
            name: "runTS",
            input: {
              language: "typescript",
              code: 'return { ok: true }',
            },
          },
        ],
        stopReason: "tool_use",
      },
      toolCallId: "toolu_123",
      input: {
        language: "typescript",
        code: 'return { ok: true }',
      },
    })
  })

  it("returns a final result when no tool call is present", async () => {
    const adapter = new AnthropicModelAdapter({
      model: "claude-test",
      client: {
        messages: {
          create: async () => ({
            content: [{ type: "text", text: "All done" }],
            stop_reason: "end_turn",
          }),
        },
      },
    })

    const result = await adapter.runTurn({
      runId: "run-1",
      messages: [],
      tool: {
        name: "runTS",
        description: "Execute TypeScript",
        inputSchema: { type: "object" },
      },
      functions: [],
    })

    expect(result).toEqual({
      kind: "final",
      assistantMessage: {
        provider: "anthropic",
        content: [{ type: "text", text: "All done" }],
        stopReason: "end_turn",
      },
    })
  })
})
