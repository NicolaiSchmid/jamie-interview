import { describe, expect, it } from "bun:test"

import { InProcessTypeScriptExecutor } from "../src/index.js"

describe("InProcessTypeScriptExecutor", () => {
  it("executes TypeScript and returns structured output", async () => {
    const executor = new InProcessTypeScriptExecutor()

    const result = await executor.runTS({
      runId: "run-1",
      stepId: "step-1",
      code: `
        const meetings = await getMeetings({ since: "2026-01-01" })
        console.log("meetings", meetings.length)
        return { firstId: meetings[0].id }
      `,
      bindings: {
        getMeetings: async () => [{ id: "m-1" }],
      },
    })

    expect(result).toEqual({
      ok: true,
      output: { firstId: "m-1" },
      stdout: "meetings 1",
      stderr: undefined,
    })
  })
})
