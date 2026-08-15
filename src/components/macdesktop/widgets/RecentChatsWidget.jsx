import { useQuery } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';

import { fetchLyknChatsWithContext } from '@/lib/lyknChat/fetchLyknChatsWithContext';
import { relativeTime } from '@/components/projects/projectShared';

import { WidgetAddButton, WidgetEmpty, WidgetFrame, WidgetHeader, rowsForSize } from './shared';

/** Your last conversations, newest first. A row resumes that chat on Home. */
export default function RecentChatsWidget({ userId, size = 'medium', onOpen }) {
  const { data: chats = [] } = useQuery({
    queryKey: ['studio-rail-chats', userId || 'guest'],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: () => fetchLyknChatsWithContext(userId, 30),
  });

  const visible = chats.slice(0, rowsForSize(size, { small: 3, medium: 3, large: 8 }));
  const openChat = (id) => onOpen?.('chat', `/chat/${encodeURIComponent(id)}`);
  const newChat = () => onOpen?.('chat', `/app?nc=${Date.now()}`);

  return (
    <WidgetFrame className="flex flex-col p-3.5">
      <WidgetHeader
        label="Chats"
        tone="text-violet-500"
        onClick={newChat}
        action={<WidgetAddButton title="New chat" onClick={newChat} />}
      />
      <div className="mt-1.5 min-h-0 flex-1 space-y-0.5 overflow-hidden">
        {visible.length === 0 ? (
          <WidgetEmpty icon={MessageCircle} label="No chats yet" onClick={newChat} />
        ) : (
          visible.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => openChat(chat.id)}
              title={chat.title || 'Open chat'}
              className="flex w-full items-start gap-1.5 rounded-md py-0.5 text-left"
            >
              <MessageCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-black/30 dark:text-white/35" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.68rem] font-medium leading-tight text-black/85 dark:text-white/90">
                  {chat.title || 'New Chat'}
                </span>
                <span className="block truncate text-[0.58rem] leading-tight text-black/40 dark:text-white/40">
                  {relativeTime(chat.updated_at || chat.created_at)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </WidgetFrame>
  );
}
