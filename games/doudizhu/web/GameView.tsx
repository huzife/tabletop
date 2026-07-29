import type { GameSeatPresentationV1, GameViewPropsV1 } from "@tabletop/game-sdk/web";
import { Button } from "@tabletop/ui";
import { Crown, Eye, Lightbulb, Radio, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  canBeatDoudizhuPlay,
  classifyDoudizhuPlay,
  enumerateDoudizhuPlays,
  sortDoudizhuCards,
  type DoudizhuAction,
  type DoudizhuCard,
  type DoudizhuDisplayEvent,
  type DoudizhuPlayKind,
  type DoudizhuView,
} from "../shared/index.js";

const SUIT_SYMBOLS = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
} as const;

const PATTERN_NAMES: Readonly<Record<DoudizhuPlayKind, string>> = {
  single: "单牌",
  pair: "对子",
  triple: "三张",
  triple_single: "三带一",
  triple_pair: "三带二",
  straight: "顺子",
  pair_straight: "连对",
  airplane: "飞机",
  airplane_singles: "飞机带单",
  airplane_pairs: "飞机带对",
  four_two_singles: "四带二",
  four_two_pairs: "四带两对",
  bomb: "炸弹",
  rocket: "王炸",
};

export function DoudizhuGameView({
  view,
  dispatchAction,
  actionPending,
  connectionState,
  readOnly,
  displayEvents,
  seats: seatPresentations = [],
}: GameViewPropsV1<DoudizhuView, DoudizhuAction, DoudizhuDisplayEvent>) {
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [hintIndex, setHintIndex] = useState(0);
  useEffect(() => {
    setSelectedIds([]);
    setHintIndex(0);
  }, [view.revision]);

  const controlsDisabled = readOnly || actionPending || connectionState !== "connected";
  const previousPattern =
    view.lastPlay !== null && view.lastPlay.seatId !== view.viewerSeatId
      ? view.lastPlay.pattern
      : null;
  const hints = useMemo(
    () => enumerateDoudizhuPlays(view.viewerHand, previousPattern),
    [previousPattern, view.viewerHand],
  );
  const selectedCards = useMemo(
    () =>
      selectedIds
        .map((id) => view.viewerHand.find((card) => card.id === id))
        .filter((card): card is DoudizhuCard => card !== undefined),
    [selectedIds, view.viewerHand],
  );
  const selectedPattern = classifyDoudizhuPlay(selectedCards);
  const selectionLegal =
    selectedPattern !== null &&
    (previousPattern === null || canBeatDoudizhuPlay(selectedPattern, previousPattern));
  const tableSeats = seatPositions(view);
  const latestEvent = displayEvents.at(-1);
  const impactEvent =
    latestEvent?.type === "doudizhu.cards.played" &&
    (latestEvent.patternKind === "bomb" || latestEvent.patternKind === "rocket");

  function toggleCard(cardId: string) {
    if (!view.legalActions.canPlay || controlsDisabled) return;
    setSelectedIds((current) =>
      current.includes(cardId) ? current.filter((id) => id !== cardId) : [...current, cardId],
    );
  }

  function showHint() {
    if (hints.length === 0) return;
    const selected = hints[hintIndex % hints.length];
    if (!selected) return;
    setSelectedIds(selected.cards.map(({ id }) => id));
    setHintIndex((current) => current + 1);
  }

  return (
    <section
      aria-label="斗地主牌桌"
      className={`doudizhu-game doudizhu-game--${view.phase}${impactEvent ? " has-impact" : ""}`}
    >
      <div aria-hidden="true" className="doudizhu-game__ambient" />
      <header className="doudizhu-topbar">
        <div className="doudizhu-brand">
          <span className="doudizhu-brand__seal">斗</span>
          <div>
            <strong>经典抢地主</strong>
            <span>第 {view.dealNumber} 副牌</span>
          </div>
        </div>
        <div
          aria-label={`当前公共倍数 ${view.multiplier.common} 倍`}
          className="doudizhu-multiplier"
        >
          <span>公共倍数</span>
          <strong>×{view.multiplier.common}</strong>
          <small>
            抢 {view.multiplier.robCount} · 炸 {view.multiplier.bombCount}
            {view.multiplier.openHand ? " · 明牌" : ""}
          </small>
        </div>
        <span className={`doudizhu-connection is-${connectionState}`}>
          <Radio aria-hidden="true" size={18} />
          {connectionState === "connected"
            ? "已连接"
            : connectionState === "reconnecting"
              ? "重连中"
              : "已离线"}
        </span>
      </header>

      <div className="doudizhu-bottom-cards" aria-label="地主底牌">
        {view.bottomCards.length === 0
          ? Array.from({ length: 3 }, (_, index) => <CardBack compact key={`bottom-${index}`} />)
          : view.bottomCards.map((card) => <PlayingCard card={card} compact key={card.id} />)}
      </div>

      {tableSeats.map(({ seat, position }) => {
        const visibleHand = view.visibleHands.find(({ seatId }) => seat.seatId === seatId);
        const isViewer = seat.seatId === view.viewerSeatId;
        const displayName = seatDisplayName(view, seat.seatId, seatPresentations);
        const positionLabel = seatLabel(view, seat.seatId);
        return (
          <section
            aria-label={`${displayName}，${positionLabel}，剩余 ${seat.cardCount} 张`}
            className={`doudizhu-seat doudizhu-seat--${position}${seat.isCurrent ? " is-current" : ""}`}
            key={seat.seatId}
          >
            <div className="doudizhu-seat__avatar">
              {seat.role === "landlord" ? (
                <Crown aria-label="地主" size={25} />
              ) : seat.controller === "bot" || seat.controller.endsWith("_ai") ? (
                <Sparkles aria-label="AI" size={23} />
              ) : (
                <span aria-hidden="true">
                  {isViewer ? "我" : position === "left" ? "上" : "下"}
                </span>
              )}
            </div>
            <div className="doudizhu-seat__meta">
              <strong title={displayName}>{displayName}</strong>
              <span>
                {positionLabel} ·{" "}
                {seat.role === "landlord" ? "地主" : seat.role === "farmer" ? "农民" : "等待叫牌"} ·{" "}
                {seat.cardCount} 张
              </span>
              {seat.doubled ? <em>已加倍</em> : null}
            </div>
            {visibleHand ? (
              <div className="doudizhu-revealed-hand" aria-label={`${displayName}的明牌手牌`}>
                {sortDoudizhuCards(visibleHand.cards).map((card) => (
                  <PlayingCard card={card} compact key={card.id} />
                ))}
              </div>
            ) : !isViewer ? (
              <div className="doudizhu-card-stack" aria-hidden="true">
                <CardBack compact />
                <span>{seat.cardCount}</span>
              </div>
            ) : null}
          </section>
        );
      })}

      <main className="doudizhu-trick" aria-live="polite">
        <p className="doudizhu-status">{statusText(view, seatPresentations)}</p>
        {view.lastPlay === null ? (
          <div className="doudizhu-empty-trick">
            {view.phase === "playing" ? "等待领出" : phasePrompt(view)}
          </div>
        ) : (
          <div>
            <span className="doudizhu-trick__label">
              {seatDisplayName(view, view.lastPlay.seatId, seatPresentations)} ·{" "}
              {PATTERN_NAMES[view.lastPlay.pattern.kind]}
            </span>
            <div className="doudizhu-trick__cards">
              {view.lastPlay.cards.map((card) => (
                <PlayingCard card={card} compact key={card.id} />
              ))}
            </div>
          </div>
        )}
        {view.passedSeatIds.length > 0 ? (
          <p className="doudizhu-passes">
            {view.passedSeatIds
              .map((seatId) => `${seatDisplayName(view, seatId, seatPresentations)}不出`)
              .join(" · ")}
          </p>
        ) : null}
      </main>

      {view.outcome ? <OutcomePanel seats={seatPresentations} view={view} /> : null}

      <div className="doudizhu-controls">
        {view.legalActions.canCall || view.legalActions.canPassBid ? (
          <>
            {view.legalActions.canCall ? (
              <Button
                disabled={controlsDisabled}
                onClick={() => dispatchAction({ type: "doudizhu.bid.call" })}
                variant="primary"
              >
                叫地主
              </Button>
            ) : null}
            {view.legalActions.canRob ? (
              <Button
                disabled={controlsDisabled}
                onClick={() => dispatchAction({ type: "doudizhu.bid.rob" })}
                variant="primary"
              >
                {view.viewerSeatId === view.initialCallerSeatId ? "反抢" : "抢地主"}
              </Button>
            ) : null}
            <Button
              disabled={controlsDisabled}
              onClick={() => dispatchAction({ type: "doudizhu.bid.pass" })}
              variant="secondary"
            >
              {view.legalActions.canRob ? "不抢" : "不叫"}
            </Button>
          </>
        ) : null}
        {view.legalActions.canChooseOpenHand ? (
          <>
            <Button
              disabled={controlsDisabled}
              onClick={() => dispatchAction({ type: "doudizhu.open-hand", open: true })}
              variant="primary"
            >
              明牌 ×2
            </Button>
            <Button
              disabled={controlsDisabled}
              onClick={() => dispatchAction({ type: "doudizhu.open-hand", open: false })}
              variant="secondary"
            >
              不明牌
            </Button>
          </>
        ) : null}
        {view.legalActions.canDouble ? (
          <>
            <Button
              disabled={controlsDisabled}
              onClick={() => dispatchAction({ type: "doudizhu.double", double: true })}
              variant="primary"
            >
              加倍
            </Button>
            <Button
              disabled={controlsDisabled}
              onClick={() => dispatchAction({ type: "doudizhu.double", double: false })}
              variant="secondary"
            >
              不加倍
            </Button>
          </>
        ) : null}
        {view.phase === "playing" && view.viewerSeatId !== null ? (
          <>
            <Button
              disabled={controlsDisabled || !view.legalActions.canPlay || hints.length === 0}
              onClick={showHint}
              variant="secondary"
            >
              <Lightbulb aria-hidden="true" size={19} />
              提示
            </Button>
            {view.legalActions.canPass ? (
              <Button
                disabled={controlsDisabled}
                onClick={() => dispatchAction({ type: "doudizhu.pass" })}
                variant="secondary"
              >
                不出
              </Button>
            ) : null}
            <Button
              disabled={
                controlsDisabled ||
                !view.legalActions.canPlay ||
                selectedIds.length === 0 ||
                !selectionLegal
              }
              onClick={() => dispatchAction({ type: "doudizhu.play", cardIds: [...selectedIds] })}
              variant="primary"
            >
              出牌
              {selectedPattern ? ` · ${PATTERN_NAMES[selectedPattern.kind]}` : ""}
            </Button>
          </>
        ) : null}
      </div>

      <div className="doudizhu-hand" aria-label="你的手牌" role="list">
        {view.viewerSeatId === null ? (
          <div className="doudizhu-spectator-note">
            <Eye aria-hidden="true" size={21} />
            观战中 · 暗牌仅显示数量
          </div>
        ) : (
          sortDoudizhuCards(view.viewerHand).map((card) => (
            <PlayingCard
              card={card}
              disabled={!view.legalActions.canPlay || controlsDisabled}
              key={card.id}
              onClick={() => toggleCard(card.id)}
              selected={selectedIds.includes(card.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function PlayingCard({
  card,
  compact = false,
  selected = false,
  disabled = false,
  onClick,
}: {
  readonly card: DoudizhuCard;
  readonly compact?: boolean;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}) {
  const joker = card.rank.endsWith("joker");
  const red = joker
    ? card.rank === "big-joker"
    : card.suit === "hearts" || card.suit === "diamonds";
  const rank =
    card.rank === "small-joker" ? "小王" : card.rank === "big-joker" ? "大王" : card.rank;
  const suit = card.suit === null ? "★" : SUIT_SYMBOLS[card.suit];
  const className = [
    "doudizhu-card",
    compact ? "is-compact" : "",
    selected ? "is-selected" : "",
    red ? "is-red" : "",
    joker ? "is-joker" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const content = (
    <>
      <span className="doudizhu-card__rank">{rank}</span>
      <span className="doudizhu-card__suit">{suit}</span>
      {!compact && !joker ? <span className="doudizhu-card__center">{suit}</span> : null}
    </>
  );
  if (!onClick) {
    return (
      <span aria-label={`${rank}${card.suit === null ? "" : suit}`} className={className}>
        {content}
      </span>
    );
  }
  return (
    <button
      aria-pressed={selected}
      className={className}
      disabled={disabled}
      onClick={onClick}
      role="listitem"
      type="button"
    >
      {content}
    </button>
  );
}

function CardBack({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span aria-hidden="true" className={`doudizhu-card-back${compact ? " is-compact" : ""}`} />
  );
}

function OutcomePanel({
  view,
  seats,
}: {
  readonly view: DoudizhuView;
  readonly seats: readonly GameSeatPresentationV1[];
}) {
  const outcome = view.outcome;
  if (!outcome) return null;
  return (
    <section aria-label="本局结算" className="doudizhu-outcome">
      <span className="doudizhu-outcome__eyebrow">
        {outcome.spring === "landlord"
          ? "地主春天"
          : outcome.spring === "farmers"
            ? "农民反春"
            : "本局结束"}
      </span>
      <h2>{outcome.winnerSide === "landlord" ? "地主获胜" : "农民获胜"}</h2>
      <strong>公共倍数 ×{outcome.commonMultiplier}</strong>
      <ul>
        {outcome.scores.map((entry) => (
          <li key={entry.seatId}>
            <span>{seatDisplayName(view, entry.seatId, seats)}</span>
            <b className={entry.score > 0 ? "is-positive" : "is-negative"}>
              {entry.score > 0 ? "+" : ""}
              {entry.score}
            </b>
          </li>
        ))}
      </ul>
    </section>
  );
}

function statusText(view: DoudizhuView, seats: readonly GameSeatPresentationV1[]): string {
  if (view.outcome) return view.outcome.winnerSide === "landlord" ? "地主拿下本局" : "农民合作获胜";
  if (view.activeSeatId === view.viewerSeatId) return "轮到你了";
  if (view.activeSeatId !== null) {
    return `等待 ${seatDisplayName(view, view.activeSeatId, seats)} 操作`;
  }
  return "牌局已结束";
}

function phasePrompt(view: DoudizhuView): string {
  if (view.phase === "bidding") return "叫地主阶段";
  if (view.phase === "open_hand") return "地主正在选择是否明牌";
  if (view.phase === "doubling") return "加倍阶段";
  return "本局结算";
}

function seatLabel(view: DoudizhuView, seatId: string): string {
  if (seatId === view.viewerSeatId) return "你";
  const viewerIndex = view.seats.findIndex((seat) => seat.seatId === view.viewerSeatId);
  const seatIndex = view.seats.findIndex((seat) => seat.seatId === seatId);
  if (viewerIndex >= 0 && seatIndex >= 0) {
    return (seatIndex - viewerIndex + 3) % 3 === 1 ? "下家" : "上家";
  }
  return `座位 ${seatIndex + 1}`;
}

function seatDisplayName(
  view: DoudizhuView,
  seatId: string,
  seats: readonly GameSeatPresentationV1[],
): string {
  return (
    seats.find((seat) => seat.seatId === seatId)?.occupant?.displayName ?? seatLabel(view, seatId)
  );
}

function seatPositions(
  view: DoudizhuView,
): readonly { readonly seat: DoudizhuView["seats"][number]; readonly position: string }[] {
  const viewerIndex = view.seats.findIndex((seat) => seat.seatId === view.viewerSeatId);
  if (viewerIndex < 0) {
    return [
      { seat: view.seats[0] as DoudizhuView["seats"][number], position: "left" },
      { seat: view.seats[1] as DoudizhuView["seats"][number], position: "top" },
      { seat: view.seats[2] as DoudizhuView["seats"][number], position: "right" },
    ];
  }
  return [
    { seat: view.seats[viewerIndex] as DoudizhuView["seats"][number], position: "bottom" },
    {
      seat: view.seats[(viewerIndex + 1) % 3] as DoudizhuView["seats"][number],
      position: "right",
    },
    {
      seat: view.seats[(viewerIndex + 2) % 3] as DoudizhuView["seats"][number],
      position: "left",
    },
  ];
}
