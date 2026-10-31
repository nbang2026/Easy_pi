import type { ConversationEvent } from "./conversation-view";
import { formatUserError } from "./utils.ts";

type Target = { bridgeId: string; sessionId: string };
type History = { sessionId: string; messages: ConversationEvent[]; truncated?: boolean };

export function createConversationSync(options: {
  load(): Promise<History>;
  clear(): void;
  restore(messages: ConversationEvent[]): void;
  consume(event: ConversationEvent): void;
  notice(message: string): void;
}) {
  let target: Target | undefined;
  let generation = 0;
  let loading = false;
  let buffered: ConversationEvent[] = [];
  return {
    observe(next?: Target) {
      if (target?.bridgeId === next?.bridgeId && target?.sessionId === next?.sessionId) return;
      const initial = !target;
      target = next;
      const version = ++generation;
      buffered = [];
      loading = false;
      if (!initial || !next) options.clear();
      if (!next?.bridgeId || !next.sessionId) return;
      loading = true;
      void options.load().then(history => {
        if (version !== generation) return;
        if (history.sessionId !== next.sessionId) throw new Error("会话已变化，请重新打开该会话。");
        options.restore(history.messages);
        if (history.truncated) options.notice("已显示最近的会话内容，完整记录仍保存在本地。");
      }).catch(error => {
        if (version === generation) options.notice(`会话历史加载失败：${formatUserError(error)}`);
      }).finally(() => {
        if (version !== generation) return;
        loading = false;
        for (const event of buffered) options.consume(event);
        buffered = [];
      });
    },
    consume(event: ConversationEvent & { bridgeId?: string }) {
      if (!target || event.bridgeId !== target.bridgeId || event.sessionId !== target.sessionId) return;
      if (loading) {
        const previous = event.messageId && event.append === false
          ? buffered.findIndex(item => item.messageId === event.messageId && item.role === event.role) : -1;
        if (previous !== -1) {
          // A full replacement supersedes every older chunk of this message.
          buffered = buffered.filter((item, index) => index === previous
            || item.messageId !== event.messageId || item.role !== event.role);
          buffered[previous] = event;
        }
        else if (buffered.length < 1000) buffered.push(event);
        else {
          buffered.shift(); buffered.push(event);
          options.notice("会话加载期间收到的内容较多，已保留最近消息。");
        }
      }
      else options.consume(event);
    },
  };
}
