import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './style.css';

const el = document.getElementById('root');
if (el === null) throw new Error('找不到 #root');
createRoot(el).render(<StrictMode><App /></StrictMode>);
