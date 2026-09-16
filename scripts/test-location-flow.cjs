// Real React commits/effects, with device APIs mocked. Run: npm run test:location
// These regressions cover orchestration, not UIKit or physical GPS delivery.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const React = require('react');
const { act, create } = require('react-test-renderer');
const ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(__dirname, '..');

function load(file, mocks) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports, process: { env: {} }, console,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    require(name) {
      if (name === 'react' || name === 'react/jsx-runtime') return require(name);
      if (!(name in mocks)) throw Error(`Missing mock: ${name}`);
      return mocks[name];
    },
  }, { filename: file });
  return exports;
}

async function harness(t, { foreground = 'granted', background = 'denied', result = 'granted', settingsResult = result, gps = true } = {}) {
  const handlers = {}, calls = [];
  let renderer, back;
  const overlays = () => renderer.root.findAllByProps({ accessibilityViewIsModal: true });
  const rn = {
    Platform: { OS: 'ios', Version: '26.3' },
    StyleSheet: { create: value => value, absoluteFillObject: { position: 'absolute' } },
    AppState: { addEventListener: () => ({ remove() {} }) }, Linking: {},
    BackHandler: { addEventListener: (_, fn) => { back = fn; return { remove: () => { back = null; } }; } },
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', RefreshControl: 'RefreshControl',
    // A native Modal must never be used by this disclosure, even when hidden.
    Modal: () => { throw Error('Native Modal can retain an invisible UIKit layer'); },
  };
  const Disclosure = load('components/BackgroundLocationDisclosure.tsx', { 'react-native': rn }).default;
  const mocks = {
    'react-native': rn,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'react-native-webview': { WebView: 'WebView' },
    '@react-native-async-storage/async-storage': {
      getItem: async () => '1', setItem: async () => {}, removeItem: async () => {},
    },
    'expo-constants': { expoConfig: { extra: { webUrl: 'https://example.test' } } },
    'expo-location': {},
    'expo-notifications': { setNotificationHandler() {},
      addNotificationResponseReceivedListener: () => ({ remove() {} }),
      getLastNotificationResponseAsync: async () => null },
    'expo-splash-screen': { preventAutoHideAsync: async () => {}, hideAsync: async () => {} },
    '../lib/native-bridge': { createNativeBridge: () => ({
      registerHandler: (name, fn) => { handlers[name] = fn; }, emit() {},
    }), isBridgeEnvelope: () => false },
    '../lib/permissions': {
      requestPermission: async () => foreground,
      getBackgroundLocationState: async () => background,
      getPermissionsStatus: async () => ({}),
      requestBackgroundLocation: async () => {
        assert.equal(overlays().length, 0, 'System permission opens only after disclosure removal');
        calls.push('background'); background = result; return result;
      },
      openSystemSettings: async () => {},
      openSystemSettingsAndWaitForReturn: async () => {
        assert.equal(overlays().length, 0, 'Settings opens only after disclosure removal');
        calls.push('settings');
        background = settingsResult;
      },
    },
    '../lib/push': {},
    '../lib/tracking': {
      setDriverSession: async () => {}, areGpsServicesEnabled: async () => gps,
      ensureGpsServicesEnabled: async () => gps, isTrackingRunning: async () => false,
      getLastPushState: () => ({}), resumeTrackingIfEnabled: async () => {},
      stopTracking: async () => { calls.push('stop'); },
      startTracking: async () => { calls.push('start'); return true; },
      // A stalled first POST must not hold the bridge response.
      pushCurrentPositionNow: () => { calls.push('push'); return new Promise(() => {}); },
    },
    '../components/BackgroundLocationDisclosure': Disclosure,
  };
  for (const name of ['SplashOverlay', 'NetworkBanner', 'OnboardingScreen']) mocks[`../components/${name}`] = () => null;
  const Home = load('app/index.tsx', mocks).default;
  await act(async () => { renderer = create(React.createElement(Home)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return {
    handlers, calls, overlays,
    async press(index, twice = false) {
      await act(async () => {
        const press = renderer.root.findAllByType('Pressable')[index].props.onPress;
        press(); if (twice) press();
      });
    },
    async back() { await act(async () => { assert.equal(back(), true); }); },
    webAccessible() {
      return renderer.root.findByType('WebView').parent.props.accessibilityElementsHidden === false;
    },
    text: () => JSON.stringify(renderer.toJSON()),
  };
}

test('login saves immediately without starting a permission dialog', async t => {
  const app = await harness(t);
  const result = await app.handlers['auth.session']({ kind: 'driver', driverId: 'test' });
  assert.equal(result.saved, true);
  assert.deepEqual(app.calls, []); assert.equal(app.overlays().length, 0);
});

test('concurrent tracking retries share consent, permission and startup; slow POST does not block', async t => {
  const app = await harness(t); let first, retry;
  await act(async () => {
    first = app.handlers['tracking.start']({ driverId: 'test' });
    retry = app.handlers['tracking.start']({ driverId: 'test' });
  });
  assert.equal(first, retry); assert.equal(app.overlays().length, 1);
  assert.deepEqual(app.calls, []);
  await app.press(0, true);
  const response = await first;
  assert.equal(response.ok, true); assert.equal(response.backgroundOk, true);
  assert.deepEqual(app.calls, ['background', 'start', 'push']);
  assert.equal(app.overlays().length, 0); assert.equal(app.webAccessible(), true);
});

test('declining disclosure removes all touch blockers and never requests background permission', async t => {
  const app = await harness(t); let pending;
  await act(async () => { pending = app.handlers['tracking.start']({ driverId: 'test' }); });
  await app.press(1);
  assert.equal((await pending).backgroundOk, false);
  assert.deepEqual(app.calls, ['start', 'push']);
  assert.equal(app.overlays().length, 0); assert.equal(app.webAccessible(), true);
});

test('iOS denial offers Siempre in Settings and opens it after the notice is removed', async t => {
  const app = await harness(t, { result: 'denied' }); let pending;
  await act(async () => { pending = app.handlers['tracking.start']({ driverId: 'test' }); });
  await app.press(0);
  assert.equal(app.overlays().length, 1); assert.match(app.text(), /Siempre/);
  await app.press(0);
  assert.equal((await pending).backgroundOk, false);
  assert.deepEqual(app.calls, ['background', 'settings', 'start', 'push']);
  assert.equal(app.overlays().length, 0);
});

test('Back cancels Settings without opening it and leaves the portal accessible', async t => {
  const app = await harness(t, { result: 'blocked' }); let pending;
  await act(async () => { pending = app.handlers['tracking.start']({ driverId: 'test' }); });
  await app.press(0); await app.back(); await pending;
  assert.deepEqual(app.calls, ['background', 'start', 'push']);
  assert.equal(app.overlays().length, 0); assert.equal(app.webAccessible(), true);
});

test('granting Siempre in Settings is read again on return before tracker starts', async t => {
  const app = await harness(t, { result: 'denied', settingsResult: 'granted' }); let pending;
  await act(async () => { pending = app.handlers['tracking.start']({ driverId: 'test' }); });
  await app.press(0); await app.press(0);
  assert.equal((await pending).backgroundOk, true);
  assert.deepEqual(app.calls, ['background', 'settings', 'start', 'push']);
  assert.equal(app.overlays().length, 0);
});

for (const options of [{ foreground: 'denied' }, { gps: false }]) {
  test(`portal stays usable without location: ${JSON.stringify(options)}`, async t => {
    const app = await harness(t, options); let response;
    await act(async () => { response = await app.handlers['tracking.start']({ driverId: 'test' }); });
    assert.equal(response.ok, false); assert.deepEqual(app.calls, []);
    assert.equal(app.overlays().length, 0); assert.equal(app.webAccessible(), true);
  });
}

test('foreground permission retries share one system dialog and recover from errors', async () => {
  let attempts = 0, finish;
  const permissions = load('lib/permissions.ts', {
    'expo-notifications': {}, 'expo-image-picker': {}, 'react-native': {},
    'expo-location': {
      getForegroundPermissionsAsync: async () => ({ status: 'undetermined' }),
      requestForegroundPermissionsAsync: () => {
        attempts++; return new Promise((resolve, reject) => { finish = { resolve, reject }; });
      },
    },
  });
  const first = permissions.requestPermission('location');
  const retry = permissions.requestPermission('location');
  assert.equal(first, retry);
  await nextTurn();
  finish.reject(Error('interrupted'));
  await assert.rejects(first, /interrupted/);
  const next = permissions.requestPermission('location');
  await nextTurn();
  finish.resolve({ status: 'granted' });
  assert.equal(await next, 'granted'); assert.equal(attempts, 2);
});

test('opening Settings waits for the real return, not an inactive permission alert', async () => {
  let onChange, removed = 0, returned = false;
  const permissions = load('lib/permissions.ts', {
    'expo-notifications': {}, 'expo-image-picker': {}, 'expo-location': {},
    'react-native': {
      Platform: { OS: 'ios' }, Linking: { openURL: async () => {} },
      AppState: { addEventListener: (_, fn) => {
        onChange = fn; return { remove() { removed++; } };
      } },
    },
  });
  const visit = permissions.openSystemSettingsAndWaitForReturn().then(() => { returned = true; });
  await nextTurn(); assert.equal(returned, false);
  onChange('inactive'); onChange('active');
  await nextTurn(); assert.equal(returned, false);
  onChange('background');
  await nextTurn(); assert.equal(returned, false);
  onChange('active'); await visit;
  assert.equal(returned, true); assert.equal(removed, 1);
});

test('failure to open Settings rejects and removes its AppState listener', async () => {
  let removed = 0;
  const permissions = load('lib/permissions.ts', {
    'expo-notifications': {}, 'expo-image-picker': {}, 'expo-location': {},
    'react-native': {
      Platform: { OS: 'ios' }, Linking: { openURL: async () => { throw Error('unavailable'); } },
      AppState: { addEventListener: () => ({ remove() { removed++; } }) },
    },
  });
  await assert.rejects(permissions.openSystemSettingsAndWaitForReturn(), /unavailable/);
  assert.equal(removed, 1);
});
