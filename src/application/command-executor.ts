/** The one authoritative commit boundary for every trading/resolution command. */
import {
  DomainError,
  decode,
  digest,
  encode,
  identifier,
  integer,
} from "../domain/index";
import type { Store } from "../storage/index";

export class CommandExecutor {
  constructor(
    private readonly store: Store,
    private readonly clock: () => number,
    private readonly fault: (stage: string) => void,
  ) {}

  /** Synchronous transaction and replay boundary shared by every feature. */
  command<T>(
    actor: string,
    commandId: string,
    payload: unknown,
    action: (now: number) => T,
  ): T {
    identifier(actor, "actor");
    identifier(commandId, "commandId");
    if (
      typeof action !== "function" ||
      Object.prototype.toString.call(action) === "[object AsyncFunction]"
    )
      throw new DomainError(
        "ASYNC_TRANSACTION",
        "Commands require a synchronous action",
      );
    const payloadHash = digest(payload);
    let replayed = false;
    const result = this.store.transaction(() => {
      const old = this.store.get<{ payloadHash: string; resultJson: string }>(
        "SELECT * FROM commands WHERE actor=? AND command_id=?",
        actor,
        commandId,
      );
      if (old) {
        if (old.payloadHash !== payloadHash)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Command ID already names different input",
          );
        replayed = true;
        return decode<T>(old.resultJson);
      }
      if (!this.store.get("SELECT value FROM meta WHERE key='operator'"))
        throw new DomainError(
          "NOT_INITIALIZED",
          "Load the mock fixture before executing commands",
        );
      // Read time only after the writer lock. A caller never supplies command time.
      const now = integer(this.clock(), "clock");
      const last = Number(
        this.store.get<{ value: string }>(
          "SELECT value FROM meta WHERE key='last_now'",
        )!.value,
      );
      if (now < last)
        throw new DomainError(
          "CLOCK_REGRESSION",
          "Clock moved behind committed engine time",
        );
      const value = action(now);
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        "then" in value &&
        typeof value.then === "function"
      ) {
        if (value instanceof Promise) void value.catch(() => undefined);
        throw new DomainError(
          "ASYNC_TRANSACTION",
          "Command action returned a thenable",
        );
      }
      const receipt = encode(value); // Thenables/Promises fail before commit as unsupported objects.
      this.store.run(
        "UPDATE meta SET value=? WHERE key='last_now'",
        String(now),
      );
      this.store.run(
        "INSERT INTO commands(actor,command_id,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)",
        actor,
        commandId,
        payloadHash,
        receipt,
        now,
      );
      this.fault("before_commit");
      return value;
    });
    if (!replayed) this.fault("after_commit");
    return result;
  }
}
