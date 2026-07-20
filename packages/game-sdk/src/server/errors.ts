import type { JsonObject } from "@tabletop/protocol";

const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export class GameRuleError extends Error {
  readonly ruleCode: string;
  readonly publicDetails: JsonObject;

  constructor(
    ruleCode: string,
    publicDetails: JsonObject = {},
    internalMessage = "game rule rejected the action",
  ) {
    if (!RULE_CODE_PATTERN.test(ruleCode) || ruleCode.length > 96) {
      throw new TypeError(`invalid game rule code: ${ruleCode}`);
    }

    super(internalMessage);
    this.name = "GameRuleError";
    this.ruleCode = ruleCode;
    this.publicDetails = publicDetails;
  }
}
