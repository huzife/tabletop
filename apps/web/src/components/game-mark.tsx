import type { CSSProperties } from "react";

interface GameMarkModel {
  readonly id: string;
  readonly name: string;
}

const ACCENTS = ["#13795b", "#b6413d", "#2f6e9c", "#8a681b", "#6b568f"] as const;

function accentFor(gameId: string): string {
  const hash = [...gameId].reduce((value, character) => value + character.charCodeAt(0), 0);
  return ACCENTS[hash % ACCENTS.length] ?? ACCENTS[0];
}

export function GameMark({
  game,
  size = "normal",
}: {
  game: GameMarkModel;
  size?: "large" | "normal";
}) {
  return (
    <span
      aria-hidden="true"
      className={`game-mark game-mark--${size}`}
      style={{ "--game-accent": accentFor(game.id) } as CSSProperties}
    >
      {Array.from(game.name)[0] ?? "游"}
    </span>
  );
}
