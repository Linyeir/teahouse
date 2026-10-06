import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChatPath,
  MemoryNode,
  PathMessage,
  Settings,
  WorldBackground,
} from '@teahouse/shared';
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';
import { v7 as uuidv7 } from 'uuid';
import { api } from '../api.ts';
import { mergeFetched } from '../chat-state.ts';
import { BeatsText, formatStory, messageBeats } from '../components/Beats.tsx';
import { ErrorText } from '../components/Field.tsx';
import ui from '../components/ui.module.css';
import { streamBuffers, useConnection } from '../events.ts';
import { useCharacters, useWorlds } from '../queries.ts';
import styles from './ChatView.module.css';
import sceneStyles from './Scene.module.css';
import { EndScene, MemoryMarker, NewScene, ProposalReview } from './SceneParts.tsx';
import { VnStage } from './VnStage.tsx';

type ViewMode = 'vn' | 'log';

/** The chosen view, remembered per browser. */
function useViewMode(): [ViewMode, (mode: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => {
    try {
      return localStorage.getItem('teahouse.view') === 'log' ? 'log' : 'vn';
    } catch {
      return 'vn';
    }
  });
  const set = (next: ViewMode) => {
    setMode(next);
    try {
      localStorage.setItem('teahouse.view', next);
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
  };
  return [mode, set];
}

export function ChatView() {
  const { chatId = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const key = ['chat', chatId];

  const connection = useConnection();
  const path = useQuery({
    queryKey: key,
    queryFn: async () =>
      mergeFetched(await api.get<ChatPath>(`/api/chats/${chatId}`), streamBuffers),
    // Without live events (WebSocket blocked by a proxy, still reconnecting), poll while a
    // reply is being written, so it still shows up.
    refetchInterval: (query) =>
      connection !== 'open' && query.state.data?.messages.at(-1)?.status === 'streaming'
        ? 2000
        : false,
  });
  const worldId = path.data?.chat.worldId;
  const characters = useCharacters(worldId);
  const worlds = useWorlds();
  const backgrounds = useQuery({
    queryKey: ['worlds', worldId, 'backgrounds'],
    queryFn: () => api.get<WorldBackground[]>(`/api/worlds/${worldId}/backgrounds`),
    enabled: Boolean(worldId),
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  const [ending, setEnding] = useState(false);
  const [view, setView] = useViewMode();

  const refresh = (data?: ChatPath) => {
    if (data && 'chat' in data) queryClient.setQueryData(key, data);
    else void queryClient.invalidateQueries({ queryKey: key });
  };

  const send = useMutation({
    mutationFn: (content: string) =>
      api.post(`/api/chats/${chatId}/messages`, { id: uuidv7(), content }),
    onSettled: () => refresh(),
  });
  const generate = useMutation({
    mutationFn: () => api.post(`/api/chats/${chatId}/generate`),
    onSettled: () => refresh(),
  });
  const regenerate = useMutation({
    mutationFn: (messageId: string) => api.post(`/api/messages/${messageId}/regenerate`),
    onSettled: () => refresh(),
  });
  const stop = useMutation({
    mutationFn: (messageId: string) => api.post(`/api/messages/${messageId}/stop`),
  });
  const selectLeaf = useMutation({
    mutationFn: (messageId: string) =>
      api.post<ChatPath>(`/api/chats/${chatId}/leaf`, { messageId }),
    onSuccess: refresh,
  });
  const edit = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      api.put(`/api/messages/${id}`, { content }),
    onSettled: () => refresh(),
  });
  const rename = useMutation({
    mutationFn: (title: string) => api.patch<ChatPath>(`/api/chats/${chatId}`, { title }),
    onSuccess: (data) => {
      refresh(data);
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/chats/${chatId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chats'] });
      navigate('/');
    },
  });

  const messages = path.data?.messages ?? [];
  const last = messages.at(-1);
  const streaming = last?.status === 'streaming' ? last : undefined;

  const scroller = useRef<HTMLDivElement>(null);
  const lastLength = last?.content.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the tail grows
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLength]);

  if (path.error) return <ErrorText error={path.error} />;
  if (!path.data) return <div className={ui.page}>{t('common.loading')}</div>;

  const data = path.data;
  const scene = data.scene;
  const active = scene?.status === 'active';
  const names = new Map((characters.data ?? []).map((c) => [c.slug, c.name]));
  const userName = settings.data?.userName ?? 'User';
  const lastAssistant = last?.role === 'assistant' ? last : undefined;
  const actionError = send.error ?? generate.error ?? regenerate.error ?? edit.error;
  const canGenerate = active && !streaming && (!last || last.role === 'user');
  const memoryAt = new Map(data.memory.map((node) => [node.messageId, node]));

  return (
    <>
      <header className={styles.header}>
        <h2 className={styles.title}>{data.chat.title}</h2>
        <button
          className={ui.ghost}
          type="button"
          aria-pressed={view === 'log'}
          onClick={() => setView(view === 'vn' ? 'log' : 'vn')}
        >
          {view === 'vn' ? t('vn.showLog') : t('vn.showNovel')}
        </button>
        {active && (
          <button
            className={ui.button}
            type="button"
            disabled={Boolean(streaming)}
            onClick={() => setEnding(true)}
          >
            {t('scenes.end')}
          </button>
        )}
        <button
          className={ui.ghost}
          type="button"
          onClick={() => {
            const title = window.prompt(t('chats.rename'), data.chat.title)?.trim();
            if (title) rename.mutate(title);
          }}
        >
          {t('chats.rename')}
        </button>
        <button
          className={ui.ghost}
          type="button"
          onClick={() => {
            if (window.confirm(t('common.confirmDelete', { name: data.chat.title }))) {
              remove.mutate();
            }
          }}
        >
          {t('common.delete')}
        </button>
      </header>
      <div className={`${styles.messages} ${view === 'vn' ? styles.novel : ''}`} ref={scroller}>
        {view === 'vn' && worldId && (
          <>
            <VnStage
              worldId={worldId}
              messages={messages}
              cast={scene?.cast ?? []}
              characters={characters.data ?? []}
              backgrounds={backgrounds.data ?? []}
              theme={worlds.data?.find((w) => w.id === worldId)?.theme ?? {}}
              userName={userName}
            />
            {lastAssistant && !streaming && <ReplyNotice message={lastAssistant} />}
            {lastAssistant && active && !streaming && (
              <MessageTools
                message={lastAssistant}
                canRegenerate={lastAssistant.id !== scene?.startMessageId}
                onSelect={(id) => selectLeaf.mutate(id)}
                onRegenerate={() => regenerate.mutate(lastAssistant.id)}
              />
            )}
          </>
        )}
        {view === 'log' &&
          data.closedScenes.map((closed) => (
            <details key={closed.scene.id} className={sceneStyles.closed}>
              <summary>
                {t('scenes.title', { n: closed.scene.number })} ·{' '}
                {closed.scene.canonCommit ? t('scenes.closedWithCanon') : t('scenes.closed')}
              </summary>
              {closed.messages.map((message) => (
                <MessageView
                  key={message.id}
                  message={message}
                  names={names}
                  userName={userName}
                  readOnly
                />
              ))}
            </details>
          ))}
        {view === 'log' && scene && (
          <div className={sceneStyles.sceneHeader}>
            {t('scenes.title', { n: scene.number })}
            {scene.status !== 'active' && ` · ${t(`scenes.status.${scene.status}`)}`}
          </div>
        )}
        {view === 'log' &&
          messages.map((message) => (
            <Fragment key={message.id}>
              <MessageView
                message={message}
                names={names}
                userName={userName}
                isLast={message === last}
                readOnly={!active}
                canRegenerate={message.id !== scene?.startMessageId}
                onSelect={(id) => selectLeaf.mutate(id)}
                onRegenerate={() => regenerate.mutate(message.id)}
                onEdit={(content) => edit.mutate({ id: message.id, content })}
              />
              {memoryAt.has(message.id) && (
                <MemoryMarker node={memoryAt.get(message.id) as MemoryNode} />
              )}
            </Fragment>
          ))}
        {canGenerate && last && (
          <div className={styles.message}>
            <button className={ui.button} type="button" onClick={() => generate.mutate()}>
              {t('chats.retry')}
            </button>
          </div>
        )}
        <div className={styles.message}>
          <ErrorText
            error={
              actionError && 'code' in actionError && actionError.code === 'no_profile'
                ? t('chats.noProfile')
                : actionError
            }
          />
        </div>
        {ending && active && <EndScene chatId={chatId} onDone={() => setEnding(false)} />}
        {scene?.status === 'closing' && <ProposalReview chatId={chatId} sceneId={scene.id} />}
        {scene?.status === 'closed' && <NewScene key={scene.id} path={data} />}
      </div>
      {active && (
        <Composer
          streaming={Boolean(streaming)}
          onSend={(content) => send.mutate(content)}
          onStop={() => streaming && stop.mutate(streaming.id)}
        />
      )}
    </>
  );
}

function MessageView({
  message,
  names,
  userName,
  isLast = false,
  readOnly = false,
  canRegenerate = true,
  onSelect = () => {},
  onRegenerate = () => {},
  onEdit = () => {},
}: {
  message: PathMessage;
  names: Map<string, string>;
  userName: string;
  isLast?: boolean;
  readOnly?: boolean;
  canRegenerate?: boolean;
  onSelect?: (id: string) => void;
  onRegenerate?: () => void;
  onEdit?: (content: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const streaming = message.status === 'streaming';

  return (
    <div className={`${styles.message} ${message.role === 'user' ? styles.user : ''}`}>
      {draft === null ? (
        <div className={`${styles.body} ${streaming ? styles.cursor : ''}`}>
          {message.role === 'user' ? (
            formatStory(message.content)
          ) : (
            <BeatsText beats={messageBeats(message)} names={names} userName={userName} />
          )}
        </div>
      ) : (
        <div className={ui.form}>
          <textarea
            className={ui.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(20, draft.split('\n').length + 2)}
          />
          <div className={ui.actions}>
            <button className={ui.button} type="button" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </button>
            <button
              className={ui.primary}
              type="button"
              onClick={() => {
                onEdit(draft);
                setDraft(null);
              }}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      )}
      {message.status === 'error' && (
        <p className={ui.error}>{t('chats.error', { message: message.error })}</p>
      )}
      {message.status === 'stopped' && <p className={ui.hint}>{t('chats.stopped')}</p>}
      {!streaming && !readOnly && draft === null && (
        <MessageTools
          message={message}
          canRegenerate={isLast && canRegenerate}
          onSelect={onSelect}
          onRegenerate={onRegenerate}
          onEdit={() => setDraft(message.content)}
        />
      )}
    </div>
  );
}

/**
 * The novel view only shows beats, so a reply that failed, was stopped or came back empty
 * needs to be said out loud there.
 */
function ReplyNotice({ message }: { message: PathMessage }) {
  const { t } = useTranslation();
  if (message.status === 'error') {
    return (
      <p className={`${ui.error} ${styles.notice}`} role="alert">
        {t('chats.error', { message: message.error })}
      </p>
    );
  }
  if (message.status === 'stopped')
    return <p className={`${ui.hint} ${styles.notice}`}>{t('chats.stopped')}</p>;
  if (messageBeats(message).length === 0) {
    return <p className={`${ui.hint} ${styles.notice}`}>{t('chats.emptyReply')}</p>;
  }
  return null;
}

/** Swiping between siblings, edit and regenerate for one message. */
function MessageTools({
  message,
  canRegenerate,
  onSelect,
  onRegenerate,
  onEdit,
}: {
  message: PathMessage;
  canRegenerate: boolean;
  onSelect: (id: string) => void;
  onRegenerate: () => void;
  onEdit?: () => void;
}) {
  const { t } = useTranslation();
  const index = message.siblingIds.indexOf(message.id);
  const count = message.siblingIds.length;
  return (
    <div className={styles.tools}>
      {count > 1 && (
        <>
          <button
            className={ui.ghost}
            type="button"
            disabled={index <= 0}
            aria-label={t('chats.previousVersion')}
            onClick={() => onSelect(message.siblingIds[index - 1] ?? message.id)}
          >
            ‹
          </button>
          <span>
            {index + 1}/{count}
          </span>
          <button
            className={ui.ghost}
            type="button"
            disabled={index >= count - 1}
            aria-label={t('chats.nextVersion')}
            onClick={() => onSelect(message.siblingIds[index + 1] ?? message.id)}
          >
            ›
          </button>
        </>
      )}
      {onEdit && (
        <button className={ui.ghost} type="button" onClick={onEdit}>
          {t('common.edit')}
        </button>
      )}
      {canRegenerate && message.role === 'assistant' && message.parentId !== null && (
        <button className={ui.ghost} type="button" onClick={onRegenerate}>
          {t('chats.regenerate')}
        </button>
      )}
    </div>
  );
}

function Composer({
  streaming,
  onSend,
  onStop,
}: {
  streaming: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  const submit = () => {
    const content = text.trim();
    if (!content || streaming) return;
    onSend(content);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.composer}>
      <div className={styles.composerInner}>
        <textarea
          className={ui.input}
          placeholder={t('chats.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button className={ui.button} type="button" onClick={onStop}>
            {t('chats.stop')}
          </button>
        ) : (
          <button className={ui.primary} type="button" onClick={submit} disabled={!text.trim()}>
            {t('chats.send')}
          </button>
        )}
      </div>
    </div>
  );
}
