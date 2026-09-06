const path = require('node:path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const pkg = require('../../package.json');

const root = path.resolve(__dirname, '..', '..');
const modules = Object.keys({...pkg.peerDependencies});

// Absolute paths to this example's single copy of each peer dependency.
const peerModulePaths = modules.reduce((acc, name) => {
  acc[name] = path.resolve(__dirname, 'node_modules', name);
  return acc;
}, {});

/**
 * Metro configuration for the nfc-rewriter example, one directory deeper
 * than `../self-test` inside the library monorepo — see that sibling's
 * metro.config.js for the full rationale (identical here, just with an
 * extra `..` in every path up to the repo root).
 *
 * https://reactnative.dev/docs/metro
 */
const config = {
  watchFolders: [root],
  resolver: {
    blockList: /\/__tests__\/(?!conformance-suite\.ts$).*$/,
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(root, 'node_modules'),
    ],
    extraNodeModules: peerModulePaths,
    resolveRequest: (context, moduleName, platform) => {
      for (const name of modules) {
        if (moduleName === name || moduleName.startsWith(`${name}/`)) {
          const rest = moduleName.slice(name.length);
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
