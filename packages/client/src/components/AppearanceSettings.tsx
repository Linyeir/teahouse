import { THEME_PRESETS, type ThemeModePreference } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { setThemeSettings, useThemeSettings } from '../theme.ts';
import { Field } from './Field.tsx';
import ui from './ui.module.css';

const MODES: { value: ThemeModePreference; label: string }[] = [
  { value: 'system', label: 'settings.modeSystem' },
  { value: 'light', label: 'settings.modeLight' },
  { value: 'dark', label: 'settings.modeDark' },
];

/** Theme, light/dark and world themes. Stored per device and applied at once, like the language. */
export function AppearanceSettings() {
  const { t } = useTranslation();
  const theme = useThemeSettings();
  const preset = THEME_PRESETS.find((p) => p.id === theme.preset) ?? THEME_PRESETS[0];
  const fixedMode = preset.modes.length === 1;

  return (
    <section className={ui.form}>
      <h3 style={{ marginBottom: 0 }}>{t('settings.appearance')}</h3>
      <span className={ui.hint}>{t('settings.appearanceHint')}</span>
      <div className={ui.row}>
        <Field label={t('settings.theme')}>
          <select
            className={ui.input}
            value={theme.preset}
            onChange={(e) =>
              setThemeSettings({ preset: e.target.value as (typeof THEME_PRESETS)[number]['id'] })
            }
          >
            {THEME_PRESETS.map((p) => {
              const name = t(`themes.${p.id}`);
              const label =
                p.modes.length > 1
                  ? name
                  : t(p.modes[0] === 'light' ? 'settings.onlyLight' : 'settings.onlyDark', {
                      name,
                    });
              return (
                <option key={p.id} value={p.id}>
                  {label}
                </option>
              );
            })}
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
    </section>
  );
}
