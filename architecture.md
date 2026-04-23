# Harness Architecture

## Framing

This is a minimal harness SDK, not a server product.

For `v0`, keep the runtime simple:

- the harness owns the durable run loop
- the harness owns durable conversation and execution state
- the model emits TypeScript to execute
- the TypeScript runs in-process through a mocked `runTS`
- `runTS` directly calls the consumer-defined execution functions

Do **not** build a real sandbox or RPC boundary yet.

That can come later without changing the top-level SDK shape.

## Product Shape

The SDK exposes these core capabilities:

- `submitTask`
- `getHistory`
- `getRunState`

It should also expose operational controls:

- `approve`
- `reject`
- `resume`
- `cancel`

The caller provides:

- the model adapter
- the durable store
- the available functions
- the approval policy

## Core Idea

Keep these separate:

- `runs`: coarse lifecycle state
- `messages`: durable transcript replayed into the model
- `steps`: durable execution log used for recovery

That separation is enough for `v0`.

## Execution Model

The model sees one tool only:

- `runTS`

The model does **not** see every consumer-defined function as a separate tool.

Instead:

1. the caller registers functions on the harness
2. the model is told which functions exist
3. the model emits a `runTS` tool call containing TypeScript
4. the harness executes that code in-process
5. the code can call the registered functions directly
6. the harness persists the result and continues the loop

Example mental model:

- model-visible tool: `runTS(code: string)`
- code-visible functions: `getMeetings`, `getMeetingSummary`, `getMeetingParticipants`

## Why This Shape

This gets you to a demo quickly:

- one model-visible tool
- direct function calls
- no transport layer
- no sandbox complexity
- no RPC protocol yet

It also preserves the future path:

- later, `runTS` can move into a real sandbox
- later, direct function calls can become RPC calls
- the SDK surface and durable state model do not need to change much

## State Model

### Run State

```ts
type RunState =
  | "queued"
  | "running_model"
  | "waiting_for_code"
  | "running_code"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "canceled"
```

Notes:

- `waiting_for_code` means the `runTS` step is durably queued but not started
- `running_code` means in-process code execution has started
- `awaiting_approval` means code execution is blocked on a function that requires approval

Do **not** add `approval_confirmed`.

Reason:

- approval confirmation is just a transition
- after approval, the run should go back to `running_code`

### Step State

```ts
type StepStatus =
  | "pending"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "canceled"
```

### Blocking Reason

```ts
type BlockingReason =
  | { kind: "approval"; requestId: string; functionName: string }
  | { kind: "reconciliation_required"; stepId: string }
```

For `v0`, `reconciliation_required` can remain reserved for future use.

## Persistence Model

### Runs

```ts
type RunRecord = {
  id: string
  state: RunState
  currentStepId: string | null
  blockingReason: BlockingReason | null
  createdAt: string
  updatedAt: string
  error: string | null
}
```

### Messages

```ts
type MessageRecord = {
  id: string
  runId: string
  role: "user" | "assistant" | "tool"
  content: unknown
  createdAt: string
}
```

Notes:

- store provider-shaped content blocks
- the assistant tool call belongs in transcript
- the `runTS` result belongs in transcript

### Steps

```ts
type StepRecord = {
  id: string
  runId: string
  type: "model" | "code" | "approval"
  status: StepStatus
  parentStepId: string | null
  input: unknown
  output: unknown
  error: string | null
  idempotencyKey: string
  startedAt: string | null
  finishedAt: string | null
}
```

## SDK Surface

```ts
type SubmitTaskInput = {
  prompt: string
  metadata?: Record<string, unknown>
}

type SubmitTaskResult = {
  runId: string
}

type RunStateView = {
  runId: string
  state: RunState
  blockingReason: BlockingReason | null
  currentStepId: string | null
  error: string | null
}

interface Harness {
  submitTask(input: SubmitTaskInput): Promise<SubmitTaskResult>
  getHistory(runId: string): Promise<MessageRecord[]>
  getRunState(runId: string): Promise<RunStateView | null>

  approve(input: { runId: string; requestId: string }): Promise<void>
  reject(input: { runId: string; requestId: string; reason?: string }): Promise<void>

  resume(runId: string): Promise<void>
  cancel(runId: string): Promise<void>
}
```

