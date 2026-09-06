const path = require('node:path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const pkg = require('../../package.json');

const root = path.resolve(__dirname, '../..');
const modules = Object.keys({...pkg.peerDependencies});

// Absolute paths to the example's single copy of each peer dependency.
const peerModulePaths = modules.reduce((acc, name) => {
  acc[name] = path.resolve(__dirname, 'node_modules', name);
  return acc;
}, {});

/**
 * Metro configuration for the example app inside the library monorepo.
 *
 * - watch the repo root so edits to the library's `src/` hot-reload here
 * - force the library's peer deps (react / react-native) to resolve to the
 *   example's single copy, for the same reason documented in the sibling
 *   react-native-web-serial-api repo's example/metro.config.js: the library
 *   source lives at the repo root (above this folder) and there is ALSO a
 *   react-native installed at the repo root (the library's own
 *   devDependency) — without forcing a single copy, two separate native
 *   module registries end up in play.
 *
 * https://reactnative.dev/docs/metro
 */
const config = {
  watchFolders: [root],
  resolver: {
    // RN's default blockList excludes everything under `__tests__/` from the
    // bundle. The on-device Self-Test screen, however, runs the library's
    // shared conformance suite, which lives at
    // `src/__tests__/conformance-suite.ts` (kept there so the package build
    // excludes it from the published npm package). Allow just that one file
    // through while still blocking real test files.
    blockList: /\/__tests__\/(?!conformance-suite\.ts$).*$/,
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(root, 'node_modules'),
    ],
    extraNodeModules: peerModulePaths,
    resolveRequest: (context, moduleName, platform) => {
      // Pin every peer dependency (and its subpaths) to the example's copy,
      // regardless of which file imports it.
      for (const name of modules) {
        if (moduleName === name || moduleName.startsWith(`${name}/`)) {
          const rest = moduleName.slice(name.length); // '' or '/subpath'
          return context.resolveRequest(
            context,
            peerModulePaths[name] + rest,
            platform,
          );
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
