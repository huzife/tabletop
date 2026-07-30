import { seatIdSchema, type SeatId } from "@tabletop/protocol";
import {
  createTestActionContextV1,
  createTestCreateMatchContextV1,
  createTestProjectionContextV1,
  createTestSystemEventContextV1,
  SequenceGameRandomV1,
} from "@tabletop/game-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  applyDoudizhuAction,
  createDoudizhuState,
  doudizhuServerModule,
  type DoudizhuState,
} from "../server/index.js";
import { createDoudizhuDeck, type DoudizhuAction } from "../shared/index.js";

const seat1 = seatIdSchema.parse("seat-1");
const seat2 = seatIdSchema.parse("seat-2");
const seat3 = seatIdSchema.parse("seat-3");

describe("doudizhu match", () => {
  it("deals 54 unique cards and completes the capped rob sequence", () => {
    let state = createState();
    expect(state.seatOrder.map((seatId) => state.hands[seatId]?.length)).toEqual([17, 17, 17]);
    expect(
      new Set(
        [
          ...state.seatOrder.flatMap((seatId) => state.hands[seatId] ?? []),
          ...state.bottomCards,
        ].map(({ id }) => id),
      ).size,
    ).toBe(54);
    expect(state.activeSeatId).toBe(seat1);

    state = act(state, seat1, { type: "doudizhu.bid.call" });
    state = act(state, seat2, { type: "doudizhu.bid.rob" });
    state = act(state, seat3, { type: "doudizhu.bid.rob" });
    state = act(state, seat1, { type: "doudizhu.bid.rob" });

    expect(state).toMatchObject({
      phase: "open_hand",
      landlordSeatId: seat1,
      activeSeatId: seat1,
      bid: { robCount: 3 },
    });
    expect(state.hands[seat1]).toHaveLength(20);
  });

  it("runs open-hand and per-seat doubling before landlord leads", () => {
    let state = reachOpenHand();
    state = act(state, seat1, { type: "doudizhu.open-hand", open: true });
    expect(state).toMatchObject({ phase: "doubling", activeSeatId: seat1, openHand: true });
    state = act(state, seat1, { type: "doudizhu.double", double: true });
    state = act(state, seat2, { type: "doudizhu.double", double: false });
    state = act(state, seat3, { type: "doudizhu.double", double: true });
    expect(state).toMatchObject({
      phase: "playing",
      activeSeatId: seat1,
      doubledBySeat: { [seat1]: true, [seat2]: false, [seat3]: true },
    });
  });

  it("redeals after all three seats decline to call", () => {
    let state = createState();
    state = act(state, seat1, { type: "doudizhu.bid.pass" });
    state = act(state, seat2, { type: "doudizhu.bid.pass" });
    state = act(
      state,
      seat3,
      { type: "doudizhu.bid.pass" },
      new SequenceGameRandomV1(Array.from({ length: 54 }, () => 0)),
    );
    expect(state).toMatchObject({
      dealNumber: 2,
      phase: "bidding",
      activeSeatId: seat1,
      landlordSeatId: null,
    });
    expect(state.seatOrder.map((seatId) => state.hands[seatId]?.length)).toEqual([17, 17, 17]);
  });

  it("settles landlord spring with individual double relationships", () => {
    const state = reachPlaying();
    const winningCard = createDoudizhuDeck().find(({ rank }) => rank === "3");
    if (!winningCard) throw new Error("missing winning card");
    state.hands[seat1] = [winningCard];
    state.hands[seat2] = createDoudizhuDeck()
      .filter(({ rank }) => rank === "4")
      .slice(0, 2);
    state.hands[seat3] = createDoudizhuDeck()
      .filter(({ rank }) => rank === "5")
      .slice(0, 2);
    state.doubledBySeat = { [seat1]: true, [seat2]: false, [seat3]: true };

    const transition = applyDoudizhuAction(actionContext(seat1), state, {
      type: "doudizhu.play",
      cardIds: [winningCard.id],
    });
    if (transition.kind !== "applied") throw new Error("expected applied transition");
    expect(transition.state.outcome).toMatchObject({
      winnerSide: "landlord",
      spring: "landlord",
      commonMultiplier: 16,
      scores: [
        { seatId: seat1, score: 96 },
        { seatId: seat2, score: -32 },
        { seatId: seat3, score: -64 },
      ],
    });
    expect(transition.outcome?.kind).toBe("completed");
  });

  it("resets the trick after two passes and recognizes farmer spring", () => {
    let state = reachPlaying();
    const deck = createDoudizhuDeck();
    const three = deck.find(({ rank }) => rank === "3");
    if (!three) throw new Error("missing three");
    state.hands[seat1] = [three, ...deck.filter(({ rank }) => rank === "9").slice(0, 2)];
    state = act(state, seat1, { type: "doudizhu.play", cardIds: [three.id] });
    state = act(state, seat2, { type: "doudizhu.pass" });
    state = act(state, seat3, { type: "doudizhu.pass" });
    expect(state).toMatchObject({ activeSeatId: seat1, lastPlay: null, passedSeatIds: [] });

    const farmerCard = deck.find(({ rank }) => rank === "4");
    if (!farmerCard) throw new Error("missing farmer card");
    state.activeSeatId = seat2;
    state.hands[seat2] = [farmerCard];
    const won = act(state, seat2, { type: "doudizhu.play", cardIds: [farmerCard.id] });
    expect(won.outcome).toMatchObject({
      winnerSide: "farmers",
      spring: "farmers",
      commonMultiplier: 16,
      scores: [
        { seatId: seat1, score: -32 },
        { seatId: seat2, score: 16 },
        { seatId: seat3, score: 16 },
      ],
    });
  });

  it("projects only viewer and explicitly public hands", () => {
    const hidden = reachPlaying();
    const playerView = doudizhuServerModule.projectView(createTestProjectionContextV1(), hidden, {
      kind: "player",
      seatId: seat2,
    });
    const spectatorView = doudizhuServerModule.projectView(
      createTestProjectionContextV1(),
      hidden,
      { kind: "spectator" },
    );
    expect(playerView.viewerHand).toHaveLength(17);
    expect(playerView.visibleHands).toEqual([]);
    expect(spectatorView.viewerHand).toEqual([]);
    expect(spectatorView.visibleHands).toEqual([]);

    hidden.openHand = true;
    const revealed = doudizhuServerModule.projectView(createTestProjectionContextV1(), hidden, {
      kind: "player",
      seatId: seat2,
    });
    expect(revealed.visibleHands).toEqual([
      expect.objectContaining({ seatId: seat1, cards: expect.any(Array) }),
    ]);
  });

  it("waits through connection loss and hands control to non-reclaimable AI at grace expiry", () => {
    const state = reachPlaying();
    const lost = doudizhuServerModule.handleSystemEvent(createTestSystemEventContextV1(), state, {
      type: "connection.lost",
      seatId: seat1,
      graceDeadlineMs: 30_000,
    });
    expect(lost.kind).toBe("noop");
    expect(lost.state.seats.find(({ seatId }) => seatId === seat1)?.controller).toBe("human");

    const expired = doudizhuServerModule.handleSystemEvent(
      createTestSystemEventContextV1(),
      lost.state,
      { type: "connection.grace_expired", seatId: seat1 },
    );
    if (expired.kind !== "applied") throw new Error("expected takeover");
    expect(expired.state.seats.find(({ seatId }) => seatId === seat1)).toMatchObject({
      controller: "persistent_ai",
      reclaimable: false,
    });
    expect(expired.roomDirectives).toEqual([
      { type: "seat.useFallbackController", seatId: seat1 },
      { type: "seat.setReclaimable", seatId: seat1, reclaimable: false },
    ]);
  });
});

