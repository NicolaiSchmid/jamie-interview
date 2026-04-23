import type { FunctionDefinition, Json } from "./types.js"

export function defineFunction<TArgs extends Json, TResult extends Json>(
  definition: FunctionDefinition<TArgs, TResult>,
): FunctionDefinition<TArgs, TResult> {
  return definition
}
