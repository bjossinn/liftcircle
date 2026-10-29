import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppProvider } from '@/state/app';
import { ToastProvider } from '@/components/toast';
import { AppRouter } from '@/app/routes';
import { initPwa } from '@/pwa/update';
import { initInstallCapture } from '@/pwa/install';

initInstallCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <AppProvider>
        <AppRouter />
      </AppProvider>
    </ToastProvider>
  </StrictMode>,
);
void initPwa();
