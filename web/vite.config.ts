import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 會把站台放在 /<repo>/ 底下，base 需要跟著。
// 本機開發時 base 為 '/'，由 VITE_BASE 覆寫。
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
