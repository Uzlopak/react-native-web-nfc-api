/**
 * Exercises the module-load-time branch in abort-signal.ts that selects
 * ShimAbortController when no global AbortController exists. Isolated into
 * its own file/module registry so deleting the global here doesn't affect
 * any other test file.
 */
describe('AbortControllerImpl module-load selection', () => {
  test('falls back to ShimAbortController when globalThis.AbortController is absent', () => {
    const original = globalThis.AbortController;
    // @ts-expect-error -- deliberately removing the global for this test
    delete globalThis.AbortController;
    jest.resetModules();
    try {
      const {AbortControllerImpl, ShimAbortController} = jest.requireActual(
        './abort-signal',
      ) as typeof import('./abort-signal');
      expect(AbortControllerImpl).toBe(ShimAbortController);
      const controller = new AbortControllerImpl();
      expect(controller.signal.aborted).toBe(false);
    } finally {
      globalThis.AbortController = original;
      jest.resetModules();
    }
  });
});
