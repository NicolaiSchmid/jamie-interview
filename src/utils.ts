import { z, ZodType } from "zod"

import type { ApprovalPolicy, FunctionDefinition, Json } from "./types.js"

export function now(): string {
  return new Date().toISOString()
}

export function createId(): string {
  return crypto.randomUUID()
}

export function serializeJson(value: Json | null): string | null {
  return value === null ? null : JSON.stringify(value)
}

export function deserializeJson<T>(value: string | null): T | null {
  if (value === null) {
    return null
  }

  return JSON.parse(value) as T
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export function schemaToJsonSchema(schema: ZodType): Json {
  try {
    const jsonSchema = z.toJSONSchema(schema)
    return jsonSchema as Json
  } catch {
    return { type: "object" }
  }
}

export function requiresApproval(
  policy: ApprovalPolicy | undefined,
  functionName: string,
  definition: FunctionDefinition,
): boolean {
  if (typeof definition.requiresApproval === "boolean") {
    return definition.requiresApproval
  }

  if (!policy) {
    return false
  }

  if (policy.mode === "always") {
    return true
  }

  if (policy.mode === "never") {
    return false
  }

  return policy.functionNames.includes(functionName)
}
