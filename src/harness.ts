import { ApprovalRequiredError, RejectedApprovalError } from "./errors.js"
import { InProcessTypeScriptExecutor } from "./run-ts.js"
import type {
  BlockingReason,
  EffectiveFunctionBinding,
  FunctionCallRecord,
  Harness,
  HarnessConfig,
  Json,
  MessageRecord,
  ModelTurnResult,
  RunRecord,
  RunStateView,
  StepRecord,
} from "./types.js"
import { createId, getErrorMessage, now, requiresApproval, schemaToJsonSchema } from "./utils.js"

export function createHarness(config: HarnessConfig): Harness {
  return new DurableHarness(config)
}

class DurableHarness implements Harness {
  private readonly executor
  private readonly inflightRuns = new Map<string, Promise<void>>()

  constructor(private readonly config: HarnessConfig) {
    this.executor = config.executor ?? new InProcessTypeScriptExecutor()
  }

  async submitTask(input: {
    prompt: string
    functions?: string[]
    metadata?: Record<string, Json>
  }): Promise<{ runId: string }> {
    const timestamp = now()
    const runId = createId()
    const run: RunRecord = {
      id: runId,
      state: "queued",
      currentStepId: null,
      blockingReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      error: null,
    }

    await this.config.store.createRun(run)
    await this.config.store.appendMessage({
      id: createId(),
      runId,
      role: "user",
      content: {
        type: "user_prompt",
        prompt: input.prompt,
        metadata: input.metadata ?? {},
      },
      createdAt: now(),
    })

    await this.config.store.appendMessage({
      id: createId(),
      runId,
      role: "tool",
      content: {
        type: "available_functions",
        functions: this.getBindings(input.functions),
      },
      createdAt: now(),
    })

    this.scheduleRun(runId)
    return { runId }
  }

  async getHistory(runId: string): Promise<MessageRecord[]> {
    return await this.config.store.listMessages(runId)
  }

  async getFunctionCalls(runId: string): Promise<FunctionCallRecord[]> {
    return await this.config.store.listFunctionCalls(runId)
  }

  async getRunState(runId: string): Promise<RunStateView | null> {
    const run = await this.config.store.getRun(runId)
    if (!run) {
      return null
    }

    return {
      runId: run.id,
      state: run.state,
      blockingReason: run.blockingReason,
      currentStepId: run.currentStepId,
      pendingApproval:
        run.blockingReason?.kind === "approval"
          ? {
              requestId: run.blockingReason.requestId,
              functionName: run.blockingReason.functionName,
            }
          : null,
      error: run.error,
    }
  }

  async approve(input: { runId: string; requestId: string }): Promise<void> {
    const call = await this.requireFunctionCall(input.requestId)
    if (call.runId !== input.runId) {
      throw new Error(`Approval request ${input.requestId} does not belong to run ${input.runId}`)
    }

    await this.config.store.updateFunctionCall(call.id, {
      status: "approved",
      error: null,
      updatedAt: now(),
    })

    if (call.approvalStepId) {
      await this.config.store.updateStep(call.approvalStepId, {
        status: "succeeded",
        finishedAt: now(),
        updatedAt: now(),
      })
    }

    const run = await this.requireRun(input.runId)
    await this.config.store.updateRun(run.id, {
      state: "running_code",
      blockingReason: null,
      updatedAt: now(),
    })
    this.scheduleRun(run.id)
  }

  async reject(input: { runId: string; requestId: string; reason?: string }): Promise<void> {
    const call = await this.requireFunctionCall(input.requestId)
    if (call.runId !== input.runId) {
      throw new Error(`Approval request ${input.requestId} does not belong to run ${input.runId}`)
    }

    const reason = input.reason ?? `Approval rejected for ${call.functionName}`
    await this.config.store.updateFunctionCall(call.id, {
      status: "rejected",
      error: reason,
      updatedAt: now(),
    })

    if (call.approvalStepId) {
      await this.config.store.updateStep(call.approvalStepId, {
        status: "failed",
        error: reason,
        finishedAt: now(),
        updatedAt: now(),
      })
    }

    const run = await this.requireRun(input.runId)
    await this.config.store.updateRun(run.id, {
      state: "running_code",
      blockingReason: null,
      updatedAt: now(),
    })
    this.scheduleRun(run.id)
  }

  async resume(runId: string): Promise<void> {
    await this.runWithLock(runId)
  }