### API Semantics

`submitTask`

- creates the run
- appends the initial user message
- starts the loop or queues it

`getHistory`

- returns the durable transcript for the run
- is the source of truth for replaying model context

`getRunState`

- returns the current coarse-grained run status
- is for polling, orchestration, and resume decisions

## Function Registration

Functions should be registered as an object, not an array.

Desired shape:

```ts
const harness = createHarness({
  model,
  store,
  functions: {
    getMeetings: defineFunction({
      inputSchema: z.object({ since: z.string().optional() }),
      execute: async ({ since }) => meetingsApi.list({ since }),
    }),
    getMeetingSummary: defineFunction({
      inputSchema: z.object({ meetingId: z.string() }),
      execute: async ({ meetingId }) => meetingsApi.getSummary({ meetingId }),
    }),
  },
})
```

This is better than an array for `v0` because:

- lookup is by function name anyway
- duplicate names are harder to represent accidentally
- the config is easier for SDK consumers to write

### Types

```ts
type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

type FunctionContext = {
  runId: string
  stepId: string
  metadata: Record<string, unknown>
}

type FunctionDefinition<TArgs extends Json = Json, TResult extends Json = Json> = {
  inputSchema: unknown
  outputSchema?: unknown
  requiresApproval?: boolean
  description?: string
  execute(args: TArgs, ctx: FunctionContext): Promise<TResult>
}

type FunctionRegistry = Record<string, FunctionDefinition>

type ApprovalPolicy =
  | { mode: "never" }
  | { mode: "always" }
  | { mode: "by_function"; functionNames: string[] }

type HarnessConfig = {
  model: ModelAdapter
  store: HarnessStore
  functions: FunctionRegistry
  approvalPolicy?: ApprovalPolicy
}
```

`defineFunction` can just be an identity helper with better inference:

```ts
function defineFunction<TArgs extends Json, TResult extends Json>(
  definition: FunctionDefinition<TArgs, TResult>
): FunctionDefinition<TArgs, TResult> {
  return definition
}
```

## Function Exposure

All registered functions are available in every run.

```ts
type EffectiveFunctionBinding = {
  name: string
  description?: string
  inputSchema: unknown
  requiresApproval: boolean
}
```

## Model Adapter

The model sees one tool only:

```ts
type RunTSToolInput = {
  language: "typescript"
  code: string
}

type ModelTurnResult =
  | { kind: "final"; assistantMessage: unknown }
  | {
      kind: "run_ts"
      assistantMessage: unknown
      toolCallId: string
      input: RunTSToolInput
    }
```

```ts
interface ModelAdapter {
  runTurn(input: {
    runId: string
    messages: MessageRecord[]
    tool: {
      name: "runTS"
      description: string
      inputSchema: unknown
    }
    functions: EffectiveFunctionBinding[]
  }): Promise<ModelTurnResult>
}
```

Important:

- function descriptions are injected into the prompt or tool description
- they are not exposed as separate provider tools

## `runTS` Contract

For `v0`, `runTS` is in-process and mocked.

```ts
type RunTSResult =
  | { ok: true; output: Json; stdout?: string; stderr?: string }
  | { ok: false; error: string; stdout?: string; stderr?: string }

interface TypeScriptExecutor {
  runTS(input: {
    runId: string
    stepId: string
    code: string
    functions: FunctionRegistry
    allowedFunctionNames: string[]
  }): Promise<RunTSResult>
}
```

Conceptually, `runTS` executes code with direct access to the selected functions:

```ts
const result = await runTS({
  code: `
    const meetings = await getMeetings({ since: "2026-04-01" })
    const summary = await getMeetingSummary({ meetingId: meetings[0].id })
    return { summary }
  `,
})
```

Inside `runTS`, those functions are just wrappers around the registered `execute` callbacks.

## Direct Function Dispatch

Because there is no RPC layer in `v0`, dispatch can be simple:

```ts
async function callFunction(input: {
  runId: string
  stepId: string
  functionName: string
  args: Json
  functions: FunctionRegistry
  metadata: Record<string, unknown>
}): Promise<Json> {
  const fn = input.functions[input.functionName]
  if (!fn) throw new Error(`Unknown function: ${input.functionName}`)

  const parsedArgs = validate(fn.inputSchema, input.args)
  if (!parsedArgs.ok) throw new Error(parsedArgs.error)

  return await fn.execute(parsedArgs.value, {
    runId: input.runId,
    stepId: input.stepId,
    metadata: input.metadata,
  })
}
```

