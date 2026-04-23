import type { ZodType } from "zod"

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }

export type RunState =
  | "queued"
  | "running_model"
  | "waiting_for_code"
  | "running_code"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "canceled"

export type StepStatus =
  | "pending"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "canceled"

export type BlockingReason =
  | { kind: "approval"; requestId: string; functionName: string }
  | { kind: "reconciliation_required"; stepId: string }

export type RunRecord = {
  id: string
  state: RunState
  currentStepId: string | null
  blockingReason: BlockingReason | null
  createdAt: string
  updatedAt: string
  error: string | null
}

export type MessageRole = "user" | "assistant" | "tool"

export type MessageRecord = {
  id: string
  runId: string
  role: MessageRole
  content: Json
  createdAt: string
}

export type StepRecord = {
  id: string
  runId: string
  type: "model" | "code" | "approval"
  status: StepStatus
  parentStepId: string | null
  input: Json | null
  output: Json | null
  error: string | null
  idempotencyKey: string
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export type FunctionCallStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "succeeded"
  | "failed"

export type FunctionCallRecord = {
  id: string
  runId: string
  stepId: string
  callIndex: number
  functionName: string
  args: Json
  status: FunctionCallStatus
  result: Json | null
  error: string | null
  approvalStepId: string | null
  createdAt: string
  updatedAt: string
}

export type FunctionContext = {
  runId: string
  stepId: string
  metadata: Record<string, Json>
}

export type FunctionDefinition<TArgs extends Json = Json, TResult extends Json = Json> = {
  inputSchema: ZodType<TArgs>
  outputSchema?: ZodType<TResult>
  requiresApproval?: boolean
  description?: string
  execute(args: TArgs, ctx: FunctionContext): Promise<TResult>
}

export type FunctionRegistry = Record<string, FunctionDefinition>

export type ApprovalPolicy =
  | { mode: "never" }
  | { mode: "always" }
  | { mode: "by_function"; functionNames: string[] }

export type EffectiveFunctionBinding = {
  name: string
  description?: string
  inputSchema: Json
  requiresApproval: boolean
}

export type RunTSToolInput = {
  language: "typescript"
  code: string
}

export type ModelTurnResult =
  | { kind: "final"; assistantMessage: Json }
  | {
      kind: "run_ts"
      assistantMessage: Json
      toolCallId: string
      input: RunTSToolInput
    }

export type SubmitTaskInput = {
  prompt: string
  functions?: string[]
  metadata?: Record<string, Json>
}

export type SubmitTaskResult = {
  runId: string
}

export type RunStateView = {
  runId: string
  state: RunState
  blockingReason: BlockingReason | null
  currentStepId: string | null
  pendingApproval?: {
    requestId: string
    functionName: string
  } | null
  error: string | null
}

export type RunTSResult =
  | { ok: true; output: Json; stdout?: string; stderr?: string }
  | { ok: false; error: string; stdout?: string; stderr?: string }

export interface ModelAdapter {
  runTurn(input: {
    runId: string
    messages: MessageRecord[]
    tool: {
      name: "runTS"
      description: string
      inputSchema: Json
    }
    functions: EffectiveFunctionBinding[]
  }): Promise<ModelTurnResult>
}

export interface TypeScriptExecutor {
  runTS(input: {
    runId: string
    stepId: string
    code: string
    bindings: Record<string, (args: Json) => Promise<Json>>
  }): Promise<RunTSResult>
}

export interface HarnessStore {
  createRun(run: RunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | null>
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>

  appendMessage(message: MessageRecord): Promise<void>
  listMessages(runId: string): Promise<MessageRecord[]>

  createStep(step: StepRecord): Promise<void>
  getStep(stepId: string): Promise<StepRecord | null>
  listSteps(runId: string): Promise<StepRecord[]>
  updateStep(stepId: string, patch: Partial<StepRecord>): Promise<void>

  createFunctionCall(record: FunctionCallRecord): Promise<void>
  getFunctionCallByIndex(input: {
    runId: string
    stepId: string
    callIndex: number
  }): Promise<FunctionCallRecord | null>
  getFunctionCall(callId: string): Promise<FunctionCallRecord | null>
  updateFunctionCall(callId: string, patch: Partial<FunctionCallRecord>): Promise<void>
}

export interface Harness {
  submitTask(input: SubmitTaskInput): Promise<SubmitTaskResult>
  getHistory(runId: string): Promise<MessageRecord[]>
  getRunState(runId: string): Promise<RunStateView | null>
  approve(input: { runId: string; requestId: string }): Promise<void>
  reject(input: { runId: string; requestId: string; reason?: string }): Promise<void>
  resume(runId: string): Promise<void>
  cancel(runId: string): Promise<void>
}

export type HarnessConfig = {
  model: ModelAdapter
  store: HarnessStore
  functions: FunctionRegistry
  approvalPolicy?: ApprovalPolicy
  executor?: TypeScriptExecutor
}