  async cancel(runId: string): Promise<void> {
    await this.config.store.updateRun(runId, {
      state: "canceled",
      error: null,
      blockingReason: null,
      updatedAt: now(),
    })
  }

  private scheduleRun(runId: string): void {
    void this.runWithLock(runId)
  }

  private async runWithLock(runId: string): Promise<void> {
    const existing = this.inflightRuns.get(runId)
    if (existing) {
      return await existing
    }

    const promise = this.processRun(runId).finally(() => {
      this.inflightRuns.delete(runId)
    })
    this.inflightRuns.set(runId, promise)
    return await promise
  }

  private async processRun(runId: string): Promise<void> {
    while (true) {
      const run = await this.requireRun(runId)
      if (this.isTerminal(run.state) || run.state === "awaiting_approval") {
        return
      }

      if (run.state === "queued" || run.state === "running_model") {
        await this.processModelTurn(run)
        continue
      }

      if (run.state === "waiting_for_code" || run.state === "running_code") {
        await this.processCodeTurn(run)
        continue
      }

      return
    }
  }

  private async processModelTurn(run: RunRecord): Promise<void> {
    const step = await this.createStep(run.id, {
      type: "model",
      parentStepId: null,
      input: null,
    })

    await this.config.store.updateRun(run.id, {
      state: "running_model",
      currentStepId: step.id,
      blockingReason: null,
      updatedAt: now(),
    })
    await this.config.store.updateStep(step.id, {
      status: "running",
      startedAt: now(),
      updatedAt: now(),
    })

    const messages = await this.config.store.listMessages(run.id)
    const bindings = this.getBindings(this.readAvailableFunctionNames(messages))

    const result = await this.config.model.runTurn({
      runId: run.id,
      messages,
      tool: {
        name: "runTS",
        description: this.getRunTSDescription(bindings),
        inputSchema: {
          type: "object",
          properties: {
            language: { type: "string", enum: ["typescript"] },
            code: { type: "string" },
          },
          required: ["language", "code"],
          additionalProperties: false,
        },
      },
      functions: bindings,
    })

    await this.config.store.appendMessage({
      id: createId(),
      runId: run.id,
      role: "assistant",
      content: result.assistantMessage,
      createdAt: now(),
    })

    await this.config.store.updateStep(step.id, {
      status: "succeeded",
      output: { kind: result.kind },
      finishedAt: now(),
      updatedAt: now(),
    })

    if (result.kind === "final") {
      await this.config.store.updateRun(run.id, {
        state: "completed",
        currentStepId: null,
        updatedAt: now(),
      })
      return
    }

    const codeStep = await this.createStep(run.id, {
      type: "code",
      parentStepId: step.id,
      input: {
        toolCallId: result.toolCallId,
        input: result.input,
      },
    })

    await this.config.store.updateRun(run.id, {
      state: "waiting_for_code",
      currentStepId: codeStep.id,
      updatedAt: now(),
    })
  }

