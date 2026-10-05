import type { World } from '@teahouse/shared';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { CharacterRow } from '../components/StartChat.tsx';
import ui from '../components/ui.module.css';
import { useCharacters, useWorlds } from '../queries.ts';

export function HomeView() {
  const { t } = useTranslation();
  const worlds = useWorlds();

  return (
    <div className={ui.page}>
      {worlds.data?.length === 0 ? (
        <p className={ui.muted}>
          {t('home.noWorlds')} <Link to="/worlds">{t('home.toWorlds')}</Link>
        </p>
      ) : (
        <p className={ui.muted}>{t('chats.pick')}</p>
      )}
      {worlds.data?.map((world) => (
        <WorldCharacters key={world.id} world={world} />
      ))}
    </div>
  );
}

function WorldCharacters({ world }: { world: World }) {
  const characters = useCharacters(world.id);
  if (!characters.data?.length) return null;
  return (
    <>
      <h2 className={ui.title}>
        <Link to={`/worlds/${world.id}`}>{world.name}</Link>
      </h2>
      <ul className={ui.list}>
        {characters.data.map((c) => (
          <CharacterRow key={c.slug} worldId={world.id} character={c} />
        ))}
      </ul>
    </>
  );
}
