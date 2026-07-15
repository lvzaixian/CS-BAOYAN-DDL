import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const isE2E = mode === 'e2e';

  return {
    plugins: [tailwindcss(), svelte()],
    resolve: {
      alias: {
        $lib: path.resolve('src/lib'),
        $data: path.resolve('src/data'),
        $approved: path.resolve(isE2E ? 'e2e/fixtures' : 'data/approved'),
        $components: path.resolve('src/components'),
      },
    },
    build: {
      outDir: isE2E ? 'dist-e2e' : 'dist',
      target: 'es2022',
      cssMinify: 'lightningcss',
      sourcemap: false,
    },
    server: {
      port: 5180,
      strictPort: false,
    },
  };
});
