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

const root = document.getElementById('app');
if (root === null) throw new Error('#app is missing');

createRoot(root).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>,
);
