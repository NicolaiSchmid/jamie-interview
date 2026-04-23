import { z } from "zod"

import { SequenceModelAdapter, SqliteHarnessStore, createHarness, defineFunction } from "../src/index.js"

const toolCallDelayMs = Number(process.env.EXAMPLE_TOOL_DELAY_MS ?? "2000")

async function main(): Promise<void> {
  const harness = createHarness({
    model: new SequenceModelAdapter([
      {
        kind: "run_ts",
        assistantMessage: { type: "assistant", text: "Checking the latest project status." },
        toolCallId: "tool-1",
        input: {
          language: "typescript",
          code: `
            const status = await getProjectStatus({ projectId: "sdk-harness" })
            return {
              projectId: status.projectId,
              summary: \`\${status.projectId} is \${status.health} and owned by \${status.owner}\`,
              status,
            }
          `,
        },
      },
      {
        kind: "final",
        assistantMessage: {
          type: "assistant",
          text: "Finished. The transcript now contains the user prompt, tool availability, the runTS result, and the final answer.",
        },
      },
    ]),
    store: new SqliteHarnessStore(),
    functions: {
      getProjectStatus: defineFunction({
        description: "Return the latest project health snapshot for a project id.",
        inputSchema: z.object({
          projectId: z.string(),
        }),
        execute: async ({ projectId }) => {
          await Bun.sleep(toolCallDelayMs)

          return {
            projectId,
            health: "green",
            owner: "Jamie",
            lastUpdated: "2026-04-23T09:30:00Z",
          }
        },
      }),
    },
  })

  const { runId } = await harness.submitTask({
    prompt: "Check the current status of sdk-harness and summarize it.",
    functions: ["getProjectStatus"],
    metadata: {
      example: "submit-and-poll",
    },
  })

  console.log(`Started run: ${runId}`)
  console.log(`Each tool call sleeps for ${toolCallDelayMs}ms`)

  console.log("\nState right after submitTask():")
  console.log(JSON.stringify(await harness.getRunState(runId), null, 2))

  const inspectDelayMs = toolCallDelayMs + 1000
  console.log(`\nSleeping for ${inspectDelayMs}ms before reading state and history...`)
  await Bun.sleep(inspectDelayMs)

  console.log("\nState after waiting:")
  console.log(JSON.stringify(await harness.getRunState(runId), null, 2))

  const state = await harness.getRunState(runId)
  const functionCalls = await harness.getFunctionCalls(runId)
  const history = await harness.getHistory(runId)

  console.log("\nFinal state snapshot:")
  console.log(JSON.stringify(state, null, 2))

  console.log("\nFunction calls:")
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
