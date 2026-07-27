import { Button } from "@tabletop/ui";
import { Crosshair, Flag, LoaderCircle, Wifi, WifiOff } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  GameConnectionStateV1,
  GameViewPropsV1,
  ReceivedGameTransientEventV1,
} from "@tabletop/game-sdk/web";

import { simulateBilliardsShot } from "../physics/browser.js";
import { billiardsSceneAsset } from "../physics/scene-assets.js";
import type {
  BilliardsAction,
  BilliardsBreakChoice,
  BilliardsDecidingBlackChoice,
  BilliardsSelectableGroup,
  BilliardsShot,
  CueTip,
  SnookerColor,
} from "../shared/actions.js";
import type { BilliardsMode } from "../shared/settings.js";
import { formatBilliardsMode } from "../shared/settings.js";
import type {
  BilliardsBall,
  BilliardsDisplayEvent,
  BilliardsPendingDecisionView,
  BilliardsShotDisplayEvent,
  BilliardsView,
} from "../shared/view.js";
import { billiardsAimPreviewSchema, type BilliardsAimPreview } from "../shared/transient.js";
import {
  constrainCueTip,
  cueTipFromPointer,
  describeCueTip,
  normalizeDegrees,
  nudgeCueTip,
} from "./controls.js";
import {
  drawBilliardsTable,
  tableGeometry,
  tablePointFromClient,
  type CanvasBall,
  type TablePoint,
} from "./canvas.js";
import {
  drawBilliardsTableScene,
  loadBilliardsTableScene,
  type LoadedBilliardsTableScene,
} from "./table-scene.js";

const SNOOKER_COLORS: readonly { readonly label: string; readonly value: SnookerColor }[] = [
  { label: "黄", value: "yellow" },
  { label: "绿", value: "green" },
  { label: "棕", value: "brown" },
  { label: "蓝", value: "blue" },
  { label: "粉", value: "pink" },
  { label: "黑", value: "black" },
];

const COLOR_LABELS: Readonly<Record<SnookerColor, string>> = {
  black: "黑球",
  blue: "蓝球",
  brown: "棕球",
  green: "绿球",
  pink: "粉球",
  yellow: "黄球",
};

const FOUL_LABELS: Readonly<Record<string, string>> = {
  CUE_BALL_POTTED: "母球落袋",
  EIGHT_BALL_POTTED_EARLY: "八球提前落袋",
  EIGHT_BALL_POTTED_ON_FOUL: "犯规击入八球",
  ILLEGAL_BREAK: "开球不合法",
  ILLEGAL_JUMP: "非法跳球",
  JUMP_SHOT: "跳球犯规",
  NO_BALL_CONTACT: "未碰到球",
  NO_OBJECT_CONTACT: "未碰到目标球",
  NO_RAIL_OR_POCKET: "无球触库或落袋",
  WRONG_BALL_POTTED: "击入非目标球",
  WRONG_FIRST_CONTACT: "首次碰球错误",
};

const BREAK_CHOICE_LABELS: Readonly<Record<BilliardsBreakChoice, string>> = {
  "accept-table": "接受台面",
  "rerack-opponent": "重摆·原开球者开球",
  "rerack-self": "重摆·选择者开球",
  "spot-eight": "复位8号继续",
  "take-line-in-hand": "线后手中球",
};

const BREAK_REASON_LABELS: Readonly<
  Record<
    Extract<NonNullable<BilliardsPendingDecisionView>, { type: "break-choice" }>["reason"],
    string
  >
> = {
  "break-foul": "开球犯规",
  "eight-on-break": "开球进 8 号球",
  "eight-on-break-foul": "开球进 8 号球且犯规",
  "illegal-break": "非法开球",
};

const GROUP_LABELS: Readonly<Record<BilliardsSelectableGroup, string>> = {
  solids: "全色",
  stripes: "花色",
};

const DECIDING_BLACK_CHOICE_LABELS: Readonly<Record<BilliardsDecidingBlackChoice, string>> = {
  defer: "由对手先打",
  "play-self": "由我先打",
};

type PlaybackFrame = {
  readonly atMs: number;
  readonly balls: readonly CanvasBall[];
};

type PlaybackItem = {
  readonly event: BilliardsShotDisplayEvent;
  readonly frames: readonly PlaybackFrame[];
};

type RawPlaybackBall = Pick<BilliardsBall, "id" | "pocketed" | "rotation" | "x" | "y"> & {
  readonly z?: number;
};

type RawPlaybackFrame = {
  readonly atMs: number;
  readonly balls: readonly RawPlaybackBall[];
};

type TableSceneLoadState =
  | {
      readonly mode: BilliardsMode;
      readonly status: "error" | "loading";
    }
  | {
      readonly mode: BilliardsMode;
      readonly scene: LoadedBilliardsTableScene;
      readonly status: "ready";
    };

