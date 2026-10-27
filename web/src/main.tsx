import { render } from 'preact';
import { App } from './App.tsx';
import { installTooltip } from './tooltip.ts';
import './styles.css';

installTooltip();
render(<App />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
