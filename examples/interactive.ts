import { createInterface, type Interface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { z } from "zod"

import {
  type MessageRecord,
  OpenAIModelAdapter,
  type RunStateView,
  SqliteHarnessStore,
  createHarness,
  defineFunction,
} from "../src/index.js"
import { printHistoryMessage, printRunState } from "./render-trace.js"

const placeholderApiKey = "paste_your_cosmoconsult_api_key_here"
const openAIKey = process.env.OPENAI_API_KEY
const legacyAIKey = process.env.AI_API_KEY
const apiKey =
  openAIKey && openAIKey !== placeholderApiKey ? openAIKey : legacyAIKey
const baseURL = process.env.OPENAI_BASE_URL ?? "https://ai.cosmoconsult.com/api/v1"
const model = process.env.OPENAI_MODEL ?? "openai/gpt-5-mini"

if (!apiKey) {
  throw new Error(
    "Missing API key. Set OPENAI_API_KEY or AI_API_KEY in .env or your shell environment.",
  )
}

const openAiKey: string = apiKey

const meetings = [
  {
    id: "mtg-103",
    date: "2026-04-22",
    title: "Product weekly",
    participants: ["Jamie", "Alex", "Rina"],
  },
  {
    id: "mtg-102",
    date: "2026-04-15",
    title: "Product weekly",
    participants: ["Jamie", "Alex"],
  },
] as const

const meetingSummaries: Record<string, string> = {
  "mtg-103":
    "The team agreed to ship the harness SDK as a TypeScript-first package, keep the executor in-process for v0, and add a live example script that uses a real model adapter.",
  "mtg-102":
    "The team decided to model durable runs explicitly and keep approval handling inside the harness rather than in the model adapter.",
}

const meetingActionItems: Record<string, Array<{ owner: string; task: string }>> = {
  "mtg-103": [
    { owner: "Jamie", task: "Write a manual usage example with .env-based API key loading." },
    { owner: "Alex", task: "Document the approval flow and polling pattern." },
    { owner: "Rina", task: "Add a README section for local testing." },
  ],
  "mtg-102": [
    { owner: "Jamie", task: "Lock the store interfaces for v0." },
    { owner: "Alex", task: "Add adapter tests for final and tool-call responses." },
  ],
}

async function main(): Promise<void> {
  const harness = createHarness({
    model: new OpenAIModelAdapter({
      model,
      apiKey: openAiKey,
      baseURL,
      defaultHeaders: {
        "api-key": openAiKey,
      },
    }),
    store: new SqliteHarnessStore(),
    functions: {
      listMeetings: defineFunction({
        description: "List product meetings. Optionally filter to meetings on or after a date.",
        inputSchema: z.object({
          since: z.string().optional(),
        }),
        execute: async ({ since }) => {
          const asRows = meetings.map((meeting) => ({
            id: meeting.id,
            date: meeting.date,
            title: meeting.title,
            participants: [...meeting.participants],
          }))
          if (!since) {
            return asRows
          }

          return asRows.filter((meeting) => meeting.date >= since)
        },
      }),
      getMeetingSummary: defineFunction({
        description: "Return the written summary for a meeting by id.",
        inputSchema: z.object({
          meetingId: z.string(),
        }),
        execute: async ({ meetingId }) => {
          const summary = meetingSummaries[meetingId]
          if (!summary) {
            throw new Error(`Unknown meeting id: ${meetingId}`)
          }

          return {
            meetingId,
            summary,
          }
        },
      }),
      getActionItems: defineFunction({
        description: "Return the action items for a meeting, including owners.",
        inputSchema: z.object({
          meetingId: z.string(),
        }),
        execute: async ({ meetingId }) => {
          const items = meetingActionItems[meetingId]
          if (!items) {
            throw new Error(`Unknown meeting id: ${meetingId}`)
          }

          return {
            meetingId,
            items,
          }
        },
      }),
    },
  })

  const rl = createInterface({ input, output })
  const seenMessageIds = new Set<string>()

  try {
    console.log("Interactive Jamie harness demo")
    console.log(`Base URL: ${baseURL}`)
    console.log(`Model: ${model}`)
    console.log('Type a task and press Enter. Type "exit" to quit.')
    console.log('Try: "Summarize the latest meeting and list the action items."')

    while (true) {
      const nextPrompt = await questionOrNull(rl, "\n> ")
      if (nextPrompt === null) {
        break
      }

      const prompt = nextPrompt.trim()
      if (!prompt) {
        continue
      }

      if (prompt.toLowerCase() === "exit" || prompt.toLowerCase() === "quit") {
        break
      }

      const { runId } = await harness.submitTask({
        prompt,
        functions: [
          "listMeetings",
          "getMeetingSummary",
          "getActionItems",
        ],
        metadata: {
          example: "interactive",
        },
      })

      console.log(`Started run: ${runId}`)
      await watchInteractiveRun({
        rl,
        runId,
        seenMessageIds,
        approve: (requestId) => harness.approve({ runId, requestId }),
        reject: (requestId, reason) => harness.reject({ runId, requestId, reason }),
        getHistory: () => harness.getHistory(runId),
        getRunState: () => harness.getRunState(runId),
      })
    }
  } finally {
    rl.close()
  }
}

async function watchInteractiveRun(input: {
  rl: Interface
  runId: string
  seenMessageIds: Set<string>
  approve(requestId: string): Promise<void>
  reject(requestId: string, reason?: string): Promise<void>
  getHistory(): Promise<MessageRecord[]>
  getRunState(): Promise<RunStateView | null>
}): Promise<void> {
  let previousState: string | null = null
  let handledApprovalRequestId: string | null = null

  while (true) {
    const [state, history] = await Promise.all([input.getRunState(), input.getHistory()])

    if (state?.state !== previousState) {
      console.log("\n[state]")
      printRunState(state)
      previousState = state?.state ?? null
    }

    for (const message of history) {
      if (input.seenMessageIds.has(message.id)) {
        continue
      }

      input.seenMessageIds.add(message.id)
      printHistoryMessage(message)
    }

    if (
      state?.state === "awaiting_approval" &&
      state.pendingApproval &&
      state.pendingApproval.requestId !== handledApprovalRequestId
    ) {
      handledApprovalRequestId = state.pendingApproval.requestId
      const answer = await questionOrNull(
        input.rl,
        `\nApprove ${state.pendingApproval.functionName}? [y/N]: `,
      )
      const decision = answer?.trim().toLowerCase() ?? ""

      if (decision === "y" || decision === "yes") {
        await input.approve(state.pendingApproval.requestId)
      } else {
        await input.reject(
          state.pendingApproval.requestId,
          `Rejected in terminal demo for ${state.pendingApproval.functionName}.`,
        )
      }
    }

    if (
      state?.state === "completed" ||
      state?.state === "failed" ||
      state?.state === "canceled"
    ) {
      console.log("\nFinal state:")
      printRunState(state)
      return
    }

    await Bun.sleep(100)
  }
}

async function questionOrNull(rl: Interface, prompt: string): Promise<string | null> {
  try {
    return await rl.question(prompt)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_USE_AFTER_CLOSE"
    ) {
      return null
    }

    throw error
  }
}

await main()