export function BilliardsGameView({
  actionPending,
  connectionState,
  dispatchAction,
  dispatchTransientEvent,
  displayEvents,
  readOnly,
  transientEvent,
  view,
}: GameViewPropsV1<BilliardsView, BilliardsAction, BilliardsDisplayEvent>) {
  const { animatedBalls, isAnimating } = useBilliardsPlayback(displayEvents);
  const [power, setPower] = useState(58);
  const [elevation, setElevation] = useState(0);
  const [tip, setTip] = useState<CueTip>({ x: 0, y: 0 });
  const [angle, setAngle] = useState(() => defaultAimAngle(view));
  const [controlsShotNumber, setControlsShotNumber] = useState(view.shotNumber);
  const [nominatedColor, setNominatedColor] = useState<SnookerColor>("black");
  const disabled = actionPending || readOnly || connectionState !== "connected" || isAnimating;
  const shotControlsDisabled = disabled || !view.legalActions.canShoot;
  const cuePlacementEnabled =
    !disabled && view.phase === "ball_in_hand" && view.legalActions.canPlaceCue;
  const aimEnabled = !disabled && view.phase === "aiming" && view.legalActions.canShoot;
  const balls = animatedBalls ?? view.balls;
  const pendingDecision = view.pendingDecision ?? null;
  const opponentAim = opponentAimPreview(view, transientEvent, isAnimating);
  const localAim =
    controlsShotNumber === view.shotNumber
      ? { angle, elevation, power, tip }
      : { angle: defaultAimAngle(view), elevation: 0, power: 58, tip: { x: 0, y: 0 } };
  const displayedAim = opponentAim ?? localAim;

  useAimPreviewBroadcast({
    angle: localAim.angle,
    elevation: localAim.elevation,
    enabled: aimEnabled && !view.practice && dispatchTransientEvent !== undefined,
    power: localAim.power,
    send: dispatchTransientEvent,
    shotNumber: view.shotNumber,
    tip: localAim.tip,
  });

  useLayoutEffect(() => {
    setAngle(defaultAimAngle(view));
    setTip({ x: 0, y: 0 });
    setPower(58);
    setElevation(0);
    setControlsShotNumber(view.shotNumber);
  }, [view.mode, view.shotNumber]);

  useEffect(() => {
    if (view.snookerOn === "color") return;
    setNominatedColor("black");
  }, [view.snookerOn]);

  const shoot = () => {
    const shot: BilliardsShot = {
      angle: normalizeAngle(localAim.angle),
      elevation: localAim.elevation,
      nominatedColor: view.mode === "snooker" && view.snookerOn === "color" ? nominatedColor : null,
      power: localAim.power,
      tip: constrainCueTip(localAim.tip.x, localAim.tip.y),
    };
    dispatchAction({ type: "billiards.shoot", shot });
  };

  return (
    <div className="billiards-game">
      <div className="billiards-layout">
        <main className="billiards-table-zone">
          <BilliardsCanvas
            aimAngle={displayedAim.angle}
            aimEnabled={aimEnabled}
            aimVisible={aimEnabled || opponentAim !== null}
            balls={balls}
            elevation={displayedAim.elevation}
            mode={view.mode}
            onAimAngleChange={setAngle}
            onPlaceCue={(point) => dispatchAction({ type: "billiards.place-cue", ...point })}
            placementEnabled={cuePlacementEnabled}
            showOutcome={!isAnimating}
            table={view.table}
            tip={displayedAim.tip}
            view={view}
          />
        </main>

        <aside className="billiards-panel">
          <header className="billiards-panel__header">
            <div>
              <span className="billiards-panel__eyebrow">
                {formatBilliardsMode(view.mode)}
                {view.practice ? " · 单人练习" : ""} · 第 {view.shotNumber + 1} 杆
              </span>
              <strong>{phaseLabel(view)}</strong>
            </div>
            <ConnectionStatus state={connectionState} />
          </header>

          <section
            className="billiards-players"
            aria-label={view.practice ? "练习统计" : "玩家比分"}
          >
            {view.players.map((player, index) => (
              <div
                className={player.active ? "billiards-player is-active" : "billiards-player"}
                key={player.seatId}
              >
                <span
                  className={
                    index === 0
                      ? "billiards-player__mark is-amber"
                      : "billiards-player__mark is-teal"
                  }
                />
                <span className="billiards-player__name">
                  <strong>
                    {player.seatId === view.viewerSeatId ? "你" : `玩家 ${index + 1}`}
                  </strong>
                  <small>
                    {view.practice ? "连续击球" : playerGroupLabel(view.mode, player.group)}
                  </small>
                </span>
                <strong className="billiards-player__score">{player.score}</strong>
              </div>
            ))}
          </section>

          {pendingDecision === null ? (
            <section
              className="billiards-controls"
              aria-label={opponentAim === null ? "击球参数" : "对手击球参数"}
            >
              {opponentAim !== null ? (
                <div aria-live="polite" className="billiards-opponent-aim">
                  <span>
                    <Crosshair aria-hidden="true" size={14} />
                    {view.viewerSeatId === null ? "当前玩家正在瞄准" : "对手正在瞄准"}
                  </span>
                  <output>
                    方向 {Math.round(normalizeDegrees((opponentAim.angle * 180) / Math.PI))}°
                  </output>
                </div>
              ) : null}
              <RangeControl
                disabled={shotControlsDisabled}
                id="billiards-power"
                label="力度"
                max={100}
                min={1}
                onChange={setPower}
                suffix="%"
                value={displayedAim.power}
              />
              <TipSelector
                disabled={shotControlsDisabled}
                onChange={setTip}
                value={displayedAim.tip}
              />
              <RangeControl
                disabled={shotControlsDisabled}
                id="billiards-elevation"
                label="抬杆角"
                max={90}
                min={0}
                onChange={setElevation}
                suffix="°"
                value={displayedAim.elevation}
              />
              {!view.practice && view.mode === "snooker" && view.snookerOn === "color" ? (
                <ColorNomination
                  disabled={shotControlsDisabled}
                  onChange={setNominatedColor}
                  value={nominatedColor}
                />
              ) : null}
            </section>
          ) : (
            <DecisionPanel
              decision={pendingDecision}
              interactionDisabled={disabled}
              onBreakChoice={(choice) => dispatchAction({ choice, type: "billiards.break-choice" })}
              onChooseGroup={(group) => dispatchAction({ group, type: "billiards.choose-group" })}
              onDecidingBlackChoice={(choice) =>
                dispatchAction({ choice, type: "billiards.deciding-black-choice" })
              }
              view={view}
            />
          )}

          <div
            className={view.practice ? "billiards-action-row is-practice" : "billiards-action-row"}
          >
            <Button
              className="billiards-shoot"
              disabled={disabled || !view.legalActions.canShoot}
              onClick={shoot}
              variant="primary"
            >
              {actionPending ? (
                <LoaderCircle aria-hidden="true" className="is-spinning" size={17} />
              ) : (
                <Crosshair aria-hidden="true" size={17} />
              )}
              <span>出杆</span>
            </Button>
            {!view.practice ? (
              <Button
                className="billiards-resign"
                disabled={disabled || !view.legalActions.canResign}
                onClick={() => dispatchAction({ type: "billiards.resign" })}
                variant="danger"
              >
                <Flag aria-hidden="true" size={16} />
                <span>认输</span>
              </Button>
            ) : null}
          </div>

          <div aria-live="polite" className="billiards-notice">
            {view.outcome === null ? noticeLabel(view) : outcomeLabel(view)}
          </div>
        </aside>
      </div>
    </div>
  );
}

