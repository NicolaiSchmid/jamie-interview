import type { FunctionDefinition, Json } from "./types.js"

export {
  AnthropicModelAdapter,
  OpenAIModelAdapter,
  SequenceModelAdapter,
} from "./model-adapters.js"
export { ApprovalRequiredError, RejectedApprovalError } from "./errors.js"
export { createHarness } from "./harness.js"
export { InProcessTypeScriptExecutor } from "./run-ts.js"
export { SqliteHarnessStore } from "./sqlite-store.js"
export type { AnthropicModelAdapterOptions, OpenAIModelAdapterOptions } from "./model-adapters.js"
export function defineFunction<TArgs extends Json, TResult extends Json>(
  definition: FunctionDefinition<TArgs, TResult>,
): FunctionDefinition<TArgs, TResult> {
  return definition
}
export type {
  ApprovalPolicy,
  BlockingReason,
  EffectiveFunctionBinding,
  FunctionCallRecord,
  FunctionContext,
  FunctionDefinition,
  FunctionRegistry,
  Harness,
  HarnessConfig,
  HarnessStore,
  Json,
  MessageRecord,
  ModelAdapter,
  ModelTurnResult,
  RunRecord,
  RunState,
  RunStateView,
  RunTSResult,
  StepRecord,
  StepStatus,
  SubmitTaskInput,
  SubmitTaskResult,
  TypeScriptExecutor,
} from "./types.js"
