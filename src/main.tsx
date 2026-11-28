import { StrictMode } from 'react';
import { LucideProvider } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { AppProvider } from '@/state/app';
import { ToastProvider } from '@/components/toast';
import { AppRouter } from '@/app/routes';
import { initPwa } from '@/pwa/update';
import { initInstallCapture } from '@/pwa/install';
import { ICON_STROKE } from '@/components/Icon';

initInstallCapture();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Direction B: every Lucide mark is a 1.75 outline (src/components/Icon.tsx). */}
    <LucideProvider strokeWidth={ICON_STROKE}>
      <ToastProvider>
        <AppProvider>
          <AppRouter />
        </AppProvider>
      </ToastProvider>
    </LucideProvider>
  </StrictMode>,
);
void initPwa();
