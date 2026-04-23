import { ApprovalRequiredError } from "./errors.js"
import ts from "typescript"

import type { Json, RunTSResult, TypeScriptExecutor } from "./types.js"
import { getErrorMessage } from "./utils.js"

const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor as new (
  ...args: string[]
) => (...innerArgs: unknown[]) => Promise<unknown>

export class InProcessTypeScriptExecutor implements TypeScriptExecutor {
  async runTS(input: {
    runId: string
    stepId: string
    code: string
    bindings: Record<string, (args: Json) => Promise<Json>>
  }): Promise<RunTSResult> {
    const stdout: string[] = []
    const stderr: string[] = []

    const transpiled = ts.transpileModule(input.code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText

    const argNames = [...Object.keys(input.bindings), "console"]
    const argValues = [
      ...Object.values(input.bindings),
      {
        log: (...args: unknown[]) => stdout.push(args.map(formatConsoleArg).join(" ")),
        error: (...args: unknown[]) => stderr.push(args.map(formatConsoleArg).join(" ")),
      },
    ]

    try {
      const fn = new AsyncFunction(...argNames, transpiled)
      const output = (await fn(...argValues)) as Json
      return {
        ok: true,
        output,
        stdout: stdout.length > 0 ? stdout.join("\n") : undefined,
        stderr: stderr.length > 0 ? stderr.join("\n") : undefined,
      }
    } catch (error) {
      if (error instanceof ApprovalRequiredError) {
        throw error
      }

      return {
        ok: false,
        error: getErrorMessage(error),
        stdout: stdout.length > 0 ? stdout.join("\n") : undefined,
        stderr: stderr.length > 0 ? stderr.join("\n") : undefined,
      }
    }
  }
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  return JSON.stringify(value)
}
