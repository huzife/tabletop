export class KeyedMutex<TKey> {
  readonly #queues = new Map<TKey, Promise<void>>();

  async run<T>(key: TKey, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#queues.set(key, tail);

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
      if (this.#queues.get(key) === tail) {
        this.#queues.delete(key);
      }
    }
  }
}
