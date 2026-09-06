/**
 * Jest config for the library's own unit + conformance tests (src/__tests__
 * and colocated *.test.ts files).
 *
 * Uses the React Native preset because the transport layer (NfcModule.ts /
 * NativeNfc.ts) imports `react-native`. The tests themselves never touch real
 * native modules — they inject an InMemoryNfcTransport / fake NfcTransport —
 * but the import graph still needs the RN mocks the preset provides.
 */
module.exports = {
  preset: '@react-native/jest-preset',
  roots: ['<rootDir>/src'],
  // Only *.test.ts/tsx are test files — so shared helpers like
  // src/__tests__/conformance-suite.ts are not mistaken for empty test suites.
  testMatch: ['<rootDir>/src/**/*.{test,spec}.{ts,tsx}'],
  // Pin react / react-native to this package's own copy so the preset's mocks
  // resolve consistently (the example app keeps its own copies).
  moduleNameMapper: {
    '^react-native$': '<rootDir>/node_modules/react-native',
    '^react$': '<rootDir>/node_modules/react',
  },
  // Coverage (run with `npm run test:coverage`). Collects from all of src so
  // unexercised files still show up. Note: the native bridge (NativeNfc.ts)
  // and NfcModule.kt/NfcModule.mm only run on a real device, so they read low
  // here — that's expected per §6d; lib/, SessionCoordinator.ts, and
  // testing/ are the numbers CI actually gates on (see coverageThreshold
  // below). testing/index.ts is a pure re-export barrel (no runtime logic
  // of its own), so it's excluded like src/index.ts and websocket/index.ts.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/__tests__/**',
    '!src/testing/index.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  // Per §6d: lib/, SessionCoordinator.ts, and testing/ (the in-memory NFC
  // simulator + test harness every conformance test is built on) are held
  // to a coverage bar. Everything else (WebNfcReader's PassthroughStrategy,
  // NativeNfc.ts, NfcModule.ts glue) is thin forwarding code validated by
  // the conformance suite and real-device testing, not a coverage
  // percentage.
  coverageThreshold: {
    './src/lib/**/*.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/SessionCoordinator.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/testing/**/*.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