## Approval Flow

Approval still matters even without RPC.

Model:

1. code calls a function
2. harness checks whether that function requires approval
3. if yes:
   - create approval step
   - mark code step `blocked`
   - mark run `awaiting_approval`
4. caller approves or rejects
5. if approved:
   - mark approval step `succeeded`
   - mark run `running_code`
   - continue execution
6. if rejected:
   - surface a structured error into the running code path

Do **not** add `approval_confirmed`.

## Main Loop

Rule:

> never execute the next action from transient memory; only execute from persisted state.

### Model turn

1. mark run `running_model`
2. create model step
3. call model
4. persist assistant message
5. if final answer:
   - mark model step `succeeded`
   - mark run `completed`
6. if `runTS`:
   - create code step with status `pending`
   - mark run `waiting_for_code`

### Code turn

1. load persisted code step
2. mark code step `running`
3. mark run `running_code`
4. execute `runTS`
5. `runTS` directly calls the registered functions
6. persist code step outcome
7. append tool result message to transcript
8. mark run `running_model`
9. continue loop

### Approval turn

1. create approval step when a function call blocks on approval
2. mark code step `blocked`
3. mark run `awaiting_approval`
4. stop progress until approval decision arrives
5. on approval, resume the blocked code execution

## Recovery

Safe resume cases:

- `queued`
- `running_model` before commit
- `waiting_for_code`
- `awaiting_approval`

Risky resume case:

- `running_code`

For `v0`, if a run dies mid-code-execution, prefer one of these simple policies:

- fail the run and require manual resume logic
- or allow retry only if all allowed functions are marked safe/idempotent

Do not overbuild recovery for `v0`.

## Sub-Agents

Do not special-case sub-agents in `v0`.

If you later add them, model them as normal function calls such as:

- `spawnSubagent`
- `awaitSubagent`
- `getSubagentSummary`

If a sub-agent summary needs to become part of the parent model context, write it back into transcript as a durable message.

That is enough for `v0`.

## Read Model For `getRunState`

```ts
type RunStateView = {
  runId: string
  state: RunState
  currentStepId: string | null
  blockingReason: BlockingReason | null
  pendingApproval?: {
    requestId: string
    functionName: string
  } | null
  error: string | null
}
```

This should be derived from the store, not runtime memory.

## Minimal Demo Build Plan

Build in this order:

1. SQLite-backed store for `runs`, `messages`, and `steps`
2. `submitTask`, `getHistory`, and `getRunState`
3. model adapter with one tool: `runTS`
4. in-process `runTS` executor
5. object-based function registry with `defineFunction`
6. approval flow with `approve` and `reject`
7. one demo function set such as meetings APIs

That is enough to prove:

- durable multi-turn execution
- single-tool TypeScript planning
- direct function dispatch
- approval gating
- reconnect via durable state and transcript reload

## Demo-Level Interfaces

```ts
const harness = createHarness({
  model,
  store,
  functions: {
    getMeetings: defineFunction({
      inputSchema: z.object({ since: z.string().optional() }),
      execute: async ({ since }) => meetingsApi.list({ since }),
    }),
    getMeetingSummary: defineFunction({
      inputSchema: z.object({ meetingId: z.string() }),
      execute: async ({ meetingId }) => meetingsApi.getSummary({ meetingId }),
    }),
  },
  approvalPolicy: {
    mode: "by_function",
    functionNames: ["sendEmail", "createCalendarEvent"],
  },
})
```

```ts
const { runId } = await harness.submitTask({
  prompt: "Find the latest product meeting and summarize the decisions.",
})
```

```ts
const history = await harness.getHistory(runId)
const state = await harness.getRunState(runId)
```

## Key Decisions

1. `v0` uses in-process `runTS`, not a real sandbox.
2. `v0` uses direct function dispatch, not RPC.
3. Functions are configured as an object, not an array.
4. The model sees one tool only: `runTS`.
5. Use `awaiting_approval`, not `approval_confirmed`.
