export class ApprovalRequiredError extends Error {
  readonly requestId: string
  readonly functionName: string

  constructor(input: { requestId: string; functionName: string }) {
    super(`Approval required for ${input.functionName}`)
    this.name = "ApprovalRequiredError"
    this.requestId = input.requestId
    this.functionName = input.functionName
  }
}

export class RejectedApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RejectedApprovalError"
  }
}
