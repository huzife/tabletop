import {
  ChevronsRight,
  Clock3,
  Dice1,
  Dice2,
  Dice3,
  Dice4,
  Dice5,
  Dice6,
  Plane,
  RotateCcw,
  Trophy,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { defineGameWebModuleV1, type GameViewPropsV1 } from "@tabletop/game-sdk/web";

import {
  ludoShared,
  type BoardCellPresentation,
  type LudoAction,
  type LudoColor,
  type LudoDisplayStep,
  type LudoSettings,
  type LudoView,
  type PlaneView,
} from "../shared/index.js";
import {
  ludoAnimationDurationMs,
  ludoAnimationSegments,
  type LudoAnimationSegment,
} from "./animation.js";

const COLOR_NAMES: Readonly<Record<LudoColor, string>> = {
  red: "红方",
  yellow: "黄方",
  green: "绿方",
  blue: "蓝方",
};

const CONTROLLER_NAMES = {
  human: "玩家",
  bot: "AI",
  temporary_ai: "临时接管",
  persistent_ai: "AI 接管",
} as const;

const DICE_ICONS: Readonly<Record<number, LucideIcon>> = {
  1: Dice1,
  2: Dice2,
  3: Dice3,
  4: Dice4,
  5: Dice5,
  6: Dice6,
};

export function LudoSettingsEditor({
  value,
  disabled,
  onChange,
}: {
  readonly value: LudoSettings;
  readonly disabled: boolean;
  readonly onChange: (settings: LudoSettings) => void;
}) {
  const update = (next: number) => {
    if (Number.isSafeInteger(next) && next >= 10 && next <= 120) {
      onChange({ phaseTimeSeconds: next });
    }
  };

  return (
    <div className="tt-ludo-settings">
      <label htmlFor="ludo-phase-time">阶段行动时间</label>
      <div className="tt-ludo-settings-control">
        <input
          id="ludo-phase-time"
          type="range"
          min={10}
          max={120}
          step={5}
          value={value.phaseTimeSeconds}
          disabled={disabled}
          onChange={(event) => update(Number(event.currentTarget.value))}
        />
        <input
          aria-label="阶段行动秒数"
          type="number"
          min={10}
          max={120}
          step={5}
          value={value.phaseTimeSeconds}
          disabled={disabled}
          onChange={(event) => update(Number(event.currentTarget.value))}
        />
        <span>秒</span>
      </div>
    </div>
  );
}

export function LudoGameView(props: GameViewPropsV1<LudoView, LudoAction, LudoDisplayStep>) {
  const { view, dispatchAction, actionPending, connectionState, readOnly } = props;
  const { animatedPlanes, isAnimating } = useLudoPlaneAnimations(props.displayEvents, view);
  const DiceIcon = view.roll === null ? Dice5 : (DICE_ICONS[view.roll] ?? Dice5);
  const activeSeat = view.seats.find((seat) => seat.seatId === view.currentSeatId);
  const latestStep = props.displayEvents.at(-1) ?? view.lastSteps.at(-1);
  const deadlinePercent =
    view.deadlineRemainingMs === null
      ? 0
      : Math.max(
          0,
          Math.min(100, (view.deadlineRemainingMs / (view.phaseTimeSeconds * 1_000)) * 100),
        );
  const disabled = actionPending || readOnly || connectionState !== "connected" || isAnimating;

  return (
    <div className="tt-ludo-shell">
      <style>{LUDO_STYLES}</style>
      <header className="tt-ludo-toolbar">
        <div className="tt-ludo-turn">
          <span className={`tt-ludo-color-mark is-${activeSeat?.color ?? "neutral"}`} />
          <div>
            <strong>{phaseLabel(view)}</strong>
            <span>{activeSeat === undefined ? "对局结束" : COLOR_NAMES[activeSeat.color]}</span>
          </div>
        </div>
        <div
          className="tt-ludo-event"
          key={latestStep === undefined ? "none" : JSON.stringify(latestStep)}
          aria-atomic="true"
          aria-live="polite"
        >
          {latestStep === undefined ? "等待对局开始" : formatStep(latestStep)}
        </div>
        <div className="tt-ludo-connection" title={connectionLabel(connectionState)}>
          {connectionState === "connected" ? (
            <Clock3 aria-hidden="true" />
          ) : (
            <WifiOff aria-hidden="true" />
          )}
          <span>
            {connectionState === "connected"
              ? formatRemaining(view.deadlineRemainingMs)
              : connectionLabel(connectionState)}
          </span>
        </div>
        <div className="tt-ludo-deadline" aria-hidden="true">
          <span style={{ width: `${deadlinePercent}%` }} />
        </div>
      </header>

      <main className="tt-ludo-layout">
        <section className="tt-ludo-board-zone" aria-label="飞行棋棋盘">
          <LudoBoard
            animatedPlanes={animatedPlanes}
            view={view}
            disabled={disabled || !view.canSelectPlane}
            onSelectPlane={(planeId) => dispatchAction({ type: "select_plane", planeId })}
          />
        </section>

        <aside className="tt-ludo-side">
          <section className="tt-ludo-dice-panel">
            <div
              className={`tt-ludo-die is-${activeSeat?.color ?? "neutral"}`}
              aria-label={view.roll === null ? "尚未投骰" : `骰子 ${view.roll} 点`}
            >
              <DiceIcon aria-hidden="true" />
              <strong>{view.roll ?? "-"}</strong>
            </div>
            <div className="tt-ludo-six-count">
              连续六点 <strong>{view.sixStreak}</strong>
            </div>
            <button
              className="tt-ludo-roll-button"
              type="button"
              disabled={disabled || !view.canRoll}
              onClick={() => dispatchAction({ type: "roll" })}
            >
              <Dice5 aria-hidden="true" />
              <span>投骰</span>
            </button>
          </section>

          <section className="tt-ludo-seats" aria-label="玩家与排名">
            {view.seats.map((seat) => (
              <article
                className={`tt-ludo-seat is-${seat.color}${seat.active ? " is-active" : ""}`}
                key={seat.seatId}
              >
                <span className={`tt-ludo-color-mark is-${seat.color}`} />
                <div className="tt-ludo-seat-copy">
                  <strong>{COLOR_NAMES[seat.color]}</strong>
                  <span>{CONTROLLER_NAMES[seat.controller]}</span>
                </div>
                <div className="tt-ludo-seat-progress" title={`已完成 ${seat.finishedPlanes} 架`}>
                  {seat.rank === null ? (
                    <>
                      <Plane aria-hidden="true" />
                      <span>{seat.finishedPlanes}/4</span>
                    </>
                  ) : (
                    <>
                      <Trophy aria-hidden="true" />
                      <span>第 {seat.rank} 名</span>
                    </>
                  )}
                </div>
              </article>
            ))}
          </section>

          {view.viewerController !== null && view.viewerController !== "human" ? (
            <div className="tt-ludo-control-notice">
              <RotateCcw aria-hidden="true" />
              <span>{CONTROLLER_NAMES[view.viewerController]}正在行动</span>
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

function LudoBoard({
  animatedPlanes,
  view,
  disabled,
  onSelectPlane,
}: {
  readonly animatedPlanes: ReadonlyMap<PlaneView["planeId"], AnimatedPlaneState>;
  readonly view: LudoView;
  readonly disabled: boolean;
  readonly onSelectPlane: (planeId: PlaneView["planeId"]) => void;
}) {
  const cellById = new Map(view.board.cells.map((cell) => [cell.cellId, cell]));
  const animatedPlaneIds = new Set(animatedPlanes.keys());
  const planesByCell = new Map<string, PlaneView[]>();
  for (const plane of view.planes) {
    if (plane.cellId === null) continue;
    const group = planesByCell.get(plane.cellId) ?? [];
    group.push(plane);
    planesByCell.set(plane.cellId, group);
  }

  return (
    <div
      className="tt-ludo-board"
      style={{ "--ludo-board-size": view.board.size } as CSSProperties}
    >
      <div className="tt-ludo-base-bg is-red" />
      <div className="tt-ludo-base-bg is-yellow" />
      <div className="tt-ludo-base-bg is-green" />
      <div className="tt-ludo-base-bg is-blue" />
      <div className="tt-ludo-center">
        <Plane aria-hidden="true" />
      </div>
      <FlightRoutes cellById={cellById} routes={view.board.flightRoutes} size={view.board.size} />
      {view.board.cells.map((cell) => (
        <BoardCell
          key={cell.cellId}
          cell={cell}
          planes={planesByCell.get(cell.cellId) ?? []}
          animatedPlaneIds={animatedPlaneIds}
          disabled={disabled}
          onSelectPlane={onSelectPlane}
        />
      ))}
      <div className="tt-ludo-animation-layer" aria-hidden="true">
        {[...animatedPlanes.values()].map((animation) => {
          const plane = view.planes.find((candidate) => candidate.planeId === animation.planeId);
          const cell = cellById.get(animation.cellId);
          if (plane === undefined || cell === undefined) return null;
          const style = {
            "--ludo-animation-duration": `${animation.durationMs}ms`,
            "--ludo-x": cell.coordinate.x,
            "--ludo-y": cell.coordinate.y,
          } as CSSProperties;
          return (
            <div
              className={`tt-ludo-animated-plane${animation.moving ? " is-moving" : ""}`}
              key={animation.planeId}
              style={style}
            >
              <span className={`tt-ludo-plane is-${plane.color}`}>
                <Plane aria-hidden="true" />
                <span>{plane.number}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlightRoutes({
  cellById,
  routes,
  size,
}: {
  readonly cellById: ReadonlyMap<string, BoardCellPresentation>;
  readonly routes: LudoView["board"]["flightRoutes"];
  readonly size: number;
}) {
  return (
    <svg
      className="tt-ludo-flight-routes"
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      {routes.map((route) => {
        const entry = cellById.get(route.entryCellId);
        const crossing = cellById.get(route.crossingCellId);
        const exit = cellById.get(route.exitCellId);
        if (entry === undefined || crossing === undefined || exit === undefined) return null;

        const points = [entry, crossing, exit]
          .map((cell) => `${cell.coordinate.x + 0.5},${cell.coordinate.y + 0.5}`)
          .join(" ");
        return (
          <g className={`tt-ludo-flight-route is-${route.color}`} key={route.color}>
            <polyline points={points} />
            <circle
              className="tt-ludo-flight-crossing"
              data-cell-id={route.crossingCellId}
              cx={crossing.coordinate.x + 0.5}
              cy={crossing.coordinate.y + 0.5}
              r="0.16"
            />
          </g>
        );
      })}
    </svg>
  );
}

function BoardCell({
  cell,
  planes,
  animatedPlaneIds,
  disabled,
  onSelectPlane,
}: {
  readonly cell: BoardCellPresentation;
  readonly planes: readonly PlaneView[];
  readonly animatedPlaneIds: ReadonlySet<PlaneView["planeId"]>;
  readonly disabled: boolean;
  readonly onSelectPlane: (planeId: PlaneView["planeId"]) => void;
}) {
  const style = {
    "--ludo-x": cell.coordinate.x,
    "--ludo-y": cell.coordinate.y,
  } as CSSProperties;
  const markerColor = cell.jumpColor ?? cell.color;
  return (
    <div
      className={`tt-ludo-cell is-${cell.region.toLowerCase()}${markerColor === null ? "" : ` is-${markerColor}`}`}
      data-cell-id={cell.cellId}
      style={style}
      title={cellTitle(cell)}
    >
      {cell.flight === "entry" ? (
        <Plane className="tt-ludo-cell-flight" aria-hidden="true" />
      ) : null}
      {cell.homeEntry !== null ? (
        <Trophy className="tt-ludo-cell-home-entry" aria-hidden="true" />
      ) : null}
      {cell.jumpColor !== null && cell.flight === null ? (
        <ChevronsRight className="tt-ludo-cell-jump" aria-hidden="true" />
      ) : null}
      <div className={`tt-ludo-plane-stack count-${Math.min(planes.length, 4)}`}>
        {planes.map((plane) => (
          <button
            key={plane.planeId}
            aria-hidden={animatedPlaneIds.has(plane.planeId) || undefined}
            className={`tt-ludo-plane is-${plane.color}${plane.selectable ? " is-selectable" : ""}${animatedPlaneIds.has(plane.planeId) ? " is-animation-source" : ""}`}
            type="button"
            title={`${COLOR_NAMES[plane.color]} ${plane.number} 号飞机`}
            aria-label={`${COLOR_NAMES[plane.color]} ${plane.number} 号飞机`}
            disabled={disabled || !plane.selectable || animatedPlaneIds.has(plane.planeId)}
            onClick={() => onSelectPlane(plane.planeId)}
          >
            <Plane aria-hidden="true" />
            <span>{plane.number}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface AnimatedPlaneState {
  readonly planeId: PlaneView["planeId"];
  readonly cellId: string;
  readonly durationMs: number;
  readonly moving: boolean;
}

function useLudoPlaneAnimations(
  displayEvents: readonly LudoDisplayStep[],
  view: LudoView,
): {
  readonly animatedPlanes: ReadonlyMap<PlaneView["planeId"], AnimatedPlaneState>;
  readonly isAnimating: boolean;
} {
  const reducedMotion = useReducedMotion();
  const [animatedPlanes, setAnimatedPlanes] = useState<
    ReadonlyMap<PlaneView["planeId"], AnimatedPlaneState>
  >(() => new Map());
  const queueRef = useRef<LudoAnimationSegment[]>([]);
  const runningRef = useRef(false);
  const mountedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  // The first projected batch is a baseline. This prevents stale events from replaying after
  // an initial join, reconnect, or a remount of the game view.
  const lastEventsRef = useRef(displayEvents);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const clearScheduledWork = () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    frameRef.current = null;
    timerRef.current = null;
  };

  const flush = () => {
    clearScheduledWork();
    queueRef.current = [];
    runningRef.current = false;
    if (mountedRef.current) setAnimatedPlanes(new Map());
  };

  const startNextRef = useRef<() => void>(() => undefined);
  startNextRef.current = () => {
    if (runningRef.current || reducedMotionRef.current || !mountedRef.current) return;
    const segment = queueRef.current.shift();
    if (segment === undefined) return;

    runningRef.current = true;
    const durationMs = ludoAnimationDurationMs(segment.kind);
    setAnimatedPlanes((current) => {
      const next = new Map(current);
      next.set(segment.planeId, {
        planeId: segment.planeId,
        cellId: segment.fromCellId,
        durationMs,
        moving: false,
      });
      return next;
    });

    // Two frames ensure the confirmed start cell is painted before its transition begins.
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (!mountedRef.current || reducedMotionRef.current) return;
        setAnimatedPlanes((current) => {
          const next = new Map(current);
          next.set(segment.planeId, {
            planeId: segment.planeId,
            cellId: segment.toCellId,
            durationMs,
            moving: true,
          });
          return next;
        });
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          if (!mountedRef.current) return;
          runningRef.current = false;
          setAnimatedPlanes((current) => {
            const next = new Map(current);
            const hasMoreForPlane = queueRef.current.some(
              (candidate) => candidate.planeId === segment.planeId,
            );
            if (hasMoreForPlane) {
              next.set(segment.planeId, {
                planeId: segment.planeId,
                cellId: segment.toCellId,
                durationMs: 0,
                moving: false,
              });
            } else {
              next.delete(segment.planeId);
            }
            return next;
          });
          startNextRef.current();
        }, durationMs);
      });
    });
  };

  useLayoutEffect(() => {
    mountedRef.current = true;
    const handleVisibilityChange = () => {
      if (document.hidden) flush();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearScheduledWork();
      queueRef.current = [];
      runningRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (reducedMotion) flush();
  }, [reducedMotion]);

  useLayoutEffect(() => {
    if (lastEventsRef.current === displayEvents) return;
    lastEventsRef.current = displayEvents;
    if (reducedMotion) return;

    const segments = ludoAnimationSegments(displayEvents, view.board.cells);
    if (segments.length === 0) return;
    queueRef.current.push(...segments);
    setAnimatedPlanes((current) => {
      const next = new Map(current);
      for (const segment of segments) {
        if (!next.has(segment.planeId)) {
          next.set(segment.planeId, {
            planeId: segment.planeId,
            cellId: segment.fromCellId,
            durationMs: 0,
            moving: false,
          });
        }
      }
      return next;
    });
    startNextRef.current();
  }, [displayEvents, reducedMotion, view.board.cells]);

  return { animatedPlanes, isAnimating: animatedPlanes.size > 0 };
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return reducedMotion;
}

function phaseLabel(view: LudoView): string {
  switch (view.phase) {
    case "deciding_order":
      return "决定先手";
    case "waiting_roll":
      return "等待投骰";
    case "selecting_plane":
      return "选择飞机";
    case "resolving":
      return "结算移动";
    case "ended":
      return "本局排名";
  }
}

function formatStep(step: LudoDisplayStep): string {
  switch (step.type) {
    case "roll":
      return `${seatName(step.seatId)}投出 ${step.value} 点`;
    case "launch":
      return "飞机已进入起点格";
    case "move":
      return step.direction === "forward" ? "飞机正在前进" : "飞机原路返回";
    case "bounce":
      return step.reason === "blockade"
        ? "遇到叠机，原路返回"
        : step.reason === "finish"
          ? "越过终点，向后反弹"
          : "返回起点边界后折返";
    case "capture":
      return step.mutual ? "叠机碰撞，同归于尽" : `吃掉 ${step.capturedPlaneIds.length} 架飞机`;
    case "jump_cancelled":
      return "跳跃路线受阻";
    case "jump":
      return "同色跳跃四格";
    case "fly":
      return "进入快捷飞行";
    case "finish":
      return "一架飞机到达终点";
    case "three_sixes":
      return "连续三次六点，未完成飞机返回基地";
    case "rank":
      return `${seatName(step.seatId)}获得第 ${step.rank} 名`;
    case "turn":
      return `轮到${seatName(step.seatId)}`;
  }
}

function seatName(seatId: string): string {
  return seatId in COLOR_NAMES ? COLOR_NAMES[seatId as LudoColor] : seatId;
}

function cellTitle(cell: BoardCellPresentation): string {
  if (cell.region === "APRON") return `${cell.color === null ? "" : COLOR_NAMES[cell.color]}起点格`;
  if (cell.region === "BASE") return `${cell.color === null ? "" : COLOR_NAMES[cell.color]}基地`;
  if (cell.region === "TURN") return "灰色转向格";
  if (cell.region === "HOME_PATH" || cell.region === "FINISH")
    return `${cell.color === null ? "" : COLOR_NAMES[cell.color]}终点跑道`;
  if (cell.homeEntry !== null) return `${COLOR_NAMES[cell.homeEntry]}进入终点段`;
  if (cell.flight === "entry") return "快捷飞行入口";
  if (cell.flight === "exit") return "快捷飞行出口";
  return cell.jumpColor === null ? "公共环道" : `${COLOR_NAMES[cell.jumpColor]}跳跃格`;
}

function formatRemaining(value: number | null): string {
  if (value === null) return "--";
  return `${Math.ceil(value / 1_000)} 秒`;
}

function connectionLabel(state: "connected" | "reconnecting" | "offline"): string {
  if (state === "connected") return "已连接";
  return state === "reconnecting" ? "重连中" : "已离线";
}

const RULE_ERRORS: Readonly<Record<string, string>> = {
  LUDO_ACTION_AFTER_DEADLINE: "本阶段已经结束",
  LUDO_CONTROLLER_MISMATCH: "当前由自动控制器行动",
  LUDO_MATCH_ENDED: "本局已经结束",
  LUDO_NOT_SELECTING_PLANE: "现在不能选择飞机",
  LUDO_NOT_WAITING_FOR_ROLL: "现在不能投骰",
  LUDO_NOT_YOUR_TURN: "还没有轮到你",
  LUDO_PLANE_NOT_LEGAL: "这架飞机当前不能移动",
};

export const ludoWebModule = defineGameWebModuleV1({
  shared: ludoShared,
  SettingsEditor: LudoSettingsEditor,
  GameView: LudoGameView,
  formatRuleError: (ruleCode) => RULE_ERRORS[ruleCode] ?? "操作不符合当前规则",
});

const LUDO_STYLES = `
.tt-ludo-shell { --red:#d9485f; --yellow:#e0ad1b; --green:#2f9465; --blue:#3778c2; --ink:#18212b; --muted:#637181; --line:#cfd6dd; --surface:#ffffff; --soft:#f3f5f7; color:var(--ink); background:#eef1f4; width:100%; height:100%; min-height:0; display:flex; flex-direction:column; overflow:hidden; font-family:Inter,"Microsoft YaHei",sans-serif; letter-spacing:0; }
.tt-ludo-shell * { box-sizing:border-box; letter-spacing:0; }
.tt-ludo-toolbar { position:relative; min-height:58px; padding:7px 14px 10px; display:grid; grid-template-columns:180px minmax(160px,1fr) 100px; align-items:center; gap:12px; flex:0 0 auto; background:var(--surface); border-bottom:1px solid var(--line); }
.tt-ludo-turn,.tt-ludo-connection { display:flex; align-items:center; gap:10px; min-width:0; }
.tt-ludo-turn div { display:grid; min-width:0; }
.tt-ludo-turn strong { font-size:15px; line-height:20px; }
.tt-ludo-turn span:not(.tt-ludo-color-mark),.tt-ludo-seat-copy span { color:var(--muted); font-size:12px; line-height:17px; }
.tt-ludo-color-mark { width:12px; height:34px; border-radius:3px; flex:0 0 auto; background:#8b96a2; }
.tt-ludo-color-mark.is-red { background:var(--red); }.tt-ludo-color-mark.is-yellow { background:var(--yellow); }.tt-ludo-color-mark.is-green { background:var(--green); }.tt-ludo-color-mark.is-blue { background:var(--blue); }
.tt-ludo-event { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; font-size:14px; font-weight:600; animation:tt-ludo-flash .25s ease-out; }
.tt-ludo-connection { justify-content:flex-end; color:var(--muted); font-size:13px; font-variant-numeric:tabular-nums; }
.tt-ludo-connection svg { width:17px; height:17px; }
.tt-ludo-deadline { position:absolute; left:0; right:0; bottom:0; height:3px; background:#e4e8ec; overflow:hidden; }.tt-ludo-deadline span { display:block; height:100%; background:#26836a; transition:width .2s linear; }
.tt-ludo-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(200px,244px); gap:14px; padding:12px; width:100%; max-width:1440px; min-height:0; flex:1 1 auto; overflow:hidden; margin:0 auto; }
.tt-ludo-board-zone { display:flex; height:100%; min-height:0; min-width:0; align-items:center; justify-content:center; }
.tt-ludo-board { --cell:calc(100% / var(--ludo-board-size)); position:relative; height:min(100%,760px); width:auto; max-width:100%; aspect-ratio:1; background:#fff; border:1px solid #aeb8c2; box-shadow:0 8px 24px rgba(22,32,43,.08); overflow:hidden; }
.tt-ludo-base-bg { position:absolute; width:calc(var(--cell) * 3); height:calc(var(--cell) * 3); opacity:.13; }.tt-ludo-base-bg.is-red { left:calc(var(--cell) * .5); top:calc(var(--cell) * .5); background:var(--red); }.tt-ludo-base-bg.is-yellow { right:calc(var(--cell) * .5); top:calc(var(--cell) * .5); background:var(--yellow); }.tt-ludo-base-bg.is-green { right:calc(var(--cell) * .5); bottom:calc(var(--cell) * .5); background:var(--green); }.tt-ludo-base-bg.is-blue { left:calc(var(--cell) * .5); bottom:calc(var(--cell) * .5); background:var(--blue); }
.tt-ludo-center { position:absolute; left:calc(var(--cell) * 6); top:calc(var(--cell) * 6); width:calc(var(--cell) * 3); height:calc(var(--cell) * 3); display:grid; place-items:center; background:#f2f4f6; border:1px solid var(--line); color:#7a8794; }.tt-ludo-center svg { width:42%; height:42%; }
.tt-ludo-flight-routes { position:absolute; inset:0; z-index:3; width:100%; height:100%; pointer-events:none; }.tt-ludo-flight-route { color:#7a8794; }.tt-ludo-flight-route.is-red { color:var(--red); }.tt-ludo-flight-route.is-yellow { color:#b18400; }.tt-ludo-flight-route.is-green { color:var(--green); }.tt-ludo-flight-route.is-blue { color:var(--blue); }.tt-ludo-flight-route polyline { fill:none; stroke:currentColor; stroke-width:.08; stroke-dasharray:.2 .14; stroke-linecap:round; opacity:.58; }.tt-ludo-flight-crossing { fill:#fff; stroke:currentColor; stroke-width:.08; }
.tt-ludo-cell { position:absolute; left:calc(var(--ludo-x) * var(--cell)); top:calc(var(--ludo-y) * var(--cell)); width:var(--cell); height:var(--cell); border:1px solid #aeb8c2; background:#fff; display:grid; place-items:center; color:#8c98a5; }
.tt-ludo-cell.is-red { background:#f8dce1; color:#a7243d; }.tt-ludo-cell.is-yellow { background:#fff0b8; color:#876300; }.tt-ludo-cell.is-green { background:#d9eee4; color:#176643; }.tt-ludo-cell.is-blue { background:#dbe8f7; color:#235a99; }
.tt-ludo-cell.is-turn { background:#dfe3e7; color:#7a8794; }.tt-ludo-cell.is-base { border-radius:50%; border-width:2px; }.tt-ludo-cell.is-apron { border-width:2px; outline:2px solid rgba(255,255,255,.8); outline-offset:-5px; }.tt-ludo-cell.is-finish { border-width:2px; }
.tt-ludo-cell-flight,.tt-ludo-cell-jump,.tt-ludo-cell-home-entry { position:absolute; z-index:4; width:42%; height:42%; opacity:.42; }.tt-ludo-cell-flight { transform:rotate(-22deg); }.tt-ludo-cell-jump { width:52%; height:52%; }.tt-ludo-cell-home-entry { width:38%; height:38%; }
.tt-ludo-plane-stack { position:absolute; inset:2px; z-index:5; display:grid; place-items:center; }.tt-ludo-plane-stack.count-2,.tt-ludo-plane-stack.count-3,.tt-ludo-plane-stack.count-4 { grid-template-columns:repeat(2,1fr); grid-template-rows:repeat(2,1fr); gap:1px; }
.tt-ludo-plane { position:relative; width:88%; height:88%; min-width:0; min-height:0; padding:0; border:2px solid #fff; border-radius:50%; box-shadow:0 1px 4px rgba(21,30,40,.35); display:grid; place-items:center; color:#fff; cursor:default; transition:transform .12s ease,box-shadow .12s ease; }.tt-ludo-plane svg { width:58%; height:58%; fill:currentColor; }.tt-ludo-plane span { position:absolute; right:0; bottom:0; min-width:13px; height:13px; padding:0 2px; border-radius:7px; display:grid; place-items:center; background:#fff; color:#26313d; font-size:9px; font-weight:800; }
.tt-ludo-plane.is-red { background:var(--red); }.tt-ludo-plane.is-yellow { background:var(--yellow); color:#2c2614; }.tt-ludo-plane.is-green { background:var(--green); }.tt-ludo-plane.is-blue { background:var(--blue); }
.tt-ludo-plane.is-selectable { cursor:pointer; animation:tt-ludo-ready 1s ease-in-out infinite alternate; }.tt-ludo-plane.is-selectable:hover { transform:scale(1.12); box-shadow:0 0 0 3px rgba(32,124,101,.28),0 2px 6px rgba(21,30,40,.4); }.tt-ludo-plane:disabled { opacity:1; }
.tt-ludo-plane.is-animation-source { opacity:0; pointer-events:none; }
.tt-ludo-animation-layer { position:absolute; inset:0; z-index:12; pointer-events:none; }
.tt-ludo-animated-plane { position:absolute; left:calc(var(--ludo-x) * var(--cell)); top:calc(var(--ludo-y) * var(--cell)); width:var(--cell); height:var(--cell); padding:2px; display:grid; place-items:center; }
.tt-ludo-animated-plane.is-moving { transition:left var(--ludo-animation-duration) cubic-bezier(.22,.78,.32,1),top var(--ludo-animation-duration) cubic-bezier(.22,.78,.32,1); }
.tt-ludo-animated-plane .tt-ludo-plane { width:88%; height:88%; }
.tt-ludo-side { min-width:0; max-height:100%; display:grid; align-content:start; gap:14px; overflow-y:auto; padding-right:2px; }
.tt-ludo-dice-panel { display:grid; grid-template-columns:82px 1fr; gap:10px; padding-bottom:14px; border-bottom:1px solid var(--line); }
.tt-ludo-die { grid-row:span 2; width:82px; height:82px; position:relative; display:grid; place-items:center; background:#fff; border:2px solid #8995a2; border-radius:6px; }.tt-ludo-die svg { width:58px; height:58px; }.tt-ludo-die strong { position:absolute; font-size:16px; }.tt-ludo-die.is-red { color:var(--red); border-color:var(--red); }.tt-ludo-die.is-yellow { color:#8b6800; border-color:var(--yellow); }.tt-ludo-die.is-green { color:var(--green); border-color:var(--green); }.tt-ludo-die.is-blue { color:var(--blue); border-color:var(--blue); }
.tt-ludo-six-count { align-self:end; color:var(--muted); font-size:12px; }.tt-ludo-six-count strong { color:var(--ink); font-size:15px; }
.tt-ludo-roll-button { min-height:38px; padding:0 14px; border:0; border-radius:6px; display:flex; align-items:center; justify-content:center; gap:8px; background:#207c65; color:#fff; font:inherit; font-size:14px; font-weight:700; cursor:pointer; }.tt-ludo-roll-button svg { width:18px; height:18px; }.tt-ludo-roll-button:hover:not(:disabled) { background:#176a56; }.tt-ludo-roll-button:disabled { background:#c8cfd5; color:#6d7883; cursor:not-allowed; }
.tt-ludo-seats { display:grid; gap:7px; }.tt-ludo-seat { height:58px; padding:7px 9px; display:grid; grid-template-columns:8px 1fr auto; gap:9px; align-items:center; background:#fff; border:1px solid var(--line); border-radius:6px; }.tt-ludo-seat.is-active { border-color:#627182; box-shadow:inset 0 0 0 1px #627182; }.tt-ludo-seat .tt-ludo-color-mark { width:8px; height:38px; }.tt-ludo-seat-copy { min-width:0; display:grid; }.tt-ludo-seat-copy strong { font-size:14px; line-height:19px; }.tt-ludo-seat-progress { min-width:54px; display:flex; align-items:center; justify-content:flex-end; gap:5px; color:var(--muted); font-size:12px; }.tt-ludo-seat-progress svg { width:16px; height:16px; }
.tt-ludo-control-notice { min-height:40px; padding:8px 10px; display:flex; align-items:center; gap:8px; background:#e8ecef; border-left:3px solid #778491; font-size:13px; }.tt-ludo-control-notice svg { width:17px; height:17px; }
.tt-ludo-settings { display:grid; gap:8px; max-width:520px; }.tt-ludo-settings label { font-size:13px; font-weight:700; }.tt-ludo-settings-control { display:grid; grid-template-columns:minmax(160px,1fr) 76px 22px; align-items:center; gap:10px; }.tt-ludo-settings-control input[type=range] { accent-color:#207c65; }.tt-ludo-settings-control input[type=number] { width:76px; height:34px; padding:0 7px; border:1px solid #aeb8c2; border-radius:4px; font:inherit; }
@keyframes tt-ludo-ready { from { box-shadow:0 0 0 1px rgba(32,124,101,.2),0 1px 4px rgba(21,30,40,.35); } to { box-shadow:0 0 0 4px rgba(32,124,101,.3),0 1px 4px rgba(21,30,40,.35); } }
@keyframes tt-ludo-flash { from { opacity:.35; transform:translateY(-3px); } to { opacity:1; transform:translateY(0); } }
@media (max-width:980px) { .tt-ludo-layout { grid-template-columns:minmax(0,1fr) minmax(190px,220px); gap:12px; padding:10px; }.tt-ludo-toolbar { grid-template-columns:170px minmax(140px,1fr) 92px; padding-left:10px; padding-right:10px; }.tt-ludo-dice-panel { grid-template-columns:72px 1fr; }.tt-ludo-die { width:72px; height:72px; }.tt-ludo-die svg { width:50px; height:50px; } }
@media (prefers-reduced-motion:reduce) { .tt-ludo-event,.tt-ludo-plane.is-selectable { animation:none; }.tt-ludo-deadline span,.tt-ludo-plane,.tt-ludo-animated-plane { transition:none; } }
`;
