import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GameSeatPresentationV1 } from "@tabletop/game-sdk/web";
import { seatIdSchema } from "@tabletop/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DoudizhuGameView } from "../web/GameView.js";
import { createDoudizhuDeck, type DoudizhuView } from "../shared/index.js";

const seat1 = seatIdSchema.parse("seat-1");
const seat2 = seatIdSchema.parse("seat-2");
const seat3 = seatIdSchema.parse("seat-3");

afterEach(cleanup);

describe("doudizhu web controls", () => {
  it("dispatches the explicit call-landlord action", () => {
    const dispatchAction = vi.fn();
    renderGame(biddingView(), dispatchAction);
    fireEvent.click(screen.getByRole("button", { name: "叫地主" }));
    expect(dispatchAction).toHaveBeenCalledWith({ type: "doudizhu.bid.call" });
  });

  it("uses hints to select a legal response before playing", () => {
    const dispatchAction = vi.fn();
    const view = playingView();
    renderGame(view, dispatchAction);
    fireEvent.click(screen.getByRole("button", { name: /提示/ }));
    const playButton = screen.getByRole("button", { name: /出牌/ });
    expect(playButton).toBeEnabled();
    fireEvent.click(playButton);
    expect(dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "doudizhu.play",
        cardIds: expect.any(Array),
      }),
    );
  });

  it("keeps spectator views read-only", () => {
    const dispatchAction = vi.fn();
    renderGame(
      { ...playingView(), viewerSeatId: null, viewerHand: [], legalActions: noLegalActions() },
      dispatchAction,
      true,
    );
    expect(screen.getByText(/观战中/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /出牌/ })).not.toBeInTheDocument();
  });

  it("shows participant names and a legible wrapped revealed hand", () => {
    const deck = createDoudizhuDeck();
    const view = {
      ...playingView(),
      visibleHands: [{ seatId: seat2, cards: deck.slice(0, 17) }],
    };
    renderGame(view);

    expect(screen.getByText("玩家甲")).toBeInTheDocument();
    expect(screen.getByText("电脑乙")).toBeInTheDocument();
    const revealedHand = screen.getByLabelText("电脑乙的明牌手牌");
    expect(revealedHand).toHaveClass("doudizhu-revealed-hand");
    expect(revealedHand.querySelectorAll(".doudizhu-card")).toHaveLength(17);
  });
});

function renderGame(view: DoudizhuView, dispatchAction = vi.fn(), readOnly = false) {
  return render(
    <DoudizhuGameView
      actionPending={false}
      connectionState="connected"
      dispatchAction={dispatchAction}
      displayEvents={[]}
      readOnly={readOnly}
      seats={seatPresentations()}
      view={view}
    />,
  );
}

function seatPresentations(): readonly GameSeatPresentationV1[] {
  return [
    {
      seatId: seat1,
      displayName: "一号位",
      occupant: { kind: "human", displayName: "玩家甲" },
    },
    {
      seatId: seat2,
      displayName: "二号位",
      occupant: { kind: "bot", displayName: "电脑乙" },
    },
    {
      seatId: seat3,
      displayName: "三号位",
      occupant: { kind: "bot", displayName: "电脑丙" },
    },
  ];
}

function biddingView(): DoudizhuView {
  return {
    phase: "bidding",
    revision: 0,
    dealNumber: 1,
    activeSeatId: seat1,
    viewerSeatId: seat1,
    landlordSeatId: null,
    initialCallerSeatId: null,
    seats: seats(),
    viewerHand: createDoudizhuDeck().slice(0, 17),
    visibleHands: [],
    bottomCards: [],
    lastPlay: null,
    passedSeatIds: [],
    multiplier: { common: 1, robCount: 0, openHand: false, bombCount: 0, spring: null },
    legalActions: {
      ...noLegalActions(),
      canCall: true,
      canPassBid: true,
    },
    outcome: null,
  };
}

function playingView(): DoudizhuView {
  const deck = createDoudizhuDeck();
  const pair3 = deck.filter(({ rank }) => rank === "3").slice(0, 2);
  const pair4 = deck.filter(({ rank }) => rank === "4").slice(0, 2);
  return {
    ...biddingView(),
    phase: "playing",
    landlordSeatId: seat1,
    viewerHand: pair4,
    bottomCards: deck.slice(-3),
    lastPlay: {
      seatId: seat3,
      cards: pair3,
      pattern: { kind: "pair", mainRank: "3", cardCount: 2, sequenceLength: 1 },
    },
    legalActions: {
      ...noLegalActions(),
      canPlay: true,
      canPass: true,
    },
  };
}

function seats(): DoudizhuView["seats"] {
  return [seat1, seat2, seat3].map((seatId, index) => ({
    seatId,
    role: null,
    controller: index === 0 ? "human" : "bot",
    reclaimable: false,
    cardCount: 17,
    isCurrent: index === 0,
    doubled: false,
  }));
}

function noLegalActions(): DoudizhuView["legalActions"] {
  return {
    canCall: false,
    canRob: false,
    canPassBid: false,
    canChooseOpenHand: false,
    canDouble: false,
    canPlay: false,
    canPass: false,
  };
}
