import type { JsonValue, SeatId } from "@tabletop/protocol";
import { z } from "zod";

import type { GameActionV1 } from "../shared/contract.js";
import type { AutomationInputContextV1 } from "./context.js";

export const botProfileV1Schema = z.strictObject({
  profileId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  description: z.string().max(240),
  timeBudgetMs: z.number().int().positive().safe(),
});

export interface AutomatedActionRequestV1<TInput extends JsonValue> {
  readonly seatId: SeatId;
  readonly input: Readonly<TInput>;
  readonly revision: number;
  readonly hardDeadlineMonotonicMs: number;
  readonly decisionSeed: string;
}

export interface GameBotProviderV1<
  TState,
  TAction extends GameActionV1,
  TInput extends JsonValue = JsonValue,
> {
  readonly inputSchema: z.ZodType<TInput>;
  listProfiles(): readonly BotProfileV1[];
  createInput(context: AutomationInputContextV1, state: Readonly<TState>, seatId: SeatId): TInput;
  chooseAction(
    request: AutomatedActionRequestV1<TInput> & {
      readonly profileId: string;
    },
  ): Promise<TAction>;
}

export interface GameFallbackControllerV1<
  TState,
  TAction extends GameActionV1,
  TInput extends JsonValue = JsonValue,
> {
  readonly inputSchema: z.ZodType<TInput>;
  createInput(context: AutomationInputContextV1, state: Readonly<TState>, seatId: SeatId): TInput;
  chooseFallbackAction(
    request: AutomatedActionRequestV1<TInput>,
    reason: "disconnect" | "timeout",
  ): Promise<TAction>;
}

export function validateBotProfilesV1(profiles: readonly BotProfileV1[]): readonly BotProfileV1[] {
  const parsed = z.array(botProfileV1Schema).min(1).parse(profiles);
  const ids = new Set<string>();

  for (const profile of parsed) {
    if (ids.has(profile.profileId)) {
      throw new TypeError(`duplicate bot profile: ${profile.profileId}`);
    }
    ids.add(profile.profileId);
  }

  return parsed;
}

export type BotProfileV1 = z.infer<typeof botProfileV1Schema>;
