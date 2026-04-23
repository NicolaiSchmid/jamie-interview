import { Database } from "bun:sqlite"

import type {
  FunctionCallRecord,
  HarnessStore,
  MessageRecord,
  RunRecord,
  StepRecord,
} from "./types.js"
import { deserializeJson, now, serializeJson } from "./utils.js"

type SqliteStoreOptions = {
  filename?: string
  database?: Database
}

export class SqliteHarnessStore implements HarnessStore {
  private readonly db: Database

  constructor(options: SqliteStoreOptions = {}) {
    this.db = options.database ?? new Database(options.filename ?? ":memory:")
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA foreign_keys = ON;")
    this.migrate()
  }

  async createRun(run: RunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, state, current_step_id, blocking_reason, created_at, updated_at, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.state,
        run.currentStepId,
        serializeJson(run.blockingReason),
        run.createdAt,
        run.updatedAt,
        run.error,
      )
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRun(row) : null
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    await this.patchRow("runs", runId, {
      state: patch.state,
      current_step_id: patch.currentStepId,
      blocking_reason:
        patch.blockingReason === undefined ? undefined : serializeJson(patch.blockingReason),
      updated_at: patch.updatedAt ?? now(),
      error: patch.error,
    })
  }

  async appendMessage(message: MessageRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, run_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.runId, message.role, serializeJson(message.content), message.createdAt)
  }

  async listMessages(runId: string): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE run_id = ? ORDER BY rowid ASC")
      .all(runId) as Record<string, unknown>[]
    return rows.map((row) => this.mapMessage(row))
  }

  async createStep(step: StepRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO steps (
          id, run_id, type, status, parent_step_id, input, output, error,
          idempotency_key, started_at, finished_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.id,
        step.runId,
        step.type,
        step.status,
        step.parentStepId,
        serializeJson(step.input),
        serializeJson(step.output),
        step.error,
        step.idempotencyKey,
        step.startedAt,
        step.finishedAt,
        step.createdAt,
        step.updatedAt,
      )
  }

  async getStep(stepId: string): Promise<StepRecord | null> {
    const row = this.db.prepare("SELECT * FROM steps WHERE id = ?").get(stepId) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapStep(row) : null
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid ASC")
      .all(runId) as Record<string, unknown>[]
    return rows.map((row) => this.mapStep(row))
  }

  async updateStep(stepId: string, patch: Partial<StepRecord>): Promise<void> {
    await this.patchRow("steps", stepId, {
      status: patch.status,
      parent_step_id: patch.parentStepId,
      input: patch.input === undefined ? undefined : serializeJson(patch.input),
      output: patch.output === undefined ? undefined : serializeJson(patch.output),
      error: patch.error,
      started_at: patch.startedAt,
      finished_at: patch.finishedAt,
      updated_at: patch.updatedAt ?? now(),
    })
  }

  async createFunctionCall(record: FunctionCallRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO function_calls (
          id, run_id, step_id, call_index, function_name, args, status,
          result, error, approval_step_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.stepId,
        record.callIndex,
        record.functionName,
        serializeJson(record.args),
        record.status,
        serializeJson(record.result),
        record.error,
        record.approvalStepId,
        record.createdAt,
        record.updatedAt,
      )
  }

  async getFunctionCallByIndex(input: {
    runId: string
    stepId: string
    callIndex: number
  }): Promise<FunctionCallRecord | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM function_calls
         WHERE run_id = ? AND step_id = ? AND call_index = ?`,
      )
      .get(input.runId, input.stepId, input.callIndex) as Record<string, unknown> | undefined
    return row ? this.mapFunctionCall(row) : null
  }

  async getFunctionCall(callId: string): Promise<FunctionCallRecord | null> {
    const row = this.db.prepare("SELECT * FROM function_calls WHERE id = ?").get(callId) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapFunctionCall(row) : null
  }

  async updateFunctionCall(callId: string, patch: Partial<FunctionCallRecord>): Promise<void> {
    await this.patchRow("function_calls", callId, {
      status: patch.status,
      result: patch.result === undefined ? undefined : serializeJson(patch.result),
      error: patch.error,
      approval_step_id: patch.approvalStepId,
      updated_at: patch.updatedAt ?? now(),
    })
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        current_step_id TEXT,
        blocking_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_step_id TEXT,
        input TEXT,
        output TEXT,
        error TEXT,
        idempotency_key TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS function_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        call_index INTEGER NOT NULL,
        function_name TEXT NOT NULL,
        args TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        approval_step_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, step_id, call_index)
      );
    `)
  }

  private async patchRow(
    table: "runs" | "steps" | "function_calls",
    id: string,
    patch: Record<string, string | null | undefined>,
  ): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) {
      return
    }

    const assignments = entries.map(([key]) => `${key} = ?`).join(", ")
    const values = entries.map(([, value]) => value ?? null)
    this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(...values, id)
  }

  private mapRun(row: Record<string, unknown>): RunRecord {
    return {
      id: String(row.id),
      state: row.state as RunRecord["state"],
      currentStepId: row.current_step_id === null ? null : String(row.current_step_id),
      blockingReason: deserializeJson(row.blocking_reason as string | null),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      error: row.error === null ? null : String(row.error),
    }
  }

  private mapMessage(row: Record<string, unknown>): MessageRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      role: row.role as MessageRecord["role"],
      content: deserializeJson(row.content as string)!,
      createdAt: String(row.created_at),
    }
  }

  private mapStep(row: Record<string, unknown>): StepRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      type: row.type as StepRecord["type"],
      status: row.status as StepRecord["status"],
      parentStepId: row.parent_step_id === null ? null : String(row.parent_step_id),
      input: deserializeJson(row.input as string | null),
      output: deserializeJson(row.output as string | null),
      error: row.error === null ? null : String(row.error),
      idempotencyKey: String(row.idempotency_key),
      startedAt: row.started_at === null ? null : String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }

  private mapFunctionCall(row: Record<string, unknown>): FunctionCallRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      stepId: String(row.step_id),
      callIndex: Number(row.call_index),
      functionName: String(row.function_name),
      args: deserializeJson(row.args as string)!,
      status: row.status as FunctionCallRecord["status"],
      result: deserializeJson(row.result as string | null),
      error: row.error === null ? null : String(row.error),
      approvalStepId: row.approval_step_id === null ? null : String(row.approval_step_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }
  }
}
