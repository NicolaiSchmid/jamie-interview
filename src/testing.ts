import type { Json, MessageRecord, ModelAdapter, ModelTurnResult } from "./types.js"

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
