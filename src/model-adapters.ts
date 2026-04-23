import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import type { Json, MessageRecord, ModelAdapter, ModelTurnResult } from "./types.js"

type OpenAIChatClient = {
  chat: {
    completions: {
      create(input: unknown): Promise<{
        choices: Array<{
          message: {
            content: string | null
            tool_calls?:
              | Array<{
                  id: string
                  type: "function"
                  function: {
                    name: string
                    arguments: string
                  }
                }>
              | null
          }
        }>
      }>
    }
  }
}

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

export type OpenAIModelAdapterOptions = {
  apiKey?: string
  baseURL?: string
  defaultHeaders?: Record<string, string>
  client?: OpenAIChatClient
  model: string
}

export type AnthropicModelAdapterOptions = {
  apiKey?: string
  client?: AnthropicMessageClient
  model: string
  maxTokens?: number
}

export class OpenAIModelAdapter implements ModelAdapter {
  private readonly client: OpenAIChatClient
  private readonly model: string

  constructor(options: OpenAIModelAdapterOptions) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        defaultHeaders: options.defaultHeaders,
      }) as unknown as OpenAIChatClient)
    this.model = options.model
  }

  async runTurn(input: {
    runId: string
    messages: MessageRecord[]
    tool: {
      name: "runTS"
      description: string
      inputSchema: Json
    }
    functions: { name: string; description?: string; inputSchema: Json; requiresApproval: boolean }[]
  }): Promise<ModelTurnResult> {
    void input.runId
    void input.functions

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: input.messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: renderTranscriptMessage(message),
      })),
      tools: [
        {
          type: "function",
          function: {
            name: input.tool.name,
            description: input.tool.description,
            parameters: input.tool.inputSchema,
          },
        },
      ],
    } as const)

    const choice = response.choices[0]
    if (!choice) {
      throw new Error("OpenAI response did not contain a choice")
    }

    const toolCall = choice.message.tool_calls?.find(
      (candidate) => candidate.type === "function" && candidate.function.name === "runTS",
    )

    const assistantMessage: Json = {
      provider: "openai",
      content: choice.message.content,
      toolCalls:
        choice.message.tool_calls?.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          function: {
            name: candidate.function.name,
            arguments: candidate.function.arguments,
          },
        })) ?? [],
    }

    if (!toolCall) {
      return {
        kind: "final",
        assistantMessage,
      }
    }

    return {
      kind: "run_ts",
      assistantMessage,
      toolCallId: toolCall.id,
      input: JSON.parse(toolCall.function.arguments) as { language: "typescript"; code: string },
    }
  }
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
    functions: { name: string; description?: string; inputSchema: Json; requiresApproval: boolean }[]
  }): Promise<ModelTurnResult> {
    void input.runId
    void input.functions

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

export class SequenceModelAdapter implements ModelAdapter {
  private index = 0

  constructor(private readonly responses: ModelTurnResult[]) {}

  async runTurn(input: {
    runId: string
    messages: MessageRecord[]
    tool: {
      name: "runTS"
      description: string
      inputSchema: Json
    }
    functions: { name: string; description?: string; inputSchema: Json; requiresApproval: boolean }[]
  }): Promise<ModelTurnResult> {
    void input
    const response = this.responses[this.index]
    if (!response) {
      throw new Error("No more mock model responses configured")
    }

    this.index += 1
    return response
  }
}

function renderJson(value: Json): string {
  if (typeof value === "string") {
    return value
  }

  return JSON.stringify(value, null, 2)
}

function renderTranscriptMessage(message: MessageRecord): string {
  return renderJson(message.content)
}
