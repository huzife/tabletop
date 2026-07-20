import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { createRepositories, openDatabase } from "@tabletop/database";

import { bootstrapAdmin } from "../admin/bootstrap.js";
import { PasswordService } from "../auth/password.js";

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    const value = process.env.TABLETOP_ADMIN_PASSWORD;
    if (!value) {
      throw new Error("非交互环境必须通过 TABLETOP_ADMIN_PASSWORD 提供一次性初始密码");
    }
    return value;
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          reject(new Error("已取消管理员初始化"));
          return;
        }
        if (character === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }

        value += character;
        stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  if (process.argv[2] !== "init") {
    throw new Error("用法: pnpm --filter @tabletop/server admin:init");
  }

  const databasePath = resolve(process.env.DATABASE_PATH ?? "./var/tabletop.db");
  mkdirSync(dirname(databasePath), { recursive: true });
  const prompt = createInterface({ input: stdin, output: stdout });

  try {
    const usernameArgument = process.argv.find((argument) => argument.startsWith("--username="));
    const username =
      usernameArgument?.slice("--username=".length) ?? (await prompt.question("管理员用户名: "));
    prompt.close();
    const password = await readHidden("管理员密码: ");
    const confirmation = await readHidden("再次输入密码: ");
    if (password !== confirmation) {
      throw new Error("两次输入的密码不一致");
    }

    const connection = openDatabase(databasePath);
    try {
      const account = await bootstrapAdmin({
        password,
        passwords: new PasswordService(1),
        repositories: createRepositories(connection.database),
        username,
      });
      stdout.write(`管理员 ${account.username} 已创建。\n`);
    } finally {
      connection.close();
    }
  } finally {
    prompt.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`管理员初始化失败: ${message}\n`);
  process.exitCode = 1;
});
