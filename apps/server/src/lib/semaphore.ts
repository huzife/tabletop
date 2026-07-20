export class SemaphoreSaturatedError extends Error {
  constructor() {
    super("Semaphore waiting queue is full");
    this.name = "SemaphoreSaturatedError";
  }
}

export class Semaphore {
  readonly #capacity: number;
  readonly #maxWaiters: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(capacity: number, maxWaiters = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Semaphore capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0) {
      throw new RangeError("Semaphore maxWaiters must be a nonnegative safe integer");
    }

    this.#capacity = capacity;
    this.#maxWaiters = maxWaiters;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire();

    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#capacity) {
      this.#active += 1;
      return;
    }
    if (this.#waiters.length >= this.#maxWaiters) {
      throw new SemaphoreSaturatedError();
    }

    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
  }

  #release(): void {
    this.#active -= 1;
    this.#waiters.shift()?.();
  }
}
