import type { AuditLog } from "@tabletop/database";

const CSV_FORMULA_PREFIX = /^\s*[=+\-@]/;

function safeCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (CSV_FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

const header = [
  "时间",
  "操作者账号ID",
  "操作者",
  "操作",
  "目标类型",
  "目标ID",
  "目标",
  "结果",
  "来源IP",
  "请求ID",
  "附加信息",
];

export function auditCsvHeader(): string {
  return `\uFEFF${header.map((cell) => safeCell(cell)).join(",")}\r\n`;
}

export function auditLogToCsvRow(log: AuditLog): string {
  const row = [
    new Date(log.createdAt).toISOString(),
    log.actorAccountId,
    log.actorUsername,
    log.action,
    log.targetType,
    log.targetId,
    log.targetLabel,
    log.result,
    log.sourceIp,
    log.requestId,
    log.metadataJson,
  ];
  return `${row.map((cell) => safeCell(cell)).join(",")}\r\n`;
}

export function auditLogsToCsv(logs: readonly AuditLog[]): string {
  return `${auditCsvHeader()}${logs.map((log) => auditLogToCsvRow(log)).join("")}`;
}
