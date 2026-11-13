import './lib/zod.ts';
import './styles.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { queryClient } from './lib/api.ts';
import { initialTheme } from './lib/theme.ts';
import { ErrorBoundary } from './ui/ErrorView.tsx';

document.documentElement.dataset.theme = initialTheme();
// Without a saved pick the page follows a live system switch, as the old media query did.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  document.documentElement.dataset.theme = initialTheme();
});

// The offline cache (#121): never in dev or tests. No serviceWorker outside a secure context; a failed register leaves
// the site as it was.
if (import.meta.env.PROD) navigator.serviceWorker?.register('/sw.js').catch(() => {});

const root = document.getElementById('app');
if (root === null) throw new Error('#app is missing');

createRoot(root).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>,
);
