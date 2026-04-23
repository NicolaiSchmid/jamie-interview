import { describe, expect, it } from "bun:test"

import { OpenAIModelAdapter } from "../src/index.js"

describe("OpenAIModelAdapter", () => {
  it("parses a function tool call from the OpenAI SDK response", async () => {
    const adapter = new OpenAIModelAdapter({
      model: "gpt-test",
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_123",
                        type: "function",
                        function: {
                          name: "runTS",
                          arguments: JSON.stringify({
                            language: "typescript",
                            code: 'return { done: true }',
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          },
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
    })

    expect(result).toEqual({
      kind: "run_ts",
      assistantMessage: {
        provider: "openai",
        content: null,
        toolCalls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "runTS",
              arguments: JSON.stringify({
                language: "typescript",
                code: 'return { done: true }',
              }),
            },
          },
        ],
      },
      toolCallId: "call_123",
      input: {
        language: "typescript",
        code: 'return { done: true }',
      },
    })
  })

  it("returns a final result when no tool call is present", async () => {
    const adapter = new OpenAIModelAdapter({
      model: "gpt-test",
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: "All done",
                    tool_calls: null,
                  },
                },
              ],
            }),
          },
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
    })

    expect(result).toEqual({
      kind: "final",
      assistantMessage: {
        provider: "openai",
        content: "All done",
        toolCalls: [],
      },
    })
  })
})