function DecisionPanel({
  decision,
  interactionDisabled,
  onBreakChoice,
  onChooseGroup,
  onDecidingBlackChoice,
  view,
}: {
  readonly decision: NonNullable<BilliardsPendingDecisionView>;
  readonly interactionDisabled: boolean;
  readonly onBreakChoice: (choice: BilliardsBreakChoice) => void;
  readonly onChooseGroup: (group: BilliardsSelectableGroup) => void;
  readonly onDecidingBlackChoice: (choice: BilliardsDecidingBlackChoice) => void;
  readonly view: BilliardsView;
}) {
  const enabled = canActOnDecision(view, decision, interactionDisabled);
  const isChooser = decision.chooserSeatId === view.viewerSeatId;
  return (
    <section aria-label="比赛决策" className="billiards-decision">
      <header>
        <strong>
          {decision.type === "break-choice"
            ? "开球裁定"
            : decision.type === "choose-group"
              ? "选择球组"
              : "决胜黑球"}
        </strong>
        <span>{isChooser ? "等待你的决定" : "等待指定玩家决定"}</span>
      </header>
      {decision.type === "break-choice" ? (
        <>
          <p>{breakDecisionReasonLabel(decision.reason)}</p>
          <div className="billiards-decision__actions">
            {decision.choices.map((choice) => (
              <Button
                disabled={!enabled}
                key={choice}
                onClick={() => onBreakChoice(choice)}
                variant="secondary"
              >
                {breakChoiceLabel(choice, decision.reason)}
              </Button>
            ))}
          </div>
        </>
      ) : decision.type === "choose-group" ? (
        <div className="billiards-decision__actions is-groups">
          {decision.groups.map((group) => (
            <Button
              disabled={!enabled}
              key={group}
              onClick={() => onChooseGroup(group)}
              variant="secondary"
            >
              {GROUP_LABELS[group]}
            </Button>
          ))}
        </div>
      ) : (
        <>
          <p>掷币胜者选择决胜黑球先手</p>
          <div className="billiards-decision__actions is-groups">
            {decision.choices.map((choice) => (
              <Button
                disabled={!enabled}
                key={choice}
                onClick={() => onDecidingBlackChoice(choice)}
                variant="secondary"
              >
                {DECIDING_BLACK_CHOICE_LABELS[choice]}
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function BilliardsCanvas({
  aimAngle,
  aimEnabled,
  aimVisible,
  balls,
  elevation,
  mode,
  onAimAngleChange,
  onPlaceCue,
  placementEnabled,
  showOutcome,
  table,
  tip,
  view,
}: {
  readonly aimAngle: number;
  readonly aimEnabled: boolean;
  readonly aimVisible: boolean;
  readonly balls: readonly CanvasBall[];
  readonly elevation: number;
  readonly mode: BilliardsMode;
  readonly onAimAngleChange: (angle: number) => void;
  readonly onPlaceCue: (point: TablePoint) => void;
  readonly placementEnabled: boolean;
  readonly showOutcome: boolean;
  readonly table: BilliardsView["table"];
  readonly tip: CueTip;
  readonly view: BilliardsView;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ height: 1, width: 1 });
  const [pixelRatio, setPixelRatio] = useState(() =>
    typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1),
  );
  const [hoverPoint, setHoverPoint] = useState<TablePoint | undefined>();
  const [tableSceneState, setTableSceneState] = useState<TableSceneLoadState | undefined>();
  const pointerRef = useRef<{ id: number; mode: "aim" | "place" } | null>(null);
  const sceneRequired = billiardsSceneAsset(mode) !== undefined;
  const activeSceneState = tableSceneState?.mode === mode ? tableSceneState : undefined;
  const tableScene = activeSceneState?.status === "ready" ? activeSceneState.scene : undefined;
  const tableSceneReady = !sceneRequired || tableScene !== undefined;
  const canvasInteractive = tableSceneReady && (aimEnabled || placementEnabled);
  const geometry = useMemo(
    () => tableGeometry(size.width, size.height, table),
    [size.height, size.width, table],
  );
  const cueRadius = table.ballDiameter / 2;
  const placementValid =
    hoverPoint === undefined ? false : isCuePlacementValid(hoverPoint, view, cueRadius);

  useEffect(() => {
    if (!sceneRequired) {
      setTableSceneState(undefined);
      return undefined;
    }
    let active = true;
    setTableSceneState({ mode, status: "loading" });
    void loadBilliardsTableScene(mode)
      .then((scene) => {
        if (!active) return;
        if (scene === undefined) {
          setTableSceneState({ mode, status: "error" });
          return;
        }
        setTableSceneState({ mode, scene, status: "ready" });
      })
      .catch(() => {
        if (active) setTableSceneState({ mode, status: "error" });
      });
    return () => {
      active = false;
    };
  }, [mode, sceneRequired]);

  useEffect(() => {
    if (!placementEnabled) {
      setHoverPoint(undefined);
      return;
    }
    setHoverPoint((current) => current ?? defaultCuePlacement(view, cueRadius));
  }, [cueRadius, placementEnabled, view]);

  useEffect(() => {
    if (!aimEnabled && !placementEnabled) pointerRef.current = null;
  }, [aimEnabled, placementEnabled]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const measure = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      setSize({ height: bounds.height, width: bounds.width });
    };
    measure();
    window.addEventListener("resize", measure);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    const updatePixelRatio = () => setPixelRatio(Math.max(1, window.devicePixelRatio || 1));
    window.addEventListener("resize", updatePixelRatio);
    if (typeof window.matchMedia !== "function") {
      return () => window.removeEventListener("resize", updatePixelRatio);
    }
    const resolution = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    resolution.addEventListener("change", updatePixelRatio);
    return () => {
      resolution.removeEventListener("change", updatePixelRatio);
      window.removeEventListener("resize", updatePixelRatio);
    };
  }, [pixelRatio]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = pixelRatio;
    const backingWidth = Math.max(1, Math.round(size.width * dpr));
    const backingHeight = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBilliardsTable(context, geometry, table, mode, balls, aimAngle, elevation, tip, {
      aimEnabled: aimVisible,
      requiredTableBackground: sceneRequired,
      tableBackgroundMessage:
        activeSceneState?.status === "error" ? "球桌场景加载失败，请刷新重试" : "球桌场景加载中…",
      placementValid,
      ...(tableScene === undefined
        ? {}
        : {
            drawTableBackground: (
              drawContext: CanvasRenderingContext2D,
              drawGeometry: typeof geometry,
            ) => drawBilliardsTableScene(drawContext, drawGeometry, tableScene),
          }),
      ...(placementEnabled && hoverPoint !== undefined ? { placementPoint: hoverPoint } : {}),
    });
  }, [
    aimAngle,
    aimEnabled,
    aimVisible,
    balls,
    elevation,
    geometry,
    hoverPoint,
    mode,
    placementEnabled,
    placementValid,
    pixelRatio,
    sceneRequired,
    size,
    table,
    activeSceneState?.status,
    tableScene,
    tip,
  ]);

  const pointAt = (event: React.PointerEvent<HTMLCanvasElement>): TablePoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return tablePointFromClient(event.clientX, event.clientY, bounds, geometry);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasInteractive) return;
    const point = pointAt(event);
    if (placementEnabled) setHoverPoint(point);
    if (pointerRef.current?.mode === "aim") {
      const cue = balls.find((ball) => ball.kind === "cue" && !ball.pocketed);
      if (cue !== undefined) onAimAngleChange(Math.atan2(point.y - cue.y, point.x - cue.x));
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasInteractive || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const modeForPointer = placementEnabled ? "place" : "aim";
    pointerRef.current = { id: event.pointerId, mode: modeForPointer };
    const point = pointAt(event);
    if (modeForPointer === "place") setHoverPoint(point);
    const cue = balls.find((ball) => ball.kind === "cue" && !ball.pocketed);
    if (modeForPointer === "aim" && cue !== undefined) {
      onAimAngleChange(Math.atan2(point.y - cue.y, point.x - cue.x));
    }
  };

  const releasePointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current?.id !== event.pointerId) return;
    const pointerMode = pointerRef.current.mode;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointerMode === "place" && placementEnabled) {
      const point = pointAt(event);
      if (isCuePlacementValid(point, view, cueRadius)) onPlaceCue(point);
      setHoverPoint(undefined);
    }
  };

  const cancelPointer = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current?.id !== event.pointerId) return;
    pointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setHoverPoint(undefined);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (!canvasInteractive) return;
    if (aimEnabled && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      onAimAngleChange(aimAngle + (event.key === "ArrowLeft" ? -Math.PI / 36 : Math.PI / 36));
    }
    if (placementEnabled && event.key.startsWith("Arrow")) {
      const point = hoverPoint ?? defaultCuePlacement(view, cueRadius);
      if (point === undefined) return;
      event.preventDefault();
      const step = table.ballDiameter / 2;
      const delta = {
        x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
        y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
      };
      setHoverPoint({
        x: Math.min(table.width - cueRadius, Math.max(cueRadius, point.x + delta.x)),
        y: Math.min(table.height - cueRadius, Math.max(cueRadius, point.y + delta.y)),
      });
    }
    if (placementEnabled && event.key === "Enter") {
      const point = hoverPoint ?? defaultCuePlacement(view, cueRadius);
      if (point !== undefined && isCuePlacementValid(point, view, cueRadius)) {
        event.preventDefault();
        onPlaceCue(point);
        setHoverPoint(undefined);
      }
    }
  };

  return (
    <div className="billiards-table-frame">
      <canvas
        aria-label={
          !tableSceneReady
            ? activeSceneState?.status === "error"
              ? "台球桌场景加载失败"
              : "台球桌场景加载中"
            : placementEnabled
              ? "台球桌，使用方向键选择母球位置，按回车确认"
              : aimEnabled
                ? "台球桌，使用左右方向键调整瞄准方向"
                : "台球桌"
        }
        className={canvasInteractive ? "billiards-canvas is-interactive" : "billiards-canvas"}
        onKeyDown={handleKeyDown}
        onPointerCancel={cancelPointer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={releasePointer}
        ref={canvasRef}
        role={canvasInteractive ? "application" : "img"}
        tabIndex={canvasInteractive ? 0 : -1}
      />
      {showOutcome && view.outcome !== null ? (
        <div aria-hidden="true" className="billiards-outcome">
          {outcomeLabel(view)}
        </div>
      ) : null}
    </div>
  );
}

