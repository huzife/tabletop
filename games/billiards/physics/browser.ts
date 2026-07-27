import {
  bindBilliardsCore,
  getBilliardsCoreInfoWithCore,
  getBilliardsTableSpecWithCore,
  predictBilliardsTrajectoryWithCore,
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
import type { BilliardsMode } from "../shared/settings.js";
import type { BilliardsTableSpec } from "../shared/table.js";

export * from "./types.js";

const CORE_WASM_URL = new URL("../native/generated/tabletop_billiards_core.wasm", import.meta.url);

let corePromise: Promise<BilliardsCore> | undefined;

function getBilliardsCore(): Promise<BilliardsCore> {
  corePromise ??= instantiateBilliardsCore().catch((error: unknown) => {
    corePromise = undefined;
    throw error;
  });
  return corePromise;
}

async function instantiateBilliardsCore(): Promise<BilliardsCore> {
  const response = await fetch(CORE_WASM_URL);
  if (!response.ok) {
    throw new Error(`Unable to fetch the billiards WASM core (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return bindBilliardsCore(instance.exports);
}

/** Starts loading and compiling the browser WASM instance. */
export async function initializeBilliardsPhysics(): Promise<void> {
  await getBilliardsCore();
}

/** Runs a shot after asynchronously initializing the shared browser instance. */
export async function simulateBilliardsShot(
  input: SimulateBilliardsShotInput,
): Promise<ShotSimulationResult> {
  const core = await getBilliardsCore();
  return simulateBilliardsShotWithCore(core, input);
}

/** Computes bounded AI preview paths after asynchronously initializing WASM. */
export async function predictBilliardsTrajectory(
  input: PredictBilliardsTrajectoryInput,
): Promise<BilliardsTrajectoryPrediction> {
  const core = await getBilliardsCore();
  return predictBilliardsTrajectoryWithCore(core, input);
}

/** Returns the deterministic physics protocol version embedded in the core. */
export async function getBilliardsCoreInfo(): Promise<BilliardsCoreInfo> {
  const core = await getBilliardsCore();
  return getBilliardsCoreInfoWithCore(core);
}

/** Returns the table geometry serialized by the authoritative Rust core. */
export async function getBilliardsTableSpec(mode: BilliardsMode): Promise<BilliardsTableSpec> {
  const core = await getBilliardsCore();
  return getBilliardsTableSpecWithCore(core, mode);
}
