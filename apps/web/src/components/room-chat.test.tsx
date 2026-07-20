import { chatMessageSchema, type ChatMessage } from "@tabletop/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoomChat } from "./room-chat";

describe("RoomChat", () => {
  afterEach(cleanup);

  it("follows new messages only while the message list is at the bottom", () => {
    let scrollHeight = 300;
    const { rerender } = render(
      <RoomChat canSend messages={[chatMessage(1)]} onSend={() => true} />,
    );
    const messageList = screen.getByRole("log");
    Object.defineProperties(messageList, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });

    messageList.scrollTop = 200;
    fireEvent.scroll(messageList);
    scrollHeight = 340;
    rerender(<RoomChat canSend messages={[chatMessage(1), chatMessage(2)]} onSend={() => true} />);
    expect(messageList.scrollTop).toBe(240);

    messageList.scrollTop = 80;
    fireEvent.scroll(messageList);
    scrollHeight = 380;
    rerender(
      <RoomChat
        canSend
        messages={[chatMessage(1), chatMessage(2), chatMessage(3)]}
        onSend={() => true}
      />,
    );
    expect(messageList.scrollTop).toBe(80);
  });

  it("sends with Enter while preserving Shift+Enter and input-method composition", () => {
    const onSend = vi.fn(() => true);
    render(<RoomChat canSend messages={[]} onSend={onSend} />);
    const composer = screen.getByLabelText("聊天消息");

    fireEvent.change(composer, { target: { value: "  测试消息  " } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(composer, { isComposing: true, key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(composer).toHaveValue("  测试消息  ");

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("测试消息");
    expect(composer).toHaveValue("");
  });
});

function chatMessage(number: number): ChatMessage {
  return chatMessageSchema.parse({
    memberId: `member-${number}`,
    messageId: `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`,
    senderName: `玩家 ${number}`,
    sentAt: `2026-01-01T00:0${number}:00.000Z`,
    text: `消息 ${number}`,
  });
}
