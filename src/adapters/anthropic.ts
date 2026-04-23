import Anthropic from "@anthropic-ai/sdk"

import type { Json, MessageRecord, ModelAdapter, ModelTurnResult } from "../types.js"
import { renderTranscriptMessage } from "./shared.js"

type AnthropicMessageClient = {
  messages: {
    create(input: unknown): Promise<{
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Json }
      >
      stop_reason: string | null
    }>
  }
}

export type AnthropicModelAdapterOptions = {
  apiKey?: string
  client?: AnthropicMessageClient
  model: string
  maxTokens?: number
}

export class AnthropicModelAdapter implements ModelAdapter {
  private readonly client: AnthropicMessageClient
  private readonly model: string
  private readonly maxTokens: number

  constructor(options: AnthropicModelAdapterOptions) {
    this.client =
      options.client ??
      (new Anthropic({
        apiKey: options.apiKey,
      }) as unknown as AnthropicMessageClient)
    this.model = options.model
    this.maxTokens = options.maxTokens ?? 1_024
  }

  async runTurn(input: {
    runId: string
    messages: MessageRecord[]
    tool: {
      name: "runTS"
      description: string
      inputSchema: Json
    }
  }): Promise<ModelTurnResult> {
    void input.runId

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: input.messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: renderTranscriptMessage(message),
      })),
      tools: [
        {
          name: input.tool.name,
          description: input.tool.description,
          input_schema: input.tool.inputSchema,
        },
      ],
    } as const)

    const toolUse = response.content.find(
      (block): block is Extract<(typeof response.content)[number], { type: "tool_use" }> =>
        block.type === "tool_use" && block.name === "runTS",
    )

    const content: Json[] = []
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text } as Json)
        continue
      }

      content.push(
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        } as Json,
      )
    }

    const assistantMessage: Json = {
      provider: "anthropic",
      content,
      stopReason: response.stop_reason,
    }

    if (!toolUse) {
      return {
        kind: "final",
        assistantMessage,
      }
    }

    return {
      kind: "run_ts",
      assistantMessage,
      toolCallId: toolUse.id,
      input: toolUse.input as { language: "typescript"; code: string },
    }
  }
}
