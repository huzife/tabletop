import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";

const baseUrl = process.env.TABLETOP_E2E_BASE_URL ?? "http://localhost:5173";
const username = process.env.TABLETOP_E2E_USERNAME;
const password = process.env.TABLETOP_E2E_PASSWORD;
const outputDirectory = resolve(
  process.env.TABLETOP_E2E_OUTPUT_DIR ?? "/tmp/tabletop-visual-smoke",
);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const viewportFilter = process.env.TABLETOP_E2E_VIEWPORT;

if (!username || !password) {
  throw new Error("TABLETOP_E2E_USERNAME and TABLETOP_E2E_PASSWORD are required");
}

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

try {
  const viewports = [
    { height: 720, width: 1280 },
    { height: 1080, width: 1920 },
  ].filter(
    (viewport) => !viewportFilter || viewportFilter === `${viewport.width}x${viewport.height}`,
  );
  if (viewports.length === 0) {
    throw new Error(`Unsupported TABLETOP_E2E_VIEWPORT: ${viewportFilter}`);
  }
  for (const viewport of viewports) {
    await verifyViewport(viewport);
  }
} finally {
  await browser.close();
}

async function verifyViewport(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const browserErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

  try {
    await login(page);
    browserErrors.length = 0;

    await page.getByRole("heading", { exact: true, name: "五子棋" }).waitFor();
    await verifyPage(page, "home", viewport, browserErrors, [".app-header"]);

    await page.goto(`${baseUrl}/admin/accounts`);
    await page.getByRole("heading", { name: "账号管理" }).waitFor();
    await page.locator(".data-table").waitFor();
    await verifyPage(page, "admin-accounts", viewport, browserErrors, [
      ".app-header",
      ".page-heading",
      ".section-heading",
    ]);

    await page.goto(`${baseUrl}/admin/services`);
    await page.getByRole("heading", { name: "游戏服务" }).waitFor();
    await verifyPage(page, "admin-services", viewport, browserErrors, [
      ".app-header",
      ".page-heading",
    ]);

    await page.goto(`${baseUrl}/admin/audit`);
    await page.getByRole("heading", { name: "审计日志" }).waitFor();
    await verifyPage(page, "admin-audit", viewport, browserErrors, [
      ".app-header",
      ".page-heading",
    ]);

    await openPracticeMatch(page, "gomoku", "五子棋", ".gomoku-board");
    await verifyRoom(page, "gomoku", viewport, browserErrors, {
      boardSelector: ".gomoku-board",
      shellSelector: ".gomoku-game",
      sidebarSelector: ".gomoku-sidebar",
    });
    await leaveRoom(page, "gomoku");

    await openPracticeMatch(page, "ludo", "飞行棋", ".tt-ludo-board");
    await verifyRoom(page, "ludo", viewport, browserErrors, {
      boardSelector: ".tt-ludo-board",
      shellSelector: ".tt-ludo-shell",
      sidebarSelector: ".tt-ludo-side",
    });
    await leaveRoom(page, "ludo");

    if (browserErrors.length > 0) {
      throw new Error(
        `${viewport.width}x${viewport.height} browser errors:\n${browserErrors.join("\n")}`,
      );
    }
  } finally {
    await context.close();
  }
}

async function login(page) {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { exact: true, name: "登录" }).click();
  await page.waitForURL(`${baseUrl}/`);
}

async function openPracticeMatch(page, gameId, gameName, boardSelector) {
  await page.goto(`${baseUrl}/games/${gameId}`);
  await page.getByRole("heading", { name: "创建房间" }).waitFor();
  await page.getByRole("button", { name: /单人练习/ }).click();
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/rooms",
  );
  await page.getByRole("button", { name: /创建并进入/ }).click();
  const createResponse = await createResponsePromise;
  if (!createResponse.ok()) {
    throw new Error(
      `Creating ${gameName} practice room failed with ${createResponse.status()}: ${await createResponse.text()}`,
    );
  }
  await page.waitForURL(/\/rooms\//);
  await page.getByRole("button", { exact: true, name: "准备" }).click();
  await page.getByRole("button", { exact: true, name: "开始游戏" }).click();
  await page.locator(boardSelector).waitFor();
  await page.getByRole("region", { name: `${gameName}游戏区域` }).waitFor();
  await page.getByRole("heading", { name: "聊天" }).waitFor();
  await page.waitForTimeout(250);
}

async function leaveRoom(page, gameId) {
  await page.getByRole("button", { name: "离开房间" }).click();
  await page.waitForURL(`${baseUrl}/games/${gameId}`);
}

