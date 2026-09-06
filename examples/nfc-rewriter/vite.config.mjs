import {createRequire} from 'node:module';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const require = createRequire(import.meta.url);
const rootPkg = require('../../package.json');

// Absolute path to react-native-web so the alias resolves correctly even from
// the library source outside this folder (avoids duplicate-module resolution).
const reactNativeWeb = path.dirname(
  require.resolve('react-native-web/package.json'),
);

// Resolve platform-specific files (.web.ts wins on web) the way Metro does.
const extensions = [
  '.web.tsx',
  '.web.ts',
  '.web.jsx',
  '.web.js',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '.json',
];

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  define: {
    global: 'globalThis',
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV || 'development',
    ),
  },
  resolve: {
    extensions,
    alias: [
      {
        find: new RegExp(`^${rootPkg.name}/testing$`),
        replacement: path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'src/testing/index.ts',
        ),
      },
      {
        find: new RegExp(`^${rootPkg.name}/websocket$`),
        replacement: path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'src/websocket/index.ts',
        ),
      },
      {
        find: new RegExp(`^${rootPkg.name}$`),
        replacement: path.resolve(import.meta.dirname, '..', '..', rootPkg.source),
      },
      {find: /^react-native$/, replacement: reactNativeWeb},
    ],
  },
  optimizeDeps: {
    include: ['react-native-web', 'web-streams-polyfill'],
  },
});
