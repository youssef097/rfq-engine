import { integer } from "./validation";

export class ManualClock {
  private value: number;
  constructor(value = 1000) {
    this.value = integer(value, "time");
  }
  readonly now = (): number => this.value;
  set(value: number): void {
    this.value = integer(value, "time");
  }
  advance(delta: number): void {
    this.set(this.value + integer(delta, "delta"));
  }
}
