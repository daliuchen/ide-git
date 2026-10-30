import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@vscode/codicons/dist/codicon.css';
import { CommitApp } from './CommitApp';
import './commit.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Commit root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <CommitApp />
  </StrictMode>,
);
