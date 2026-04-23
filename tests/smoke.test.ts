import { describe, expect, it } from "bun:test"

import { notImplemented } from "../src/index.js"

describe("package smoke test", () => {
  it("loads the library", () => {
    expect(notImplemented).toBe(true)
  })
})
