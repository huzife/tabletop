import type { AuditLog } from "@tabletop/database";
import { describe, expect, it } from "vitest";

import { auditLogsToCsv } from "./csv.js";

describe("auditLogsToCsv", () => {
  it("quotes CSV and neutralizes spreadsheet formulas", () => {
    const log: AuditLog = {
      action: "account.create",
      actorAccountId: null,
      actorUsername: "=danger",
      createdAt: 0,
      id: "01H00000000000000000000000",
      metadataJson: '{"note":"a,b"}',
      requestId: "request-1",
      result: "success",
      sourceIp: null,
      targetId: null,
      targetLabel: '包含"引号',
      targetType: "account",
    };

    const csv = auditLogsToCsv([log]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"\'=danger"');
    expect(csv).toContain('"包含""引号"');
    expect(csv).toContain('"{""note"":""a,b""}"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
