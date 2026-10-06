import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CharacterSummary,
  DEFAULT_IMAGE_LABELS,
  type WorldBackground,
} from '@teahouse/shared';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, assetUrl } from '../api.ts';
import { useCharacters } from '../queries.ts';
import { ErrorText, Field } from './Field.tsx';
import styles from './ImageManager.module.css';
import ui from './ui.module.css';

function useUpload(url: string, onDone: () => void) {
  return useMutation({
    mutationFn: (form: FormData) => api.upload(url, form),
    onSuccess: onDone,
  });
}

/** Images of one character, by label. */
export function CharacterImages({ worldId, slug }: { worldId: string; slug: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const characters = useCharacters(worldId);
  const character = characters.data?.find((c: CharacterSummary) => c.slug === slug);
  const [label, setLabel] = useState('neutral');
  const fileInput = useRef<HTMLInputElement>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['worlds', worldId] });
  const upload = useUpload(`/api/worlds/${worldId}/characters/${slug}/images`, () => {
    if (fileInput.current) fileInput.current.value = '';
    void invalidate();
  });
  const remove = useMutation({
    mutationFn: (imageId: string) =>
      api.delete(`/api/worlds/${worldId}/characters/${slug}/images/${imageId}`),
    onSuccess: invalidate,
  });
  if (!character) return null;

  const missing = DEFAULT_IMAGE_LABELS.filter((l) => !character.images.some((i) => i.label === l));
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    upload.mutate(form);
  };

  return (
    <div className={styles.panel}>
      <h4 className={styles.title}>{t('images.characterTitle', { name: character.name })}</h4>
      <div className={styles.grid}>
        {character.images.map((image) => (
          <figure key={image.id} className={styles.item}>
            <img src={assetUrl(worldId, image.file)} alt={image.label} />
            <figcaption>
              {image.label}
              <button
                className={ui.ghost}
                type="button"
                aria-label={t('images.remove', { label: image.label })}
                onClick={() => remove.mutate(image.id)}
              >
                ×
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
      {missing.length > 0 && (
        <p className={ui.hint}>{t('images.missing', { labels: missing.join(', ') })}</p>
      )}
      <form className={ui.row} onSubmit={onSubmit}>
        <Field label={t('images.label')}>
          <input
            className={ui.input}
            name="label"
            list="teahouse-labels"
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <datalist id="teahouse-labels">
            {DEFAULT_IMAGE_LABELS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </Field>
        <Field label={t('images.file')}>
          <input
            ref={fileInput}
            className={ui.input}
            name="file"
            type="file"
            accept="image/*"
            required
          />
        </Field>
        <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
          <button className={ui.primary} type="submit" disabled={upload.isPending}>
            {t('images.upload')}
          </button>
        </div>
      </form>
      <ErrorText error={upload.error ?? remove.error} />
    </div>
  );
}

/** Backgrounds of a world; the narrator picks them by ID and description. */
export function WorldBackgrounds({ worldId }: { worldId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const backgrounds = useQuery({
    queryKey: ['worlds', worldId, 'backgrounds'],
    queryFn: () => api.get<WorldBackground[]>(`/api/worlds/${worldId}/backgrounds`),
  });
  const formRef = useRef<HTMLFormElement>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['worlds', worldId] });
  const upload = useUpload(`/api/worlds/${worldId}/backgrounds`, () => {
    formRef.current?.reset();
    void invalidate();
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/worlds/${worldId}/backgrounds/${id}`),
    onSuccess: invalidate,
  });

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>{t('images.backgroundsTitle')}</h3>
      <div className={styles.grid}>
        {backgrounds.data?.map((bg) => (
          <figure key={bg.id} className={`${styles.item} ${styles.wide}`}>
            <img src={assetUrl(worldId, bg.file)} alt={bg.description} />
            <figcaption>
              <span title={bg.description}>{bg.id}</span>
              <button
                className={ui.ghost}
                type="button"
                aria-label={t('images.remove', { label: bg.id })}
                onClick={() => remove.mutate(bg.id)}
              >
                ×
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
      <form
        ref={formRef}
        className={ui.row}
        onSubmit={(e) => {
          e.preventDefault();
          upload.mutate(new FormData(e.currentTarget));
        }}
      >
        <Field label={t('images.backgroundName')}>
          <input className={ui.input} name="id" required placeholder="tavern-night" />
        </Field>
        <Field label={t('images.description')}>
          <input
            className={ui.input}
            name="description"
            placeholder={t('images.descriptionHint')}
          />
        </Field>
        <Field label={t('images.file')}>
          <input className={ui.input} name="file" type="file" accept="image/*" required />
        </Field>
        <div style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
          <button className={ui.primary} type="submit" disabled={upload.isPending}>
            {t('images.upload')}
          </button>
        </div>
      </form>
      <ErrorText error={upload.error ?? remove.error} />
    </div>
  );
}
