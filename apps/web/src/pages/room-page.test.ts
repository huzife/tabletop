import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmManualRoomLeave } from "./room-page";

describe("manual room leave confirmation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not prompt outside an active match", () => {
    const confirm = vi.spyOn(window, "confirm");

    expect(confirmManualRoomLeave("lobby")).toBe(true);
    expect(confirmManualRoomLeave("post_match")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("warns that a confirmed active-match leave cannot reconnect", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    expect(confirmManualRoomLeave("playing")).toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      "对局正在进行。确定离开后将立即退出本局，且不能重连，是否继续？",
    );
  });
});
