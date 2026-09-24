export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function invariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`Invariant violation: ${message}`);
}
