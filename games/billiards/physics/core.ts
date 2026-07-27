import {
  createJsonWasmAbiAdapter,
  type JsonWasmAbiAdapter,
  type WasmExports,
} from "./wasm-json.js";
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

type BilliardsCoreRequest =
  | {
      readonly op: "create-match";
      readonly seatIds: readonly string[];
      readonly settings: Readonly<BilliardsSettings>;
    }
  | {
      readonly action: BilliardsAction;
      readonly actorSeatId: string;
      readonly decidingBlackChooserIndex?: number;
      readonly op: "reduce-action";
      readonly simulation?: Readonly<BilliardsSimulationResult>;
      readonly state: Readonly<BilliardsMatchState>;
    }
  | {
      readonly input: PredictBilliardsTrajectoryInput;
      readonly op: "predict";
    }
  | {
      readonly input: SimulateBilliardsShotInput;
      readonly op: "simulate";
    }
  | {
      readonly mode: BilliardsMode;
      readonly op: "table-spec";
    }
  | {
      readonly op: "ping";
    };

type BilliardsCoreResponse =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly error: BilliardsCoreErrorPayload;
      readonly ok: false;
    };

export interface BilliardsCoreErrorPayload {
  readonly code: string;
  readonly kind: "internal" | "invalid-input" | "rule";
  readonly message: string;
}

export type BilliardsCore = JsonWasmAbiAdapter<BilliardsCoreRequest, BilliardsCoreResponse>;

export class BilliardsCoreError extends Error {
  readonly code: string;
  readonly kind: BilliardsCoreErrorPayload["kind"];

  constructor(payload: BilliardsCoreErrorPayload) {
    super(payload.message);
    this.name = "BilliardsCoreError";
    this.code = payload.code;
    this.kind = payload.kind;
  }
}

export function bindBilliardsCore(exports: WasmExports): BilliardsCore {
  return createJsonWasmAbiAdapter<BilliardsCoreRequest, BilliardsCoreResponse>(exports);
}

export function simulateBilliardsShotWithCore(
  core: BilliardsCore,
  input: SimulateBilliardsShotInput,
): ShotSimulationResult {
  return requestCore(core, { input, op: "simulate" });
}

export function predictBilliardsTrajectoryWithCore(
  core: BilliardsCore,
  input: PredictBilliardsTrajectoryInput,
): BilliardsTrajectoryPrediction {
  return requestCore(core, { input, op: "predict" });
}

export function getBilliardsCoreInfoWithCore(core: BilliardsCore): BilliardsCoreInfo {
  return requestCore(core, { op: "ping" });
}

export function getBilliardsTableSpecWithCore(
  core: BilliardsCore,
  mode: BilliardsMode,
): BilliardsTableSpec {
  return requestCore(core, { mode, op: "table-spec" });
}

export function createBilliardsMatchStateWithCore(
  core: BilliardsCore,
  settings: Readonly<BilliardsSettings>,
  seatIds: readonly string[],
): BilliardsMatchState {
  return requestCore(core, { op: "create-match", seatIds, settings });
}

export function reduceBilliardsActionWithCore(
  core: BilliardsCore,
  input: {
    readonly action: BilliardsAction;
    readonly actorSeatId: string;
    readonly decidingBlackChooserIndex?: number;
    readonly simulation?: Readonly<BilliardsSimulationResult>;
    readonly state: Readonly<BilliardsMatchState>;
  },
): AdjudicatedBilliardsShot {
  return requestCore(core, { ...input, op: "reduce-action" });
}

export function requestBilliardsCore<T>(core: BilliardsCore, request: BilliardsCoreRequest): T {
  return requestCore(core, request);
}

function requestCore<T>(core: BilliardsCore, request: BilliardsCoreRequest): T {
  const response = core.request(request);
  if (response.ok) return response.value as T;
  throw new BilliardsCoreError(response.error);
}
