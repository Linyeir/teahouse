import {
  type CustomTheme,
  type InstalledTheme,
  THEME_PRESETS,
  type ThemeMode,
  type ThemeModePreference,
  type ThemeNote,
} from '@teahouse/shared';
import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, RequestError } from '../api.ts';
import { syncCustomThemes, useCustomThemes } from '../customThemes.ts';
import { pushNotice, pushToast } from '../notices.ts';
import { useOnline } from '../offline.ts';
import { getThemeSettings, setThemeSettings, useThemeSettings } from '../theme.ts';
import { ConfirmDialog } from './Dialog.tsx';
import { Field } from './Field.tsx';
import ui from './ui.module.css';

const MODES: { value: ThemeModePreference; label: string }[] = [
  { value: 'system', label: 'settings.modeSystem' },
  { value: 'light', label: 'settings.modeLight' },
  { value: 'dark', label: 'settings.modeDark' },
];

const GUIDE = 'https://github.com/Linyeir/teahouse/blob/main/docs/theming.md#build-your-own-theme';

/** A theme's name for lists and badges: built-in names are translated, uploaded ones are not. */
export function themeName(t: TFunction, id: string, custom: readonly CustomTheme[]): string {
  return custom.find((c) => c.id === id)?.name ?? t(`themes.${id}`, { defaultValue: id });
}

function modeLabel(t: TFunction, name: string, modes: readonly ThemeMode[]) {
  if (modes.length > 1) return name;
  return t(modes[0] === 'light' ? 'settings.onlyLight' : 'settings.onlyDark', { name });
}

/** What the server left out or changed, one line per kind. */
function describeNotes(t: TFunction, notes: ThemeNote[]): string[] {
  const groups = new Map<string, string[]>();
  for (const note of notes) {
    if (note.code === 'renamed') continue;
    groups.set(note.code, [...(groups.get(note.code) ?? []), note.detail]);
  }
  return [...groups].map(([code, details]) => {
    const shown = [...new Set(details)];
    const items = shown.slice(0, 3).join(', ') + (shown.length > 3 ? ', …' : '');
    return t(`settings.themeNote.${code}`, { items });
  });
}

/** Theme, light/dark and world themes. Stored per device and applied at once, like the language. */
export function AppearanceSettings() {
  const { t } = useTranslation();
  const theme = useThemeSettings();
  const custom = useCustomThemes();
  const online = useOnline();
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<CustomTheme | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const modes =
    THEME_PRESETS.find((p) => p.id === theme.preset)?.modes ??
    custom.find((c) => c.id === theme.preset)?.modes ??
    THEME_PRESETS[0].modes;
  const fixedMode = modes.length === 1;

  async function upload(file: File) {
    setUploading(true);
    const previous = getThemeSettings().preset;
    try {
      const form = new FormData();
      form.append('file', file);
      const { theme: installed, notes } = await api.upload<InstalledTheme>('/api/themes', form);
      // The CSS must be on this device before the theme can show.
      await syncCustomThemes();
      setThemeSettings({ preset: installed.id });
      const renamed = notes.find((n) => n.code === 'renamed');
      pushToast(t('settings.themeInstalled', { name: installed.name }), {
        lines: [
          ...(renamed ? [t('settings.themeRenamed', { id: renamed.detail })] : []),
          ...describeNotes(t, notes),
        ],
        action: {
          label: t('settings.themeUndo'),
          onClick: () => void remove(installed, previous),
        },
      });
    } catch (err) {
      const code = err instanceof RequestError ? err.code : '';
      const known = ['not-zip', 'no-theme-css', 'too-large', 'too-many-files'];
      pushNotice(
        known.includes(code)
          ? t(`settings.themeError.${code}`)
          : t('settings.themeError.other', { message: (err as Error).message }),
        'error',
      );
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function remove(target: CustomTheme, fallback?: string) {
    if (getThemeSettings().preset === target.id) {
      setThemeSettings({ preset: fallback && fallback !== target.id ? fallback : 'standard' });
    }
    try {
      await api.delete(`/api/themes/${target.id}`);
      await syncCustomThemes();
    } catch (err) {
      pushNotice(t('settings.themeError.other', { message: (err as Error).message }), 'error');
    }
  }

  return (
    <section className={ui.form}>
      <h3 style={{ marginBottom: 0 }}>{t('settings.appearance')}</h3>
      <span className={ui.hint}>{t('settings.appearanceHint')}</span>
      <div className={ui.row}>
        <Field label={t('settings.theme')}>
          <select
            className={ui.input}
            value={theme.preset}
            onChange={(e) => setThemeSettings({ preset: e.target.value })}
          >
            {THEME_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {modeLabel(t, t(`themes.${p.id}`), p.modes)}
              </option>
            ))}
            {custom.length > 0 && (
              <optgroup label={t('settings.customThemes')}>
                {custom.map((c) => (
                  <option key={c.id} value={c.id}>
                    {modeLabel(t, c.name, c.modes)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <fieldset className={ui.field} style={{ border: 0, margin: 0, padding: 0 }}>
          <legend style={{ padding: 0, marginBottom: 4 }}>{t('settings.mode')}</legend>
          <div style={{ display: 'flex', gap: 'var(--space)', flexWrap: 'wrap' }}>
            {MODES.map((m) => (
              <label
                key={m.value}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  color: 'var(--color-text)',
                }}
              >
                <input
                  type="radio"
                  name="theme-mode"
                  value={m.value}
                  checked={theme.mode === m.value}
                  disabled={fixedMode}
                  onChange={() => setThemeSettings({ mode: m.value })}
                />
                {t(m.label)}
              </label>
            ))}
          </div>
          {fixedMode && <span className={ui.hint}>{t('settings.fixedMode')}</span>}
        </fieldset>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="checkbox"
          checked={theme.worldThemes}
          onChange={(e) => setThemeSettings({ worldThemes: e.target.checked })}
        />
        {t('settings.worldThemes')}
      </label>
      <span className={ui.hint}>{t('settings.worldThemesHint')}</span>

      <h4 style={{ marginBottom: 0 }}>{t('settings.customThemes')}</h4>
      <span className={ui.hint}>
        {t('settings.customThemesHint')}{' '}
        <a href={GUIDE} target="_blank" rel="noreferrer">
          {t('settings.customThemesGuide')}
        </a>
      </span>
      {custom.length > 0 && (
        <ul className={ui.list} style={{ margin: 0 }}>
          {custom.map((c) => (
            <li key={c.id} className={ui.listItem}>
              <div className={ui.grow}>
                <strong>{c.name}</strong>
                <div className={ui.hint}>
                  {[c.author && t('settings.themeBy', { author: c.author }), `themePreset: ${c.id}`]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <button
                className={ui.button}
                type="button"
                disabled={!online}
                onClick={() => setRemoving(c)}
              >
                {t('settings.removeTheme')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <button
          className={ui.button}
          type="button"
          disabled={uploading || !online}
          onClick={() => fileInput.current?.click()}
        >
          {uploading ? t('settings.uploadingTheme') : t('settings.uploadTheme')}
        </button>
        {!online && <div className={ui.hint}>{t('settings.uploadOffline')}</div>}
      </div>
      {removing && (
        <ConfirmDialog
          danger
          title={t('settings.confirmRemoveTheme', { name: removing.name })}
          confirm={t('settings.removeTheme')}
          onConfirm={() => {
            void remove(removing);
            setRemoving(null);
          }}
          onCancel={() => setRemoving(null)}
        >
          <p style={{ margin: 0 }}>{t('settings.removeThemeHint')}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
