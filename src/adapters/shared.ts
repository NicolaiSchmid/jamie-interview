import type { Json, MessageRecord } from "../types.js"

export function renderJson(value: Json): string {
  if (typeof value === "string") {
    return value
  }

  return JSON.stringify(value, null, 2)
}

export function renderTranscriptMessage(message: MessageRecord): string {
  return renderJson(message.content)
}
