export interface JsonWasmAbiAdapter<TRequest, TResponse> {
  readonly request: (request: TRequest) => TResponse;
}

export type WasmExports = Readonly<Record<string, unknown>>;

interface WasmMemory {
  readonly buffer: ArrayBuffer;
}

export interface JsonWasmAbiExportNames {
  readonly allocate: string;
  readonly deallocate: string;
  readonly memory: string;
  readonly process: string;
  readonly resultLength: string;
  readonly resultPointer: string;
}

const DEFAULT_EXPORT_NAMES: JsonWasmAbiExportNames = {
  allocate: "billiards_alloc",
  deallocate: "billiards_dealloc",
  memory: "memory",
  process: "billiards_process",
  resultLength: "billiards_result_length",
  resultPointer: "billiards_result_pointer",
};

type NumericWasmFunction = (...values: number[]) => number;

/**
 * Binds a compact JSON-over-linear-memory ABI without depending on generated
 * glue code. Custom export names make the adapter reusable by other WASM cores.
 */
export function createJsonWasmAbiAdapter<TRequest, TResponse>(
  exports: WasmExports,
  names: JsonWasmAbiExportNames = DEFAULT_EXPORT_NAMES,
): JsonWasmAbiAdapter<TRequest, TResponse> {
  const memory = requireMemory(exports[names.memory], names.memory);
  const allocate = requireFunction(exports[names.allocate], names.allocate);
  const deallocate = requireFunction(exports[names.deallocate], names.deallocate);
  const process = requireFunction(exports[names.process], names.process);
  const resultPointer = requireFunction(exports[names.resultPointer], names.resultPointer);
  const resultLength = requireFunction(exports[names.resultLength], names.resultLength);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return {
    request(request) {
      const input = encoder.encode(JSON.stringify(request));
      if (input.byteLength > 0xffff_ffff) {
        throw new RangeError("JSON ABI request exceeds the WASM 32-bit address space");
      }

      const inputPointer = toUint32(allocate(input.byteLength), names.allocate);
      try {
        new Uint8Array(memory.buffer, inputPointer, input.byteLength).set(input);
        const status = toUint32(process(inputPointer, input.byteLength), names.process);
        if (status !== 0) {
          throw new Error(`WASM JSON ABI process failed with status ${status}`);
        }

        const outputPointer = toUint32(resultPointer(), names.resultPointer);
        const outputLength = toUint32(resultLength(), names.resultLength);
        const output = new Uint8Array(memory.buffer, outputPointer, outputLength);
        return JSON.parse(decoder.decode(output)) as TResponse;
      } finally {
        deallocate(inputPointer, input.byteLength);
      }
    },
  };
}

function requireMemory(value: unknown, name: string): WasmMemory {
  const buffer =
    typeof value === "object" && value !== null && "buffer" in value
      ? (value as { readonly buffer?: unknown }).buffer
      : undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Object.prototype.toString.call(buffer) !== "[object ArrayBuffer]"
  ) {
    throw new TypeError(`WASM JSON ABI export "${name}" must be a memory`);
  }
  return value as WasmMemory;
}

function requireFunction(value: unknown, name: string): NumericWasmFunction {
  if (typeof value !== "function") {
    throw new TypeError(`WASM JSON ABI export "${name}" must be a function`);
  }
  return value as NumericWasmFunction;
}

function toUint32(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`WASM JSON ABI export "${source}" returned an invalid u32`);
  }
  return value;
}
