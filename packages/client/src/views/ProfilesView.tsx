import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModelList, Profile, ProfileInput, Settings } from '@teahouse/shared';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { ErrorText, Field } from '../components/Field.tsx';
import ui from '../components/ui.module.css';

const PRESETS = [
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { name: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
];

/** Form state keeps numbers as strings so fields can be empty while typing. */
interface Draft {
  id: string | null;
  hasApiKey: boolean;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  contextWindowOverride: string;
}

const blank: Draft = {
  id: null,
  hasApiKey: false,
  name: '',
  baseUrl: PRESETS[0]?.baseUrl ?? '',
  apiKey: '',
  model: '',
  temperature: '',
  topP: '',
  maxTokens: '',
  contextWindowOverride: '',
};

const fromProfile = (p: Profile): Draft => ({
  id: p.id,
  hasApiKey: p.hasApiKey,
  name: p.name,
  baseUrl: p.baseUrl,
  apiKey: '',
  model: p.model,
  temperature: p.temperature?.toString() ?? '',
  topP: p.topP?.toString() ?? '',
  maxTokens: p.maxTokens?.toString() ?? '',
  contextWindowOverride: p.contextWindowOverride?.toString() ?? '',
});

/** Select value that switches the model field to free text. */
const CUSTOM = '__custom__';

const num = (value: string) => (value.trim() === '' ? null : Number(value));

function toInput(d: Draft): ProfileInput {
  return {
    name: d.name,
    baseUrl: d.baseUrl,
    // On edit an empty field keeps the stored key.
    ...(d.apiKey !== '' || d.id === null ? { apiKey: d.apiKey } : {}),
    model: d.model,
    temperature: num(d.temperature),
    topP: num(d.topP),
    maxTokens: num(d.maxTokens),
    contextWindowOverride: num(d.contextWindowOverride),
  };
}

export function ProfilesView() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/api/profiles'),
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['profiles'] });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id ? api.put(`/api/profiles/${d.id}`, toInput(d)) : api.post('/api/profiles', toInput(d)),
    onSuccess: () => {
      setDraft(null);
      void invalidate();
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/profiles/${id}`),
    onSuccess: invalidate,
  });
  const detect = useMutation({
    mutationFn: (id: string) => api.post(`/api/profiles/${id}/detect-context`),
    onSuccess: invalidate,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
  });
  const assignNarrator = useMutation({
    mutationFn: (id: string) =>
      api.put<Settings>('/api/settings', { ...settings.data, narratorProfileId: id }),
    onSuccess: (data) => queryClient.setQueryData(['settings'], data),
  });
  // The narrator falls back to the first profile when none is set.
  const narratorId = settings.data?.narratorProfileId ?? profiles.data?.[0]?.id;
  const rolesOf = (id: string) => {
    const s = settings.data;
    if (!s) return [];
    const resolve = (own: string | null) => own ?? narratorId;
    return (
      [
        ['narrator', narratorId],
        ['summary', resolve(s.summaryProfileId)],
        ['canon', resolve(s.canonProfileId)],
        ['scene', resolve(s.sceneProfileId)],
      ] as const
    )
      .filter(([, profileId]) => profileId === id)
      .map(([role]) => role);
  };

  if (draft) return <ProfileForm draft={draft} setDraft={setDraft} save={save} />;

  return (
    <div className={ui.page}>
      <h2 className={ui.title}>{t('nav.profiles')}</h2>
      {profiles.data?.length === 0 && <p className={ui.muted}>{t('profiles.empty')}</p>}
      <ul className={ui.list}>
        {profiles.data?.map((p) => {
          const context = p.contextWindowOverride ?? p.detectedContextWindow;
          return (
            <li key={p.id} className={ui.listItem}>
              <div className={ui.grow}>
                <div>
                  {p.name}{' '}
                  {rolesOf(p.id).map((role) => (
                    <span key={role} className={ui.badge}>
                      {t(`profiles.role.${role}`)}
                    </span>
                  ))}
                </div>
                <div className={ui.hint}>
                  {p.model} · {p.baseUrl}
                  <br />
                  {context
                    ? t('profiles.detected', { value: context.toLocaleString() })
                    : t('profiles.notDetected')}
                </div>
              </div>
              {p.id !== narratorId && (
                <button
                  className={ui.button}
                  type="button"
                  disabled={!settings.data || assignNarrator.isPending}
                  onClick={() => assignNarrator.mutate(p.id)}
                >
                  {t('profiles.useForNarrator')}
                </button>
              )}
              <button className={ui.ghost} type="button" onClick={() => detect.mutate(p.id)}>
                {t('profiles.detect')}
              </button>
              <button
                className={ui.ghost}
                type="button"
                onClick={() => {
                  if (window.confirm(t('common.confirmDelete', { name: p.name }))) {
                    remove.mutate(p.id);
                  }
                }}
              >
                {t('common.delete')}
              </button>
              <button className={ui.button} type="button" onClick={() => setDraft(fromProfile(p))}>
                {t('common.edit')}
              </button>
            </li>
          );
        })}
      </ul>
      <button className={ui.primary} type="button" onClick={() => setDraft(blank)}>
        {t('profiles.new')}
      </button>
    </div>
  );
}

function ProfileForm({
  draft,
  setDraft,
  save,
}: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  save: { mutate: (d: Draft) => void; error: Error | null; isPending: boolean };
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const [typing, setTyping] = useState(false);
  const models = useMutation({
    mutationFn: () =>
      api.post<ModelList>('/api/endpoints/models', {
        baseUrl: draft.baseUrl,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : draft.id ? { profileId: draft.id } : {}),
      }),
    onSuccess: ({ models: list }) => {
      setTyping(false);
      // A single loaded model (typical for LM Studio and llama.cpp) is the obvious choice.
      if (!draft.model && list.length === 1 && list[0]) set({ model: list[0] });
    },
  });
  const loaded = models.data?.models ?? [];

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft);
  };
  const optional = `(${t('profiles.optional')})`;

  return (
    <div className={ui.page}>
      <h2 className={ui.title}>{draft.id ? draft.name : t('profiles.new')}</h2>
      <form className={ui.form} onSubmit={onSubmit}>
        <div className={ui.row}>
          <Field label={t('profiles.name')}>
            <input
              className={ui.input}
              required
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label={t('profiles.preset')}>
            <select
              className={ui.input}
              value={PRESETS.find((p) => p.baseUrl === draft.baseUrl)?.baseUrl ?? ''}
              onChange={(e) => {
                const preset = PRESETS.find((p) => p.baseUrl === e.target.value);
                if (preset) set({ baseUrl: preset.baseUrl, name: draft.name || preset.name });
              }}
            >
              <option value="">—</option>
              {PRESETS.map((p) => (
                <option key={p.baseUrl} value={p.baseUrl}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('profiles.baseUrl')}>
          <input
            className={ui.input}
            type="url"
            required
            value={draft.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
          />
        </Field>
        <Field
          label={`${t('profiles.apiKey')} ${optional}`}
          hint={draft.hasApiKey ? t('profiles.apiKeyStored') : undefined}
        >
          <input
            className={ui.input}
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
          />
        </Field>
        <div className={ui.row}>
          <Field label={t('profiles.model')}>
            {loaded.length > 0 && !typing ? (
              <select
                className={ui.input}
                required
                value={draft.model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) setTyping(true);
                  else set({ model: e.target.value });
                }}
              >
                <option value="" disabled>
                  {t('profiles.chooseModel', { count: loaded.length })}
                </option>
                {draft.model && !loaded.includes(draft.model) && (
                  <option value={draft.model}>{draft.model}</option>
                )}
                {loaded.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM}>{t('profiles.typeModel')}</option>
              </select>
            ) : (
              <input
                className={ui.input}
                required
                value={draft.model}
                onChange={(e) => set({ model: e.target.value })}
              />
            )}
          </Field>
          <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <button
              className={ui.button}
              type="button"
              disabled={models.isPending}
              onClick={() => models.mutate()}
            >
              {t('profiles.loadModels')}
            </button>
          </div>
        </div>
        <ErrorText error={models.error} />
        <div className={ui.row}>
          <Field label={`${t('profiles.temperature')} ${optional}`}>
            <input
              className={ui.input}
              type="number"
              step="0.05"
              min="0"
              max="2"
              value={draft.temperature}
              onChange={(e) => set({ temperature: e.target.value })}
            />
          </Field>
          <Field label={`${t('profiles.topP')} ${optional}`}>
            <input
              className={ui.input}
              type="number"
              step="0.01"
              min="0"
              max="1"
              value={draft.topP}
              onChange={(e) => set({ topP: e.target.value })}
            />
          </Field>
        </div>
        <div className={ui.row}>
          <Field label={`${t('profiles.maxTokens')} ${optional}`}>
            <input
              className={ui.input}
              type="number"
              min="1"
              value={draft.maxTokens}
              onChange={(e) => set({ maxTokens: e.target.value })}
            />
          </Field>
          <Field label={`${t('profiles.contextOverride')} ${optional}`}>
            <input
              className={ui.input}
              type="number"
              min="1"
              value={draft.contextWindowOverride}
              onChange={(e) => set({ contextWindowOverride: e.target.value })}
            />
          </Field>
        </div>
        <ErrorText error={save.error} />
        <div className={ui.actions}>
          <button className={ui.button} type="button" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </button>
          <button className={ui.primary} type="submit" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
