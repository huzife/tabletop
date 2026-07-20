import type { GameViewPropsV1 } from "@tabletop/game-sdk/web";
import { Button } from "@tabletop/ui";
import { Check, Flag, Handshake, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GomokuAction } from "../shared/actions.js";
import type { GomokuDisplayEvent, GomokuView } from "../shared/view.js";

export function GomokuGameView({
  view,
  dispatchAction,
  actionPending,
  connectionState,
  readOnly,
}: GameViewPropsV1<GomokuView, GomokuAction, GomokuDisplayEvent>) {
  const [elapsedDisplayMs, setElapsedDisplayMs] = useState(0);
  useEffect(() => {
    setElapsedDisplayMs(0);
    if (view.moveRemainingMs === null || view.phase !== "playing") return undefined;
    const timer = window.setInterval(() => setElapsedDisplayMs((elapsed) => elapsed + 250), 250);
    return () => window.clearInterval(timer);
  }, [view.moveRemainingMs, view.phase, view.revision, view.serverNowMonotonicMs]);

  const forbidden = useMemo(
    () => new Set(view.forbiddenMoves.map(({ x, y }) => `${x}:${y}`)),
    [view.forbiddenMoves],
  );
  const winning = useMemo(
    () => new Set(view.winningCells.map(({ x, y }) => `${x}:${y}`)),
    [view.winningCells],
  );
  const lastMoveKey = view.lastMove === null ? null : `${view.lastMove.x}:${view.lastMove.y}`;
  const controlsDisabled = actionPending || readOnly || connectionState !== "connected";
  const pendingOffer = view.pendingOffer;
  const isOfferResponder =
    pendingOffer !== null && pendingOffer.responderSeatId === view.viewer.seatId;

  return (
    <div className="gomoku-game">
      <main className="gomoku-board-column">
        <div aria-label="五子棋棋盘" className="gomoku-board" role="grid">
          {view.board.map((cell, index) => {
            const x = index % view.boardSize;
            const y = Math.floor(index / view.boardSize);
            const key = `${x}:${y}`;
            const isForbidden = forbidden.has(key);
            const cannotPlaceForbidden = view.viewer.color === "black" && isForbidden;
            const interactive =
              view.legalActions.canPlace &&
              cell === 0 &&
              !cannotPlaceForbidden &&
              !controlsDisabled;
            const classNames = [
              "gomoku-point",
              cell === 1 ? "has-black" : "",
              cell === 2 ? "has-white" : "",
              lastMoveKey === key ? "is-last" : "",
              winning.has(key) ? "is-winning" : "",
              isForbidden ? "is-forbidden" : "",
              interactive ? "is-interactive" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <button
                aria-label={pointLabel(x, y, cell, isForbidden)}
                className={classNames}
                disabled={!interactive}
                key={key}
                onClick={() => dispatchAction({ type: "gomoku.place", x, y })}
                role="gridcell"
                title={isForbidden ? "黑方禁手" : undefined}
                type="button"
              >
                <span aria-hidden="true" className="gomoku-point__horizontal" />
                <span aria-hidden="true" className="gomoku-point__vertical" />
                {cell !== 0 ? <span aria-hidden="true" className="gomoku-stone" /> : null}
                {cell === 0 && isForbidden ? (
                  <span aria-hidden="true" className="gomoku-forbidden-mark">
                    ×
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </main>

      <aside className="gomoku-sidebar">
        <header className="gomoku-match-header">
          <div>
            <span className="gomoku-match-header__label">第 {view.moves.length + 1} 手</span>
            <strong>{statusText(view)}</strong>
          </div>
          <span className={`gomoku-connection gomoku-connection--${connectionState}`}>
            {connectionText(connectionState)}
          </span>
        </header>

        <div className="gomoku-players">
          {view.players.map((player) => {
            const isCurrent = view.turn === player.color && view.phase !== "ended";
            const projectedRemaining =
              isCurrent && player.totalRemainingMs !== null
                ? Math.max(0, player.totalRemainingMs - elapsedDisplayMs)
                : player.totalRemainingMs;
            return (
              <section
                className={isCurrent ? "gomoku-player is-current" : "gomoku-player"}
                key={player.seatId}
              >
                <span className={`gomoku-player__stone gomoku-player__stone--${player.color}`} />
                <div>
                  <strong>
                    {player.seatId === view.viewer.seatId
                      ? "你"
                      : player.color === "black"
                        ? "黑方"
                        : "白方"}
                  </strong>
                  <span>{player.color === "black" ? "黑棋" : "白棋"}</span>
                </div>
                {projectedRemaining === null ? null : (
                  <time>{formatDuration(projectedRemaining)}</time>
                )}
              </section>
            );
          })}
        </div>

        {view.moveRemainingMs === null || view.phase === "ended" ? null : (
          <div className="gomoku-step-clock">
            <span>本步</span>
            <strong>{formatDuration(Math.max(0, view.moveRemainingMs - elapsedDisplayMs))}</strong>
          </div>
        )}

        {pendingOffer === null ? null : (
          <section className="gomoku-offer" aria-live="polite">
            <strong>{pendingOffer.kind === "undo" ? "悔棋申请" : "和棋提议"}</strong>
            <span>{isOfferResponder ? "等待你的决定" : "等待对方回应"}</span>
            {isOfferResponder ? (
              <div className="gomoku-offer__actions">
                <Button
                  disabled={controlsDisabled}
                  onClick={() =>
                    dispatchAction({
                      type:
                        pendingOffer.kind === "undo"
                          ? "gomoku.undo.respond"
                          : "gomoku.draw.respond",
                      accept: true,
                    })
                  }
                  variant="primary"
                >
                  <Check aria-hidden="true" size={17} />
                  同意
                </Button>
                <Button
                  disabled={controlsDisabled}
                  onClick={() =>
                    dispatchAction({
                      type:
                        pendingOffer.kind === "undo"
                          ? "gomoku.undo.respond"
                          : "gomoku.draw.respond",
                      accept: false,
                    })
                  }
                  variant="secondary"
                >
                  <X aria-hidden="true" size={17} />
                  拒绝
                </Button>
              </div>
            ) : null}
          </section>
        )}

        <div className="gomoku-actions">
          <Button
            disabled={controlsDisabled || !view.legalActions.canRequestUndo}
            onClick={() => dispatchAction({ type: "gomoku.undo.request" })}
            variant="secondary"
          >
            <RotateCcw aria-hidden="true" size={17} />
            悔棋
          </Button>
          <Button
            disabled={controlsDisabled || !view.legalActions.canOfferDraw}
            onClick={() => dispatchAction({ type: "gomoku.draw.offer" })}
            variant="secondary"
          >
            <Handshake aria-hidden="true" size={17} />
            求和
          </Button>
          <Button
            disabled={controlsDisabled || !view.legalActions.canResign}
            onClick={() => dispatchAction({ type: "gomoku.resign" })}
            variant="danger"
          >
            <Flag aria-hidden="true" size={17} />
            认输
          </Button>
        </div>
      </aside>
    </div>
  );
}

function statusText(view: GomokuView): string {
  if (view.outcome !== null) {
    if (view.outcome.winnerSeatId === null) return "本局和棋";
    return view.outcome.winnerSeatId === view.viewer.seatId ? "你已获胜" : "本局已结束";
  }
  if (view.phase === "undo_pending") return "等待悔棋回应";
  if (view.turn === view.viewer.color) return "轮到你落子";
  return view.turn === "black" ? "黑方回合" : "白方回合";
}

function connectionText(state: "connected" | "reconnecting" | "offline"): string {
  if (state === "connected") return "已连接";
  if (state === "reconnecting") return "重连中";
  return "已离线";
}

function pointLabel(x: number, y: number, cell: 0 | 1 | 2, forbidden: boolean): string {
  const occupancy =
    cell === 1 ? "黑棋" : cell === 2 ? "白棋" : forbidden ? "空位，黑方禁手" : "空位";
  return `${x + 1} 列 ${y + 1} 行，${occupancy}`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
