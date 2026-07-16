import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('filter URL sync can be remounted without duplicate popstate listeners', async (t) => {
  const originalWindow = globalThis.window;
  const popstateListeners = new Set<EventListenerOrEventListenerObject>();
  const fakeWindow = {
    location: { pathname: '/', search: '' },
    history: {
      pushState() {},
      replaceState() {},
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'popstate') popstateListeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === 'popstate') popstateListeners.delete(listener);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });

  const server = await createServer({
    appType: 'custom',
    server: { middlewareMode: true },
  });
  t.after(async () => {
    await server.close();
    if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  const urlState = await server.ssrLoadModule(
    `/src/lib/urlState.svelte.ts?lifecycle=${Date.now()}`,
  );
  const disposeFirst = urlState.initFilterSync();
  assert.equal(typeof disposeFirst, 'function');
  assert.equal(popstateListeners.size, 1);

  const disposeSecond = urlState.initFilterSync();
  assert.equal(typeof disposeSecond, 'function');
  assert.equal(popstateListeners.size, 1, 'remount must replace, not duplicate, the listener');

  disposeFirst();
  assert.equal(popstateListeners.size, 1, 'a stale disposer must not remove the active listener');
  disposeSecond();
  assert.equal(popstateListeners.size, 0);

  const disposeThird = urlState.initFilterSync();
  assert.equal(popstateListeners.size, 1);
  disposeThird();
  assert.equal(popstateListeners.size, 0);
});
