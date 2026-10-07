import { registerSW } from 'virtual:pwa-register';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createStore, del, get, set } from 'idb-keyval';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App.tsx';
import { getServer, isApp } from './api.ts';
import { registerOfflineMutations } from './mutations.ts';
import './global.css';
import './i18n.ts';

/**
 * How long the local copy is kept without a sync. It doubles as the queries' gcTime, which
 * runs through setTimeout and so must stay below its 2^31 ms (24.8 days) limit: larger
 * values fire at once and drop everything restored.
 */
const LOCAL_COPY_AGE = 20 * 24 * 60 * 60 * 1000;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Queries must outlive their views to stay in the local copy.
      gcTime: LOCAL_COPY_AGE,
    },
  },
});
registerOfflineMutations(queryClient);

// Lets a browser open the app shell without the server (see vite.config.ts).
if (!isApp) registerSW({ immediate: true });

// The local copy: the query cache plus queued mutations, in IndexedDB.
const store = createStore('teahouse', 'cache');
const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key) => get<string>(key, store).then((v) => v ?? null),
    setItem: (key, value) => set(key, value, store),
    removeItem: (key) => del(key, store),
  },
  key: 'local-copy',
  throttleTime: 1000,
});

/** Results that are not worth keeping offline, or would be wrong when restored. */
const VOLATILE = new Set(['auth-status', 'pairing-addresses', 'proposal']);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: LOCAL_COPY_AGE,
        // A different server means a different local copy.
        buster: getServer() || window.location.origin,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' && !VOLATILE.has(String(query.queryKey[0])),
        },
      }}
      // Messages queued before a reload continue once they are back in the cache.
      onSuccess={() => void queryClient.resumePausedMutations()}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
