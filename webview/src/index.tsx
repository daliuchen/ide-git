import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { installTooltips } from './tooltip';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Git Log root element was not found.');
}

installTooltips();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