  private async processCodeTurn(run: RunRecord): Promise<void> {
    const step = run.currentStepId ? await this.config.store.getStep(run.currentStepId) : null
    if (!step || step.type !== "code") {
      await this.config.store.updateRun(run.id, {
        state: "failed",
        error: "Missing code step for run",
        updatedAt: now(),
      })
      return
    }

    const input = step.input as { input: { code: string } }
    await this.config.store.updateRun(run.id, {
      state: "running_code",
      currentStepId: step.id,
      blockingReason: null,
      updatedAt: now(),
    })
    await this.config.store.updateStep(step.id, {
      status: "running",
      startedAt: step.startedAt ?? now(),
      updatedAt: now(),
    })

    const messages = await this.config.store.listMessages(run.id)
    const allowedFunctionNames = this.readAvailableFunctionNames(messages)

    try {
      const result = await this.executor.runTS({
        runId: run.id,
        stepId: step.id,
        code: input.input.code,
        bindings: this.createBindings(run.id, step.id, allowedFunctionNames),
      })

      await this.config.store.updateStep(step.id, {
        status: result.ok ? "succeeded" : "failed",
        output: result.ok ? result.output : null,
        error: result.ok ? null : result.error,
        finishedAt: now(),
        updatedAt: now(),
      })

      await this.config.store.appendMessage({
        id: createId(),
        runId: run.id,
        role: "tool",
        content: {
          type: "runTS_result",
          ok: result.ok,
          output: result.ok ? result.output : null,
          error: result.ok ? null : result.error,
          stdout: result.stdout ?? null,
          stderr: result.stderr ?? null,
        },
        createdAt: now(),
      })

      await this.config.store.updateRun(run.id, {
        state: "running_model",
        currentStepId: null,
        blockingReason: null,
        updatedAt: now(),
      })
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        await this.config.store.updateStep(step.id, {
          status: "blocked",
          updatedAt: now(),
        })
        await this.config.store.updateRun(run.id, {
          state: "awaiting_approval",
          currentStepId: step.id,
          blockingReason: {
            kind: "approval",
            requestId: error.requestId,
            functionName: error.functionName,
          },
          updatedAt: now(),
        })
        return
      }

      await this.config.store.updateStep(step.id, {
        status: "failed",
        error: getErrorMessage(error),
        finishedAt: now(),
        updatedAt: now(),
      })
      await this.config.store.appendMessage({
        id: createId(),
        runId: run.id,
        role: "tool",
        content: {
          type: "runTS_result",
          ok: false,
          error: getErrorMessage(error),
        },
        createdAt: now(),
      })
      await this.config.store.updateRun(run.id, {
        state: "running_model",
        currentStepId: null,
        blockingReason: null,
        updatedAt: now(),
      })
    }
  }

  private createBindings(
    runId: string,
    stepId: string,
    allowedFunctionNames: string[],
  ): Record<string, (args: Json) => Promise<Json>> {
    const bindings: Record<string, (args: Json) => Promise<Json>> = {}
    let callIndex = 0

    for (const functionName of allowedFunctionNames) {
      bindings[functionName] = async (args: Json) => {
        callIndex += 1
        return await this.invokeFunctionForStep({
          runId,
          stepId,
          callIndex,
          functionName,
          args,
        })
      }
    }

    return bindings
  }

  private async invokeFunctionForStep(input: {
    runId: string
    stepId: string
    callIndex: number
    functionName: string
    args: Json
  }): Promise<Json> {
    const existing = await this.config.store.getFunctionCallByIndex({
      runId: input.runId,
      stepId: input.stepId,
      callIndex: input.callIndex,
    })

    if (existing) {
      return await this.replayFunctionCall(existing, input)
    }

    const definition = this.config.functions[input.functionName]
    if (!definition) {
      throw new Error(`Unknown function: ${input.functionName}`)
    }

    const parsedArgs = definition.inputSchema.parse(input.args)
    const callId = createId()
    const approvalRequired = requiresApproval(
      this.config.approvalPolicy,
      input.functionName,
      definition,
    )

    if (approvalRequired) {
      const approvalStep = await this.createStep(input.runId, {
        type: "approval",
        parentStepId: input.stepId,
        input: {
          requestId: callId,
          functionName: input.functionName,
          args: parsedArgs,
        },
      })

      await this.config.store.updateStep(approvalStep.id, {
        status: "blocked",
        startedAt: now(),
        updatedAt: now(),
      })

      const record: FunctionCallRecord = {
        id: callId,
        runId: input.runId,
        stepId: input.stepId,
        callIndex: input.callIndex,
        functionName: input.functionName,
        args: parsedArgs,
        status: "pending_approval",
        result: null,
        error: null,
        approvalStepId: approvalStep.id,
        createdAt: now(),
        updatedAt: now(),
      }
      await this.config.store.createFunctionCall(record)
      throw new ApprovalRequiredError({
        requestId: record.id,
        functionName: record.functionName,
      })
    }

    const record: FunctionCallRecord = {
      id: callId,
      runId: input.runId,
      stepId: input.stepId,
      callIndex: input.callIndex,
      functionName: input.functionName,
      args: parsedArgs,
      status: "failed",
      result: null,
      error: null,
      approvalStepId: null,
      createdAt: now(),
      updatedAt: now(),
    }

    try {
      const result = await definition.execute(parsedArgs, {
        runId: input.runId,
        stepId: input.stepId,
        metadata: {},
      })
      const output = definition.outputSchema ? definition.outputSchema.parse(result) : result
      record.status = "succeeded"
      record.result = output
      await this.config.store.createFunctionCall(record)
      return output
    } catch (error) {
      record.error = getErrorMessage(error)
      await this.config.store.createFunctionCall(record)
      throw error
    }
  }

  private async replayFunctionCall(
    existing: FunctionCallRecord,
    input: { runId: string; stepId: string; functionName: string; args: Json },
  ): Promise<Json> {
    if (existing.functionName !== input.functionName) {
      throw new Error(
        `Function replay mismatch at call ${existing.callIndex}: expected ${existing.functionName}, got ${input.functionName}`,
      )
    }

    if (JSON.stringify(existing.args) !== JSON.stringify(input.args)) {
      throw new Error(
        `Function replay args mismatch for ${existing.functionName} at call ${existing.callIndex}`,
      )
    }

    if (existing.status === "succeeded") {
      return existing.result as Json
    }

    if (existing.status === "failed") {
      throw new Error(existing.error ?? `Call to ${existing.functionName} failed`)
    }

    if (existing.status === "rejected") {
      throw new RejectedApprovalError(
        existing.error ?? `Approval rejected for ${existing.functionName}`,
      )
    }

    if (existing.status === "pending_approval") {
      throw new ApprovalRequiredError({
        requestId: existing.id,
        functionName: existing.functionName,
      })
    }

    const definition = this.config.functions[existing.functionName]
    if (!definition) {
      throw new Error(`Unknown function: ${existing.functionName}`)
    }

    try {
      const result = await definition.execute(existing.args, {
        runId: input.runId,
        stepId: input.stepId,
        metadata: {},
      })
      const output = definition.outputSchema ? definition.outputSchema.parse(result) : result
      await this.config.store.updateFunctionCall(existing.id, {
        status: "succeeded",
        result: output,
        error: null,
        updatedAt: now(),
      })
      return output
    } catch (error) {
      await this.config.store.updateFunctionCall(existing.id, {
        status: "failed",
        error: getErrorMessage(error),
        updatedAt: now(),
      })
      throw error
    }
  }

  private getBindings(selectedFunctionNames?: string[]): EffectiveFunctionBinding[] {
    const names = selectedFunctionNames ?? Object.keys(this.config.functions)
    return names.map((name) => {
      const definition = this.config.functions[name]
      if (!definition) {
        throw new Error(`Unknown function in selection: ${name}`)
      }

      return {
        name,
        description: definition.description,
        inputSchema: schemaToJsonSchema(definition.inputSchema),
        requiresApproval: requiresApproval(this.config.approvalPolicy, name, definition),
      }
    })
  }

  private getRunTSDescription(bindings: EffectiveFunctionBinding[]): string {
    const functionList = bindings
      .map((binding) => {
        const approvalSuffix = binding.requiresApproval ? " Requires approval." : ""
        return `- ${binding.name}: ${binding.description ?? "No description."}${approvalSuffix}`
      })
      .join("\n")

    return [
      "Execute TypeScript to solve the task.",
      "The code may call the available async functions directly by name.",
      "Return a JSON-serializable value from the script.",
      "Available functions:",
      functionList || "- none",
    ].join("\n")
  }

  private readAvailableFunctionNames(messages: MessageRecord[]): string[] {
    const toolMessage = [...messages]
      .reverse()
      .find((message) => {
        if (message.role !== "tool" || message.content === null || Array.isArray(message.content)) {
          return false
        }

        if (typeof message.content !== "object") {
          return false
        }

        return message.content.type === "available_functions"
      })

    if (!toolMessage) {
      return Object.keys(this.config.functions)
    }

    const content = toolMessage.content as { functions: EffectiveFunctionBinding[] }
    return content.functions.map((binding) => binding.name)
  }

  private async createStep(
    runId: string,
    input: Pick<StepRecord, "type" | "parentStepId" | "input">,
  ): Promise<StepRecord> {
    const timestamp = now()
    const step: StepRecord = {
      id: createId(),
      runId,
      type: input.type,
      status: "pending",
      parentStepId: input.parentStepId,
      input: input.input,
      output: null,
      error: null,
      idempotencyKey: createId(),
      startedAt: null,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.config.store.createStep(step)
    return step
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.config.store.getRun(runId)
    if (!run) {
      throw new Error(`Run ${runId} not found`)
    }

    return run
  }

  private async requireFunctionCall(requestId: string): Promise<FunctionCallRecord> {
    const call = await this.config.store.getFunctionCall(requestId)
    if (!call) {
      throw new Error(`Function call ${requestId} not found`)
    }

    return call
  }

  private isTerminal(state: RunRecord["state"]): boolean {
    return state === "completed" || state === "failed" || state === "canceled"
  }
}
