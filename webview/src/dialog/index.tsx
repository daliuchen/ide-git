import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import '../commit/commit.css';
import { DialogApp } from './DialogApp';
import './dialog.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Dialog root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <DialogApp />
  </StrictMode>,
);