function createState(): DoudizhuState {
  return createDoudizhuState(
    createTestCreateMatchContextV1({
      seats: [seat1, seat2, seat3].map((seatId) => ({
        seatId,
        controller: { kind: "human" as const },
      })),
      random: new SequenceGameRandomV1(Array.from({ length: 54 }, () => 0)),
    }),
    { variant: "rob-landlord" },
  );
}

function reachOpenHand(): DoudizhuState {
  let state = createState();
  state = act(state, seat1, { type: "doudizhu.bid.call" });
  state = act(state, seat2, { type: "doudizhu.bid.rob" });
  state = act(state, seat3, { type: "doudizhu.bid.rob" });
  return act(state, seat1, { type: "doudizhu.bid.rob" });
}

function reachPlaying(): DoudizhuState {
  let state = reachOpenHand();
  state = act(state, seat1, { type: "doudizhu.open-hand", open: false });
  state = act(state, seat1, { type: "doudizhu.double", double: false });
  state = act(state, seat2, { type: "doudizhu.double", double: false });
  return act(state, seat3, { type: "doudizhu.double", double: false });
}

function act(
  state: DoudizhuState,
  seatId: SeatId,
  action: DoudizhuAction,
  random = new SequenceGameRandomV1([]),
): DoudizhuState {
  const transition = applyDoudizhuAction(actionContext(seatId, random), state, action);
  if (transition.kind !== "applied") throw new Error("expected applied action");
  return transition.state;
}

function actionContext(seatId: SeatId, random = new SequenceGameRandomV1([])) {
  return createTestActionContextV1({
    actor: { kind: "human", seatId },
    random,
  });
}
