import { describe, expect, it } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

import {
  SequenceModelAdapter,
  SqliteHarnessStore,
  createHarness,
  defineFunction,
} from "../src/index.js"

async function waitForRunState(
  harness: ReturnType<typeof createHarness>,
  runId: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await harness.getRunState(runId)
    if (state?.state === expected) {
      return
    }

    await Bun.sleep(5)
  }

  throw new Error(`Run ${runId} did not reach state ${expected}`)
}

function getMessageType(message: { content: unknown }): string | null {
  if (
    typeof message.content === "object" &&
    message.content !== null &&
    !Array.isArray(message.content) &&
    "type" in message.content &&
    typeof message.content.type === "string"
  ) {
    return message.content.type
  }

  return null
}

describe("createHarness", () => {
  it("runs a task end to end", async () => {
    const harness = createHarness({
      model: new SequenceModelAdapter([
        {
          kind: "run_ts",
          assistantMessage: { type: "assistant", text: "Running code" },
          toolCallId: "tool-1",
          input: {
            language: "typescript",
            code: `
              const meetings = await getMeetings({ since: "2026-04-01" })
              return { count: meetings.length, latestId: meetings[0].id }
            `,
          },
        },
        {
          kind: "final",
          assistantMessage: { type: "assistant", text: "Done" },
        },
      ]),
      store: new SqliteHarnessStore(),
      functions: {
        getMeetings: defineFunction({
          description: "Return meetings since a date.",
          inputSchema: z.object({ since: z.string() }),
          execute: async () => [{ id: "meeting-1" }, { id: "meeting-2" }],
        }),
      },
    })

    const { runId } = await harness.submitTask({
      prompt: "Summarize the latest meeting.",
    })

    await waitForRunState(harness, runId, "completed")

    const history = await harness.getHistory(runId)
    const functionCalls = await harness.getFunctionCalls(runId)
    const state = await harness.getRunState(runId)

    expect(state?.state).toBe("completed")
    expect(history.map(getMessageType)).toEqual([
      "user_prompt",
      "available_functions",
      "assistant",
      "runTS_call",
      "function_call",
      "function_result",
      "runTS_result",
      "assistant",
    ])
    expect(history[6]?.content).toEqual({
      type: "runTS_result",
      ok: true,
      output: { count: 2, latestId: "meeting-1" },
      error: null,
      stdout: null,
      stderr: null,
    })
    expect(functionCalls).toHaveLength(1)
    expect(functionCalls[0]).toMatchObject({
      callIndex: 1,
      functionName: "getMeetings",
      args: { since: "2026-04-01" },
      status: "succeeded",
      result: [{ id: "meeting-1" }, { id: "meeting-2" }],
      error: null,
    })
  })

  it("blocks on approval and resumes after approval without re-running completed calls", async () => {
    let listCalls = 0
    let summaryCalls = 0

    const harness = createHarness({
      model: new SequenceModelAdapter([
        {
          kind: "run_ts",
          assistantMessage: { type: "assistant", text: "Running code" },
          toolCallId: "tool-1",
          input: {
            language: "typescript",
            code: `
              const meetings = await getMeetings({ since: "2026-04-01" })
              const summary = await getMeetingSummary({ meetingId: meetings[0].id })
              return { summary }
            `,
          },
        },
        {
          kind: "final",
          assistantMessage: { type: "assistant", text: "Done" },
        },
      ]),
      store: new SqliteHarnessStore(),
      approvalPolicy: { mode: "by_function", functionNames: ["getMeetingSummary"] },
      functions: {
        getMeetings: defineFunction({
          inputSchema: z.object({ since: z.string() }),
          execute: async () => {
            listCalls += 1
            return [{ id: "meeting-1" }]
          },
        }),
        getMeetingSummary: defineFunction({
          inputSchema: z.object({ meetingId: z.string() }),
          execute: async () => {
            summaryCalls += 1
            return { text: "approved summary" }
          },
        }),
      },
    })

    const { runId } = await harness.submitTask({
      prompt: "Summarize the latest meeting.",
    })

    await waitForRunState(harness, runId, "awaiting_approval")
    const pending = await harness.getRunState(runId)
    expect(pending?.pendingApproval?.functionName).toBe("getMeetingSummary")
    expect(listCalls).toBe(1)
    expect(summaryCalls).toBe(0)

    await harness.approve({
      runId,
      requestId: pending?.pendingApproval?.requestId ?? "",
    })

    await waitForRunState(harness, runId, "completed")
    expect(listCalls).toBe(1)
    expect(summaryCalls).toBe(1)

    const history = await harness.getHistory(runId)
    expect(history.map(getMessageType)).toEqual([
      "user_prompt",
      "available_functions",
      "assistant",
      "runTS_call",
      "function_call",
      "function_result",
      "function_call",
      "function_call_approval",
      "function_call",
      "function_result",
      "runTS_result",
      "assistant",
    ])
  })

  it("reopens a persisted run and loads state/history from a fresh harness instance", async () => {
    const filename = join(tmpdir(), `jamie-harness-${crypto.randomUUID()}.sqlite`)

    try {
      const harness = createHarness({
        model: new SequenceModelAdapter([
          {
            kind: "run_ts",
            assistantMessage: { type: "assistant", text: "Running code" },
            toolCallId: "tool-1",
            input: {
              language: "typescript",
              code: `
                const meetings = await getMeetings({ since: "2026-04-01" })
                return { count: meetings.length, latestId: meetings[0].id }
              `,
            },
          },
          {
            kind: "final",
            assistantMessage: { type: "assistant", text: "Done" },
          },
        ]),
        store: new SqliteHarnessStore({ filename }),
        functions: {
          getMeetings: defineFunction({
            description: "Return meetings since a date.",
            inputSchema: z.object({ since: z.string() }),
            execute: async () => [{ id: "meeting-1" }, { id: "meeting-2" }],
          }),
        },
      })

      const { runId } = await harness.submitTask({
        prompt: "Summarize the latest meeting.",
        functions: ["getMeetings"],
      })

      await waitForRunState(harness, runId, "completed")

      const reopenedHarness = createHarness({
        model: new SequenceModelAdapter([]),
        store: new SqliteHarnessStore({ filename }),
        functions: {},
      })

      const state = await reopenedHarness.getRunState(runId)
      const history = await reopenedHarness.getHistory(runId)
      const functionCalls = await reopenedHarness.getFunctionCalls(runId)

      expect(state?.state).toBe("completed")
      expect(history.map(getMessageType)).toEqual([
        "user_prompt",
        "available_functions",
        "assistant",
        "runTS_call",
        "function_call",
        "function_result",
        "runTS_result",
        "assistant",
      ])
      expect(functionCalls).toHaveLength(1)
      expect(functionCalls[0]).toMatchObject({
        functionName: "getMeetings",
        status: "succeeded",
        result: [{ id: "meeting-1" }, { id: "meeting-2" }],
      })
    } finally {
      rmSync(filename, { force: true })
    }
  })

  it("marks the run as failed when the model adapter throws", async () => {
    const harness = createHarness({
      model: {
        runTurn: async () => {
          throw new Error("model exploded")
        },
      },
      store: new SqliteHarnessStore(),
      functions: {
        getMeetings: defineFunction({
          inputSchema: z.object({ since: z.string() }),
          execute: async () => [{ id: "meeting-1" }],
        }),
      },
    })

    const { runId } = await harness.submitTask({
      prompt: "Summarize the latest meeting.",
    })

    await waitForRunState(harness, runId, "failed")

    const state = await harness.getRunState(runId)
    const history = await harness.getHistory(runId)

    expect(state).toMatchObject({
      state: "failed",
      error: "model exploded",
      currentStepId: null,
      blockingReason: null,
    })
    expect(history.map(getMessageType)).toEqual(["user_prompt", "available_functions"])
  })
})
