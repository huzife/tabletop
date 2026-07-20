import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gameIds = (await readdir(join(root, "games"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== "template")
  .map((entry) => entry.name);
const roots = ["apps/server/src", "apps/web/src", "packages"];
const compositionRoots = new Set([
  "apps/server/src/games/registry.ts",
  "apps/web/src/games/registry.ts",
]);
const concretePackageImports = gameIds.map((gameId) => `@tabletop/game-${gameId}/`);
const violations = [];

for (const directory of roots) {
  for (const file of await sourceFiles(join(root, directory))) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) continue;
    const source = await readFile(file, "utf8");
    if (
      !compositionRoots.has(path) &&
      concretePackageImports.some((packagePrefix) => source.includes(packagePrefix))
    ) {
      violations.push(`${path}: concrete game package import outside a composition root`);
    }
    if (!compositionRoots.has(path)) {
      for (const gameId of gameIds) {
        const literal = new RegExp(`["']${escapeRegExp(gameId)}["']`);
        if (literal.test(source)) violations.push(`${path}: concrete game id literal ${gameId}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(["Game boundary violations:", ...violations.map((item) => `- ${item}`)].join("\n"));
  process.exitCode = 1;
} else {
  console.log("Game package and game-id boundaries are valid.");
}

async function sourceFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFiles(path)));
    else if ([".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(extname(entry.name)))
      output.push(path);
  }
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