function RangeControl({
  disabled,
  id,
  label,
  max,
  min,
  onChange,
  suffix,
  value,
}: {
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly suffix: string;
  readonly value: number;
}) {
  return (
    <label className="billiards-range" htmlFor={id}>
      <span>
        <strong>{label}</strong>
        <output htmlFor={id}>
          {value}
          {suffix}
        </output>
      </span>
      <input
        aria-label={label}
        disabled={disabled}
        id={id}
        max={max}
        min={min}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
        type="range"
        value={value}
      />
    </label>
  );
}

function TipSelector({
  disabled,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (value: CueTip) => void;
  readonly value: CueTip;
}) {
  const pointerId = useRef<number | null>(null);
  const updateFromPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onChange(cueTipFromPointer(event.clientX, event.clientY, bounds));
  };
  return (
    <div className="billiards-tip-control">
      <div className="billiards-control-heading">
        <strong>击球点</strong>
        <output>{describeCueTip(value)}</output>
      </div>
      <button
        aria-label={`击球点：${describeCueTip(value)}；使用方向键调整，Home 键回中`}
        className="billiards-tip-selector"
        disabled={disabled}
        onKeyDown={(event) => {
          const next = nudgeCueTip(value, event.key);
          if (next.x !== value.x || next.y !== value.y) event.preventDefault();
          onChange(next);
        }}
        onPointerCancel={(event) => {
          if (pointerId.current === event.pointerId) pointerId.current = null;
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          pointerId.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (!disabled && pointerId.current === event.pointerId) updateFromPointer(event);
        }}
        onPointerUp={(event) => {
          if (pointerId.current === event.pointerId) {
            pointerId.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        role="application"
        type="button"
      >
        <span aria-hidden="true" className="billiards-tip-selector__ring" />
        <span
          aria-hidden="true"
          className="billiards-tip-selector__dot"
          style={{ left: `${50 + value.x * 50}%`, top: `${50 - value.y * 50}%` }}
        />
      </button>
    </div>
  );
}

function ColorNomination({
  disabled,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (value: SnookerColor) => void;
  readonly value: SnookerColor;
}) {
  return (
    <fieldset className="billiards-color-control" disabled={disabled}>
      <legend>目标彩球</legend>
      <div className="billiards-color-control__options">
        {SNOOKER_COLORS.map((color) => (
          <label
            className={value === color.value ? "is-selected" : ""}
            key={color.value}
            title={COLOR_LABELS[color.value]}
          >
            <input
              checked={value === color.value}
              name="billiards-color"
              onChange={() => onChange(color.value)}
              type="radio"
              value={color.value}
            />
            <span aria-hidden="true" className={`billiards-color-swatch is-${color.value}`} />
            <span>{color.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ConnectionStatus({ state }: { readonly state: GameConnectionStateV1 }) {
  const Icon = state === "connected" ? Wifi : WifiOff;
  return (
    <span className={`billiards-connection is-${state}`} title={connectionLabel(state)}>
      <Icon aria-hidden="true" size={14} />
      <span>{connectionLabel(state)}</span>
    </span>
  );
}

function useBilliardsPlayback(displayEvents: readonly BilliardsDisplayEvent[]): {
  readonly animatedBalls: readonly CanvasBall[] | null;
  readonly isAnimating: boolean;
} {
  const reducedMotion = useReducedMotion();
  const [animatedBalls, setAnimatedBalls] = useState<readonly CanvasBall[] | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const queueRef = useRef<PlaybackItem[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  const mountedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const preparationRef = useRef<Promise<void>>(Promise.resolve());
  const preparationGenerationRef = useRef(0);
  const pendingPreparationsRef = useRef(0);
  const startNextRef = useRef<() => void>(() => undefined);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;

  const cancel = () => {
    preparationGenerationRef.current += 1;
    preparationRef.current = Promise.resolve();
    pendingPreparationsRef.current = 0;
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    queueRef.current = [];
    runningRef.current = false;
    setAnimatedBalls(null);
    setIsAnimating(false);
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    const onVisibilityChange = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      preparationGenerationRef.current += 1;
      preparationRef.current = Promise.resolve();
      pendingPreparationsRef.current = 0;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      queueRef.current = [];
      runningRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (reducedMotion) cancel();
  }, [reducedMotion]);

  startNextRef.current = () => {
    if (
      runningRef.current ||
      !mountedRef.current ||
      reducedRef.current ||
      queueRef.current.length === 0
    ) {
      if (
        mountedRef.current &&
        !runningRef.current &&
        queueRef.current.length === 0 &&
        pendingPreparationsRef.current === 0
      ) {
        setIsAnimating(false);
      }
      return;
    }
    const item = queueRef.current.shift();
    if (item === undefined) return;
    const firstFrame = item.frames[0];
    if (firstFrame === undefined) {
      startNextRef.current();
      return;
    }
    runningRef.current = true;
    setIsAnimating(true);
    setAnimatedBalls(firstFrame.balls);
    const durationMs = Math.max(item.event.durationMs, item.frames.at(-1)?.atMs ?? 0);
    const startedAt = performance.now();
    let frameIndex = 0;
    const tick = (now: number) => {
      if (!mountedRef.current || reducedRef.current) return;
      const elapsed = Math.max(0, now - startedAt);
      while (
        frameIndex + 1 < item.frames.length &&
        (item.frames[frameIndex + 1]?.atMs ?? 0) <= elapsed
      ) {
        frameIndex += 1;
      }
      const current = item.frames[frameIndex];
      if (current !== undefined) setAnimatedBalls(current.balls);
      if (elapsed >= durationMs) {
        frameRef.current = null;
        runningRef.current = false;
        setAnimatedBalls(null);
        if (queueRef.current.length === 0 && pendingPreparationsRef.current === 0) {
          setIsAnimating(false);
        }
        startNextRef.current();
        return;
      }
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    const shotEvents = displayEvents.filter(
      (event): event is BilliardsShotDisplayEvent => event.type === "billiards.shot",
    );
    if (!initializedRef.current) {
      initializedRef.current = true;
      for (const event of shotEvents) seenRef.current.add(eventKey(event));
      return;
    }
    const fresh = shotEvents.filter((event) => {
      const key = eventKey(event);
      if (seenRef.current.has(key)) return false;
      seenRef.current.add(key);
      return true;
    });
    if (fresh.length === 0 || reducedMotion) return;
    const generation = preparationGenerationRef.current;
    pendingPreparationsRef.current += 1;
    setIsAnimating(true);

    const prepare = async () => {
      if (
        generation !== preparationGenerationRef.current ||
        !mountedRef.current ||
        reducedRef.current
      ) {
        return;
      }
      for (const event of fresh) {
        try {
          const result = (await simulateBilliardsShot({
            balls: event.initialBalls,
            captureFrames: true,
            clothRollingFriction: event.clothRollingFriction,
            clothSlidingFriction: event.clothSlidingFriction,
            mode: event.mode,
            shot: event.shot,
          })) as {
            readonly checksum: string;
            readonly frames?: readonly RawPlaybackFrame[];
            readonly physicsVersion: string;
            readonly stateHash: string;
          };
          if (
            generation !== preparationGenerationRef.current ||
            !mountedRef.current ||
            reducedRef.current
          ) {
            return;
          }
          if (
            result.checksum !== event.simulationChecksum ||
            (event.physicsVersion !== null && result.physicsVersion !== event.physicsVersion) ||
            (event.simulationStateHash !== null && result.stateHash !== event.simulationStateHash)
          ) {
            continue;
          }
          const frames = hydrateFrames(event, result.frames ?? []);
          if (frames.length > 0) queueRef.current.push({ event, frames });
        } catch {
          // A malformed historical event should never prevent the authoritative view from rendering.
        }
      }
      if (queueRef.current.length > 0) startNextRef.current();
    };

    const scheduled = preparationRef.current.then(prepare);
    preparationRef.current = scheduled
      .catch(() => undefined)
      .finally(() => {
        if (generation !== preparationGenerationRef.current) return;
        pendingPreparationsRef.current = Math.max(0, pendingPreparationsRef.current - 1);
        if (
          pendingPreparationsRef.current === 0 &&
          queueRef.current.length === 0 &&
          !runningRef.current &&
          mountedRef.current
        ) {
          setIsAnimating(false);
        }
      });
  }, [displayEvents, reducedMotion]);

  return { animatedBalls, isAnimating };
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useAimPreviewBroadcast(options: {
  readonly angle: number;
  readonly elevation: number;
  readonly enabled: boolean;
  readonly power: number;
  readonly send: GameViewPropsV1<
    BilliardsView,
    BilliardsAction,
    BilliardsDisplayEvent
  >["dispatchTransientEvent"];
  readonly shotNumber: number;
  readonly tip: CueTip;
}): void {
  const latestRef = useRef<BilliardsAimPreview>({
    angle: normalizeAngle(options.angle),
    elevation: options.elevation,
    power: options.power,
    shotNumber: options.shotNumber,
    tip: constrainCueTip(options.tip.x, options.tip.y),
    type: "billiards.aim-preview",
  });
  const sendRef = useRef(options.send);
  const timerRef = useRef<number | null>(null);
  const lastSentAtRef = useRef(0);
  sendRef.current = options.send;
  latestRef.current = {
    angle: normalizeAngle(options.angle),
    elevation: options.elevation,
    power: options.power,
    shotNumber: options.shotNumber,
    tip: constrainCueTip(options.tip.x, options.tip.y),
    type: "billiards.aim-preview",
  };

  useEffect(() => {
    if (!options.enabled) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }
    const flush = () => {
      timerRef.current = null;
      lastSentAtRef.current = Date.now();
      sendRef.current?.(latestRef.current);
    };
    const delayMs = Math.max(0, lastSentAtRef.current + 80 - Date.now());
    if (delayMs === 0) flush();
    else if (timerRef.current === null) timerRef.current = window.setTimeout(flush, delayMs);
  }, [
    options.angle,
    options.elevation,
    options.enabled,
    options.power,
    options.shotNumber,
    options.tip.x,
    options.tip.y,
  ]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
}

export function opponentAimPreview(
  view: BilliardsView,
  transientEvent: ReceivedGameTransientEventV1 | null | undefined,
  isAnimating = false,
): BilliardsAimPreview | null {
  if (
    transientEvent === null ||
    transientEvent === undefined ||
    view.practice ||
    isAnimating ||
    view.phase !== "aiming" ||
    view.activeSeatId === null ||
    view.activeSeatId === view.viewerSeatId ||
    transientEvent.senderSeatId !== view.activeSeatId
  ) {
    return null;
  }
  const parsed = billiardsAimPreviewSchema.safeParse(transientEvent.event);
  return parsed.success && parsed.data.shotNumber === view.shotNumber ? parsed.data : null;
}

function eventKey(event: BilliardsShotDisplayEvent): string {
  return `${event.shotNumber}:${event.simulationStateHash ?? event.simulationChecksum}`;
}

function defaultAimAngle(view: BilliardsView): number {
  const cue = view.balls.find((ball) => ball.kind === "cue" && !ball.pocketed);
  if (cue === undefined) return 0;
  const target = view.balls
    .filter((ball) => ball.kind !== "cue" && !ball.pocketed)
    .sort((first, second) => distanceSquared(cue, first) - distanceSquared(cue, second))[0];
  return target === undefined ? 0 : Math.atan2(target.y - cue.y, target.x - cue.x);
}

function distanceSquared(first: BilliardsBall, second: BilliardsBall): number {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

export function isCuePlacementValid(
  point: TablePoint,
  view: BilliardsView,
  radius: number,
): boolean {
  const { table } = view;
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < radius ||
    point.x > table.width - radius ||
    point.y < radius ||
    point.y > table.height - radius
  )
    return false;
  if (view.ballInHandZone === "d") {
    if (table.baulkLineX === null || table.dRadius === null || point.x > table.baulkLineX)
      return false;
    const dx = point.x - table.baulkLineX;
    const dy = point.y - table.height / 2;
    if (dx * dx + dy * dy > table.dRadius ** 2) return false;
  }
  if (
    view.ballInHandZone === "behind-line" &&
    (table.baulkLineX === null || point.x > table.baulkLineX)
  )
    return false;
  if (
    table.pockets.some(
      (pocket) =>
        Math.hypot(point.x - pocket.captureX, point.y - pocket.captureY) < pocket.captureRadius,
    )
  )
    return false;
  return view.balls.every(
    (ball) =>
      ball.kind === "cue" ||
      ball.pocketed ||
      (ball.x - point.x) ** 2 + (ball.y - point.y) ** 2 >= table.ballDiameter ** 2,
  );
}

export function defaultCuePlacement(
  view: BilliardsView,
  radius = view.table.ballDiameter / 2,
): TablePoint | undefined {
  const { table } = view;
  const candidates: TablePoint[] = [];
  if (view.ballInHandZone === "d" && table.baulkLineX !== null && table.dRadius !== null) {
    candidates.push({ x: table.baulkLineX - table.dRadius / 2, y: table.height / 2 });
  } else if (view.ballInHandZone === "behind-line" && table.baulkLineX !== null) {
    candidates.push({ x: table.baulkLineX / 2, y: table.height / 2 });
  } else {
    candidates.push({ x: table.width / 4, y: table.height / 2 });
  }

  const step = Math.max(table.ballDiameter, 0.04);
  for (let x = radius; x <= table.width - radius; x += step) {
    for (let y = radius; y <= table.height - radius; y += step) {
      candidates.push({ x, y });
    }
  }
  return candidates.find((point) => isCuePlacementValid(point, view, radius));
}

function playerGroupLabel(
  mode: BilliardsMode,
  group: BilliardsView["players"][number]["group"],
): string {
  if (mode === "snooker") return "斯诺克";
  if (group === null || group === "open") return "未分组";
  return group === "solids" ? "全色" : "花色";
}

function foulLabel(code: string): string {
  return FOUL_LABELS[code] ?? "击球犯规";
}

export function breakChoiceLabel(
  choice: BilliardsBreakChoice,
  reason?: Extract<NonNullable<BilliardsPendingDecisionView>, { type: "break-choice" }>["reason"],
): string {
  if (choice === "spot-eight" && reason === "eight-on-break-foul") {
    return "复位8号·线后手中球";
  }
  return BREAK_CHOICE_LABELS[choice];
}

export function breakDecisionReasonLabel(
  reason: Extract<NonNullable<BilliardsPendingDecisionView>, { type: "break-choice" }>["reason"],
): string {
  return BREAK_REASON_LABELS[reason];
}

export function canActOnDecision(
  view: BilliardsView,
  decision: NonNullable<BilliardsPendingDecisionView>,
  interactionDisabled: boolean,
): boolean {
  if (
    interactionDisabled ||
    view.phase !== "decision" ||
    view.viewerSeatId !== decision.chooserSeatId
  )
    return false;
  if (decision.type === "break-choice") return view.legalActions.canResolveBreak === true;
  if (decision.type === "choose-group") return view.legalActions.canChooseGroup === true;
  return view.legalActions.canChooseDecidingBlack === true;
}

export function noticeLabel(view: BilliardsView): string {
  if (view.phase === "ball_in_hand") {
    if (view.practice) {
      return view.shotNumber > 0 ? "母球落袋，请摆放母球继续" : "摆放母球开始练习";
    }
    if (view.ballInHandZone === "d") return "母球：D 区";
    if (view.ballInHandZone === "behind-line") return "母球：发球线后";
    return "母球：自由球";
  }
  if (view.practice) {
    if (view.lastShot === null) return "调整击球参数后开始练习";
    const pottedCount = view.lastShot.pottedBallIds.filter((ballId) => ballId !== "cue").length;
    return pottedCount > 0 ? `本杆进球 ${pottedCount} 颗 · 继续击球` : "继续击球";
  }
  const decision = view.pendingDecision ?? null;
  if (view.phase === "decision" && decision !== null) {
    return decision.type === "break-choice"
      ? `待裁定：${breakDecisionReasonLabel(decision.reason)}`
      : decision.type === "choose-group"
        ? "待选择：全色或花色"
        : "待选择：决胜黑球先手";
  }
  if (view.lastShot === null) return "等待击球";
  return view.lastShot.foulCode === null
    ? `上杆 ${view.lastShot.points} 分`
    : `犯规：${foulLabel(view.lastShot.foulCode)}`;
}

export function phaseLabel(view: BilliardsView): string {
  if (view.outcome !== null) return "本局结束";
  if (view.phase === "ball_in_hand") {
    if (view.practice) return "摆放母球";
    return view.ballInHandZone === "behind-line" ? "发球线后摆球" : "摆放母球";
  }
  if (view.phase === "decision") {
    const decision = view.pendingDecision ?? null;
    if (decision?.type === "break-choice") {
      return decision.chooserSeatId === view.viewerSeatId ? "选择开球处理" : "等待开球处理";
    }
    if (decision?.type === "choose-group") {
      return decision.chooserSeatId === view.viewerSeatId ? "选择球组" : "等待选择球组";
    }
    if (decision?.type === "deciding-black-choice") {
      return decision.chooserSeatId === view.viewerSeatId ? "选择决胜先手" : "等待先手选择";
    }
    return "等待裁定";
  }
  if (view.practice) return "练习击球";
  if (view.activeSeatId === null) return "等待玩家";
  return view.activeSeatId === view.viewerSeatId ? "轮到你" : "对手回合";
}

function connectionLabel(state: GameConnectionStateV1): string {
  switch (state) {
    case "connected":
      return "已连接";
    case "reconnecting":
      return "重连中";
    case "offline":
      return "离线";
  }
}

export function outcomeLabel(view: BilliardsView): string {
  if (view.outcome === null) return "本局结束";
  const reason = (() => {
    switch (view.outcome.reason) {
      case "eight-ball":
        return "八球胜负已定";
      case "final-black":
        return "斯诺克终局";
      case "resigned":
        return "对局认输结束";
      case "disconnected":
        return "对局断开结束";
      case "left":
        return "对局离开结束";
    }
  })();
  const winnerIndex = view.players.findIndex(({ seatId }) => seatId === view.outcome?.winnerSeatId);
  const winner =
    view.viewerSeatId === view.outcome.winnerSeatId
      ? "你获胜"
      : winnerIndex >= 0
        ? `玩家 ${winnerIndex + 1} 获胜`
        : "胜负已定";
  return `${reason} · ${winner}`;
}

function hydrateFrames(
  event: BilliardsShotDisplayEvent,
  frames: readonly RawPlaybackFrame[],
): PlaybackFrame[] {
  const metadata = new Map(event.initialBalls.map((ball) => [ball.id, ball]));
  return frames.map((frame) => ({
    atMs: Math.max(0, frame.atMs),
    balls: frame.balls.flatMap((ball) => {
      const original = metadata.get(ball.id);
      return original === undefined ? [] : [{ ...original, ...ball }];
    }),
  }));
}

function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const fullTurn = Math.PI * 2;
  const normalized = ((((angle + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
  return normalized;
}
