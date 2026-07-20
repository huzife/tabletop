import type { ChatMessage } from "@tabletop/protocol";
import { IconButton } from "@tabletop/ui";
import { MessageSquare, Send } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type UIEvent,
} from "react";

const CHAT_BOTTOM_TOLERANCE_PX = 2;

interface RoomChatProps {
  readonly canSend: boolean;
  readonly messages: readonly ChatMessage[];
  readonly onSend: (text: string) => boolean;
}

export function RoomChat({ canSend, messages, onSend }: RoomChatProps) {
  const [draft, setDraft] = useState("");
  const messageListRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const latestMessageId = messages.at(-1)?.messageId;

  useLayoutEffect(() => {
    const messageList = messageListRef.current;
    if (messageList === null || !shouldStickToBottomRef.current) return;
    messageList.scrollTop = Math.max(0, messageList.scrollHeight - messageList.clientHeight);
  }, [latestMessageId]);

  function submitDraft() {
    const text = draft.trim();
    if (!text || !canSend) return;
    if (onSend(text)) setDraft("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitDraft();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submitDraft();
  }

  function handleMessageListScroll(event: UIEvent<HTMLDivElement>) {
    const messageList = event.currentTarget;
    const distanceFromBottom =
      messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= CHAT_BOTTOM_TOLERANCE_PX;
  }

  return (
    <aside aria-label="房间聊天" className="room-chat">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">房间</span>
          <h2>聊天</h2>
        </div>
        <MessageSquare size={19} />
      </div>
      <div
        aria-live="polite"
        className="message-list"
        onScroll={handleMessageListScroll}
        ref={messageListRef}
        role="log"
      >
        {messages.length > 0 ? (
          messages.map((message) => (
            <article className="chat-message" key={message.messageId}>
              <div>
                <strong>{message.senderName}</strong>
                <time dateTime={message.sentAt}>{formatChatTime(message.sentAt)}</time>
              </div>
              <p>{message.text}</p>
            </article>
          ))
        ) : (
          <div className="chat-empty">还没有聊天消息</div>
        )}
      </div>
      <form className="chat-composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="chat-message">
          聊天消息
        </label>
        <textarea
          disabled={!canSend}
          id="chat-message"
          maxLength={500}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息"
          rows={3}
          value={draft}
        />
        <div>
          <span>{draft.length} / 500</span>
          <IconButton
            disabled={!canSend || !draft.trim()}
            icon={<Send size={18} />}
            label="发送消息"
            type="submit"
          />
        </div>
      </form>
    </aside>
  );
}

function formatChatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  }).format(date);
}
