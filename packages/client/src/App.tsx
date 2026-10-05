import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router';
import { getToken } from './api.ts';
import { useServerEvents } from './events.ts';
import { AuthView } from './views/AuthView.tsx';
import { CharactersView } from './views/CharactersView.tsx';
import { ChatView } from './views/ChatView.tsx';
import { HomeView } from './views/HomeView.tsx';
import { Layout } from './views/Layout.tsx';
import { ProfilesView } from './views/ProfilesView.tsx';
import { SettingsView } from './views/SettingsView.tsx';

function useToken() {
  const [token, setTokenState] = useState(getToken);
  useEffect(() => {
    const update = () => setTokenState(getToken());
    window.addEventListener('teahouse:auth', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('teahouse:auth', update);
      window.removeEventListener('storage', update);
    };
  }, []);
  return token;
}

export function App() {
  const token = useToken();
  const queryClient = useQueryClient();
  const connection = useServerEvents(queryClient, Boolean(token));

  if (!token) return <AuthView />;

  return (
    <Routes>
      <Route element={<Layout connection={connection} />}>
        <Route index element={<HomeView />} />
        <Route path="chats/:chatId" element={<ChatView />} />
        <Route path="characters" element={<CharactersView />} />
        <Route path="profiles" element={<ProfilesView />} />
        <Route path="settings" element={<SettingsView />} />
      </Route>
    </Routes>
  );
}
