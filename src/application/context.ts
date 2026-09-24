/** Shared local authority. Features use one executor, store and record reader. */
import { randomUUID } from "node:crypto";
import { DomainError, encode, identifier } from "../domain";
import { Store } from "../storage/index";
import { Records } from "../storage/records";
import { CommandExecutor } from "./command-executor";
import type { EngineOptions } from "./options";

export class CommandContext {
  readonly store: Store;
  readonly records: Records;
  readonly clock: () => number;
  private readonly executor: CommandExecutor;
  private readonly faultHook?: (stage: string) => void;
  private readonly idFactory: () => string;

  constructor({
    path = ":memory:",
    clock = Date.now,
    fault,
    idFactory = () => randomUUID().replaceAll("-", ""),
  }: EngineOptions) {
    if (typeof idFactory !== "function")
      throw new DomainError("INVALID_INPUT", "idFactory must be a function");
    this.clock = clock;
    this.faultHook = fault;
    this.idFactory = idFactory;
    this.store = new Store(path);
    this.records = new Records(this.store);
    this.executor = new CommandExecutor(this.store, clock, (stage) =>
      this.fault(stage),
    );
  }
  command<T>(
    actor: string,
    commandId: string,
    payload: unknown,
    action: (now: number) => T,
  ): T {
    return this.executor.command(actor, commandId, payload, action);
  }
  newId(): string {
    return identifier(this.idFactory(), "generated id");
  }
  fault(stage: string): void {
    this.faultHook?.(stage);
  }
  event(
    now: number,
    kind: string,
    id: string,
    type: string,
    payload: unknown,
  ): void {
    this.store.run(
      "INSERT INTO events(created_at,kind,aggregate_id,event_type,payload_json) VALUES(?,?,?,?,?)",
      now,
      kind,
      id,
      type,
      encode(payload),
    );
  }
  readPosition(id: string) {
    return this.records.position(id);
  }
}
