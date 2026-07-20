import type { GameRandomV1 } from "../server/context.js";

export type RandomSequenceEntryV1 = number | { readonly label: string; readonly value: number };

export class SequenceGameRandomV1 implements GameRandomV1 {
  readonly #values: RandomSequenceEntryV1[];
  readonly labels: string[] = [];

  constructor(values: readonly RandomSequenceEntryV1[]) {
    this.#values = [...values];
  }

  integer(minInclusive: number, maxInclusive: number, label: string): number {
    if (
      !Number.isSafeInteger(minInclusive) ||
      !Number.isSafeInteger(maxInclusive) ||
      minInclusive > maxInclusive
    ) {
      throw new RangeError("invalid random integer bounds");
    }

    const value = this.#next(label);
    if (!Number.isSafeInteger(value) || value < minInclusive || value > maxInclusive) {
      throw new RangeError(`random value ${value} is outside [${minInclusive}, ${maxInclusive}]`);
    }
    return value;
  }

  pick<T>(items: readonly T[], label: string): T {
    if (items.length === 0) {
      throw new RangeError("cannot pick from an empty collection");
    }
    const index = this.integer(0, items.length - 1, label);
    return items[index] as T;
  }

  assertExhausted(): void {
    if (this.#values.length !== 0) {
      throw new Error(`${this.#values.length} random values were not consumed`);
    }
  }

  #next(label: string): number {
    const entry = this.#values.shift();
    if (entry === undefined) {
      throw new Error(`random sequence exhausted at ${label}`);
    }
    this.labels.push(label);
    if (typeof entry === "number") {
      return entry;
    }
    if (entry.label !== label) {
      throw new Error(`expected random label ${entry.label}, received ${label}`);
    }
    return entry.value;
  }
}
