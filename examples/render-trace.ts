import type { Json, MessageRecord, RunStateView } from "../src/index.js"

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function hasText(value: unknown): value is { type: "assistant"; text: string } {
  return typeof value === "object" && value !== null && "type" in value && "text" in value
}

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function printRunState(state: RunStateView | null): void {
  if (!state) {
    console.log("Run state: <missing>")
    return
  }

  console.log(`state=${state.state}`)
  if (state.pendingApproval) {
    console.log(
      `pending approval: ${state.pendingApproval.functionName} (${state.pendingApproval.requestId})`,
    )
  }
  if (state.error) {
    console.log(`error=${state.error}`)
  }
}

function renderAvailableFunctions(content: Record<string, Json>): void {
  const functions = Array.isArray(content.functions) ? content.functions : []
  if (functions.length === 0) {
    console.log("available functions: <none>")
    return
  }

  console.log("available functions:")
  for (const binding of functions) {
    if (!isObject(binding)) {
      console.log(formatJson(binding))
      continue
    }

    const name = typeof binding.name === "string" ? binding.name : "<unknown>"
    const description =
      typeof binding.description === "string" ? binding.description : "No description."
    const requiresApproval = binding.requiresApproval === true ? " requires approval" : ""
    console.log(`- ${name}: ${description}${requiresApproval}`)
  }
}

function renderProviderMessage(content: Record<string, Json>): void {
  const provider = typeof content.provider === "string" ? content.provider : "model"
  console.log(`provider=${provider}`)

  if ("content" in content) {
    console.log(formatJson(content.content))
  } else {
    console.log(formatJson(content))
  }
}

export function printHistoryMessage(message: MessageRecord): void {
  console.log(`\n[${message.role}] ${message.createdAt}`)

  const content = message.content
  if (!isObject(content)) {
    console.log(formatJson(content))
    return
  }

  if (content.type === "user_prompt") {
    console.log(typeof content.prompt === "string" ? content.prompt : formatJson(content.prompt))
    if (content.metadata && formatJson(content.metadata) !== "{}") {
      console.log(`metadata=${formatJson(content.metadata)}`)
    }
    return
  }

  if (content.type === "available_functions") {
    renderAvailableFunctions(content)
    return
  }

  if (content.type === "runTS_call") {
    console.log(`runTS tool call: ${typeof content.toolCallId === "string" ? content.toolCallId : "<unknown>"}`)
    const input = isObject(content.input) ? content.input : null
    if (input && typeof input.code === "string") {
      console.log(input.code)
    } else {
      console.log(formatJson(content.input))
    }
    return
  }

  if (content.type === "runTS_result") {
    console.log(`runTS result: ${content.ok === true ? "ok" : "error"}`)
    if ("output" in content && content.output !== undefined && content.output !== null) {
      console.log(`output=${formatJson(content.output)}`)
    }
    if (typeof content.error === "string" && content.error.length > 0) {
      console.log(`error=${content.error}`)
    }
    if (typeof content.stdout === "string" && content.stdout.length > 0) {
      console.log(`stdout=${content.stdout}`)
    }
    if (typeof content.stderr === "string" && content.stderr.length > 0) {
      console.log(`stderr=${content.stderr}`)
    }
    return
  }

  if (content.type === "function_call") {
    console.log(
      `call #${typeof content.callIndex === "number" ? content.callIndex : "?"}: ${
        typeof content.functionName === "string" ? content.functionName : "<unknown>"
      } [${typeof content.status === "string" ? content.status : "unknown"}]`,
    )
    console.log(`args=${formatJson(content.args ?? null)}`)
    return
  }

  if (content.type === "function_result") {
    console.log(
      `result #${typeof content.callIndex === "number" ? content.callIndex : "?"}: ${
        typeof content.functionName === "string" ? content.functionName : "<unknown>"
      } [${content.ok === true ? "ok" : "error"}]`,
    )
    if (content.result !== undefined && content.result !== null) {
      console.log(`result=${formatJson(content.result)}`)
    }
    if (typeof content.error === "string" && content.error.length > 0) {
      console.log(`error=${content.error}`)
    }
    return
  }

  if (content.type === "function_call_approval") {
    console.log(
      `${typeof content.functionName === "string" ? content.functionName : "<unknown>"} approval: ${
        typeof content.decision === "string" ? content.decision : "unknown"
      }`,
    )
    if (typeof content.reason === "string" && content.reason.length > 0) {
      console.log(`reason=${content.reason}`)
    }
    return
  }

  if (hasText(content)) {
    console.log(content.text)
    return
  }

  if ("provider" in content) {
    renderProviderMessage(content)
    return
  }

  console.log(formatJson(content))
}

export function printHistory(history: MessageRecord[]): void {
  for (const message of history) {
    printHistoryMessage(message)
  }
}

export async function watchRunTrace(input: {
  approve?(params: { runId: string; requestId: string }): Promise<void>
  getHistory(runId: string): Promise<MessageRecord[]>
  getRunState(runId: string): Promise<RunStateView | null>
  maxWaitMs?: number
  autoApprove?: boolean
  runId: string
  pollMs?: number
}): Promise<RunStateView | null> {
  const seenMessages = new Set<string>()
  const startedAt = Date.now()
  let previousState: string | null = null

  while (true) {
    if (input.maxWaitMs && Date.now() - startedAt > input.maxWaitMs) {
      throw new Error(`Run ${input.runId} did not finish within ${input.maxWaitMs}ms`)
    }

    const [state, history] = await Promise.all([
      input.getRunState(input.runId),
      input.getHistory(input.runId),
    ])

    if (state?.state !== previousState) {
      console.log("\n[state]")
      printRunState(state)
      previousState = state?.state ?? null
    }

    if (input.autoApprove && state?.state === "awaiting_approval" && state.pendingApproval && input.approve) {
      await input.approve({
        runId: input.runId,
        requestId: state.pendingApproval.requestId,
      })
    }

    for (const message of history) {
      if (seenMessages.has(message.id)) {
        continue
      }

      seenMessages.add(message.id)
      printHistoryMessage(message)
    }

    if (
      state?.state === "completed" ||
      state?.state === "failed" ||
      state?.state === "canceled"
    ) {
      return state
    }

    await Bun.sleep(input.pollMs ?? 100)
  }
}