async function verifyRoom(page, name, viewport, browserErrors, selectors) {
  await verifyPage(page, `${name}-playing`, viewport, browserErrors, [
    ".app-header",
    ".room-header",
    ".room-workspace",
    ".game-stage",
    selectors.shellSelector,
  ]);

  const geometry = await page.evaluate((roomSelectors) => {
    const bounds = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rectangle = element.getBoundingClientRect();
      return {
        bottom: rectangle.bottom,
        height: rectangle.height,
        left: rectangle.left,
        right: rectangle.right,
        top: rectangle.top,
        width: rectangle.width,
      };
    };
    return {
      board: bounds(roomSelectors.boardSelector),
      placeholder: bounds(".game-module-placeholder"),
      shell: bounds(roomSelectors.shellSelector),
      sidebar: bounds(roomSelectors.sidebarSelector),
    };
  }, selectors);

  assertContained(geometry.placeholder, geometry.shell, `${name} shell`);
  assertContained(geometry.placeholder, geometry.board, `${name} board`);
  assertContained(geometry.placeholder, geometry.sidebar, `${name} sidebar`);
  if (Math.abs(geometry.board.width - geometry.board.height) > 1) {
    throw new Error(
      `${name} board is not square: ${geometry.board.width}x${geometry.board.height}`,
    );
  }
}

async function verifyPage(page, name, viewport, browserErrors, siblingParents) {
  await page.screenshot({
    path: resolve(outputDirectory, `${viewport.width}x${viewport.height}-${name}.png`),
  });

  const layout = await page.evaluate((parents) => {
    const root = document.documentElement;
    const body = document.body;
    const overlaps = [];
    for (const parentSelector of parents) {
      const parent = document.querySelector(parentSelector);
      if (!parent) continue;
      const children = [...parent.children].filter((element) => {
        const style = getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return style.display !== "none" && rectangle.width > 0 && rectangle.height > 0;
      });
      for (let firstIndex = 0; firstIndex < children.length; firstIndex += 1) {
        for (let secondIndex = firstIndex + 1; secondIndex < children.length; secondIndex += 1) {
          const first = children[firstIndex];
          const second = children[secondIndex];
          const a = first.getBoundingClientRect();
          const b = second.getBoundingClientRect();
          const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapWidth > 1 && overlapHeight > 1) {
            overlaps.push(
              `${parentSelector}: ${describe(first)} overlaps ${describe(second)} (${overlapWidth.toFixed(1)}x${overlapHeight.toFixed(1)})`,
            );
          }
        }
      }
    }

    const clippedControls = [...document.querySelectorAll("button, a")]
      .filter((element) => {
        const rectangle = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          (element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1)
        );
      })
      .map(describe);

    return {
      bodyClientWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      clippedControls,
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      overlaps,
    };

    function describe(element) {
      const identifier = element.id ? `#${element.id}` : "";
      const className =
        typeof element.className === "string" && element.className
          ? `.${element.className.trim().replaceAll(/\s+/g, ".")}`
          : "";
      const text = element.textContent?.trim().replaceAll(/\s+/g, " ").slice(0, 30) ?? "";
      return `${element.tagName.toLowerCase()}${identifier}${className}${text ? ` (${text})` : ""}`;
    }
  }, siblingParents);

  if (
    layout.rootScrollWidth > layout.rootClientWidth + 1 ||
    layout.bodyScrollWidth > layout.bodyClientWidth + 1
  ) {
    throw new Error(`${name} has horizontal page overflow: ${JSON.stringify(layout)}`);
  }
  if (layout.overlaps.length > 0) {
    throw new Error(`${name} has overlapping sibling regions:\n${layout.overlaps.join("\n")}`);
  }
  if (layout.clippedControls.length > 0) {
    throw new Error(`${name} has clipped controls:\n${layout.clippedControls.join("\n")}`);
  }
  if (browserErrors.length > 0) {
    throw new Error(`${name} browser errors:\n${browserErrors.join("\n")}`);
  }

  console.log(
    `${viewport.width}x${viewport.height} ${name}: no page overflow, overlaps, clipped controls, or browser errors`,
  );
}

function assertContained(container, content, label) {
  const tolerance = 1;
  if (
    content.left < container.left - tolerance ||
    content.top < container.top - tolerance ||
    content.right > container.right + tolerance ||
    content.bottom > container.bottom + tolerance
  ) {
    throw new Error(
      `${label} is outside its game container: ${JSON.stringify({ container, content })}`,
    );
  }
}
