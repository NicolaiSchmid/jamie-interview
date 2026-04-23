import { z } from "zod"

import {
  OpenAIModelAdapter,
  SqliteHarnessStore,
  createHarness,
  defineFunction,
} from "../src/index.js"

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

async function waitForRunToFinish(
  harness: ReturnType<typeof createHarness>,
  runId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await harness.getRunState(runId)
    if (!state) {
      throw new Error(`Run ${runId} was not found`)
    }

    if (state.state === "completed" || state.state === "failed" || state.state === "canceled") {
      return
    }

    await Bun.sleep(50)
  }

  throw new Error(`Run ${runId} did not finish in time`)
}

async function main(): Promise<void> {
  const harness = createHarness({
    model: new OpenAIModelAdapter({
      model,
      apiKey,
      baseURL,
      defaultHeaders: {
        "api-key": apiKey,
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
          if (!since) {
            return [...meetings]
          }

          return meetings.filter((meeting) => meeting.date >= since)
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

  const { runId } = await harness.submitTask({
    prompt:
      "Find the latest product meeting, summarize the decisions, and list the action items with owners.",
    functions: ["listMeetings", "getMeetingSummary", "getActionItems"],
  })

  console.log(`Started run: ${runId}`)
  console.log(`Using base URL: ${baseURL}`)
  console.log(`Using model: ${model}`)
  await waitForRunToFinish(harness, runId)

  const state = await harness.getRunState(runId)
  const history = await harness.getHistory(runId)
  const functionCalls = await harness.getFunctionCalls(runId)

  console.log("\nFinal state:")
  console.log(JSON.stringify(state, null, 2))

  console.log("\nTool calls:")
  for (const call of functionCalls) {
    console.log(`\n[${call.callIndex}] ${call.functionName} (${call.status})`)
    console.log(
      JSON.stringify(
        {
          args: call.args,
          result: call.result,
          error: call.error,
        },
        null,
        2,
      ),
    )
  }

  console.log("\nTranscript:")
  for (const message of history) {
    console.log(`\n[${message.role}]`)
    console.log(JSON.stringify(message.content, null, 2))
  }
}

await main()
