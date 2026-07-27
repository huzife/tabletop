import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bindBilliardsCore,
  createBilliardsMatchStateWithCore,
  getBilliardsCoreInfoWithCore,
  getBilliardsTableSpecWithCore,
  predictBilliardsTrajectoryWithCore,
  reduceBilliardsActionWithCore,
  simulateBilliardsShotWithCore,
  type BilliardsCore,
} from "./core.js";
import type {
  BilliardsCoreInfo,
  BilliardsTrajectoryPrediction,
  PredictBilliardsTrajectoryInput,
  ShotSimulationResult,
  SimulateBilliardsShotInput,
} from "./types.js";
import type { BilliardsAction } from "../shared/actions.js";
import type { BilliardsMode, BilliardsSettings } from "../shared/settings.js";
import type { BilliardsTableSpec } from "../shared/table.js";
import type {
  AdjudicatedBilliardsShot,
  BilliardsMatchState,
  BilliardsSimulationResult,
} from "../server/state.js";
import type { WasmExports } from "./wasm-json.js";

export * from "./types.js";
export { BilliardsCoreError } from "./core.js";

const CORE_WASM_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../native/generated/tabletop_billiards_core.wasm",
);

function loadBilliardsCore(): BilliardsCore {
  try {
    const bytes = readFileSync(CORE_WASM_PATH);
    const wasm = nodeWasmRuntime();
    const module = new wasm.Module(bytes);
    return bindBilliardsCore(new wasm.Instance(module, {}).exports);
  } catch (cause) {
    throw new Error(
      "Unable to load the billiards WASM core. Build the native core before starting the Node runtime.",
      { cause },
    );
  }
}

interface NodeWasmRuntime {
  readonly Instance: new (
    module: object,
    imports: Readonly<Record<string, unknown>>,
  ) => { readonly exports: WasmExports };
  readonly Module: new (bytes: Uint8Array) => object;
}

function nodeWasmRuntime(): NodeWasmRuntime {
  const candidate = (globalThis as unknown as { readonly WebAssembly?: unknown }).WebAssembly;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("Module" in candidate) ||
    typeof candidate.Module !== "function" ||
    !("Instance" in candidate) ||
    typeof candidate.Instance !== "function"
  ) {
    throw new TypeError("The Node.js runtime does not provide WebAssembly support");
  }
  return candidate as NodeWasmRuntime;
}

const core = loadBilliardsCore();

/**
 * Runs the Rust simulator synchronously for server adjudication and Node tests.
 * The WASM module is instantiated once when this module is loaded.
 */
export function simulateBilliardsShot(input: SimulateBilliardsShotInput): ShotSimulationResult {
  return simulateBilliardsShotWithCore(core, input);
}

/** Computes bounded AI preview paths with the authoritative Rust core. */
export function predictBilliardsTrajectory(
  input: PredictBilliardsTrajectoryInput,
): BilliardsTrajectoryPrediction {
  return predictBilliardsTrajectoryWithCore(core, input);
}

/** Returns the deterministic physics protocol version embedded in the core. */
export function getBilliardsCoreInfo(): BilliardsCoreInfo {
  return getBilliardsCoreInfoWithCore(core);
}

const tableSpecs = new Map<BilliardsMode, BilliardsTableSpec>();

/** Returns the table geometry serialized by the authoritative Rust core. */
export function getBilliardsTableSpec(mode: BilliardsMode): BilliardsTableSpec {
  const cached = tableSpecs.get(mode);
  if (cached !== undefined) return cached;
  const table = getBilliardsTableSpecWithCore(core, mode);
  tableSpecs.set(mode, table);
  return table;
}

/** Creates a match through the pure Rust rules reducer. */
export function createBilliardsCoreMatch(
  settings: Readonly<BilliardsSettings>,
  seatIds: readonly string[],
): BilliardsMatchState {
  return createBilliardsMatchStateWithCore(core, settings, seatIds);
}

/** Applies one already-authorized game action through the pure Rust rules reducer. */
export function reduceBilliardsCoreAction(input: {
  readonly action: BilliardsAction;
  readonly actorSeatId: string;
  readonly decidingBlackChooserIndex?: number;
  readonly simulation?: Readonly<BilliardsSimulationResult>;
  readonly state: Readonly<BilliardsMatchState>;
}): AdjudicatedBilliardsShot {
  return reduceBilliardsActionWithCore(core, input);
}
