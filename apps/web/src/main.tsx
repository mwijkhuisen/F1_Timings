import './lib/zod.ts';
import './styles.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { queryClient } from './lib/api.ts';
import { ErrorBoundary } from './ui/ErrorView.tsx';

const root = document.getElementById('app');
if (root === null) throw new Error('#app is missing');

createRoot(root).render(
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </ErrorBoundary>,
);
