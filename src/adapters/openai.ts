import OpenAI from "openai"

import type { Json, MessageRecord, ModelAdapter, ModelTurnResult } from "../types.js"
import { renderTranscriptMessage } from "./shared.js"

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

export type OpenAIModelAdapterOptions = {
  apiKey?: string
  client?: OpenAIChatClient
  model: string
}

export class OpenAIModelAdapter implements ModelAdapter {
  private readonly client: OpenAIChatClient
  private readonly model: string

  constructor(options: OpenAIModelAdapterOptions) {
    this.client =
      options.client ??
      (new OpenAI({
        apiKey: options.apiKey,
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
  }): Promise<ModelTurnResult> {
    void input.runId

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
