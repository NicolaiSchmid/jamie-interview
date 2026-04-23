import { describe, expect, it } from "bun:test"
import { z } from "zod"

import { defineFunction } from "../src/index.js"

describe("package smoke test", () => {
  it("exports defineFunction", async () => {
    const fn = defineFunction({
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ id }),
    })

    await expect(fn.execute({ id: "abc" }, { runId: "r", stepId: "s", metadata: {} })).resolves.toEqual(
      { id: "abc" },
    )
  })
})
