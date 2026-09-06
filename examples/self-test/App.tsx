import React from 'react';
import {
  Button,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {NDEFReadingEvent} from 'react-native-web-nfc-api';
import {NDEFReader, setNfcTransport} from 'react-native-web-nfc-api';
import {
  InMemoryNfcTransport,
  MultiRecordTag,
  ReadOnlyTag,
  SlowTag,
  TextTag,
  UrlTag,
} from 'react-native-web-nfc-api/testing';
import {runNfcConformance} from '../../src/__tests__/conformance-suite';
import {colors} from './src/theme';

type Screen = 'live' | 'demo' | 'selftest' | 'lifecycle';

// A hand-rolled NDEF Forum "well-known text" record payload is
// `[statusByte, ...langCodeBytes, ...textBytes]`, where statusByte's low 6
// bits are the language code's *byte length* (not the language code itself)
// — `btoa('en' + text)` is NOT this format, since the resulting first byte
// is the ASCII code for 'e' (0x65), not the numeric length 2. This tiny
// local helper builds a correct wire text-record payload for the example
// app's hand-authored demo/lifecycle tags (the library itself builds this
// correctly internally via well-known-records.ts, which isn't part of the
// public API surface this app is restricted to).
function textRecordPayload(text: string, lang = 'en'): string {
  const bytes = [lang.length, ...Array.from(lang).map(c => c.charCodeAt(0)), ...Array.from(text).map(c => c.charCodeAt(0))];
  return btoa(String.fromCharCode(...bytes));
}

// ── Screen 2: Virtual Tag demo mode (§10.2) ──────────────────────────────────
//
// The reference implementation of "how do you simulate an NFC device on a
// real device" — runnable on Android, iOS, and web alike, with no physical
// NFC tag required at any point. A fresh InMemoryNfcTransport + canned tags
// is built once and installed globally via setNfcTransport() (through
// NDEFReader's own getNfcTransport() seam), so every `new NDEFReader({mode:
// 'managed'})` in the app — including the Self-Test and Lifecycle screens
// below — shares the same simulated tag field.
function createDemoTransport(): InMemoryNfcTransport {
  const transport = new InMemoryNfcTransport({requireExplicitTap: true});
  transport.addTag(new TextTag({text: 'hello from a virtual tag'}));
  transport.addTag(new UrlTag({url: 'https://example.com'}));
  transport.addTag(new ReadOnlyTag());
  transport.addTag(new SlowTag({delayMs: 3000}));
  transport.addTag(
    new MultiRecordTag({
      records: [
        {tnf: 1, type: btoa('T'), id: '', payload: textRecordPayload('multi-record tag')},
        {
          tnf: 1,
          type: btoa('U'),
          id: '',
          // URI record payload = [prefixCode, ...uriBytes]; prefix code 0
          // means "no abbreviation, this is the literal, complete URI".
          payload: btoa('\x00https://example.com/multi'),
        },
      ],
    }),
  );
  return transport;
}

function LiveModeScreen(): React.JSX.Element {
  const [reader] = React.useState(() => new NDEFReader());
  const [log, setLog] = React.useState<string[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const supported = NDEFReader.isSupported();

  const append = (line: string) =>
    setLog(prev => [line, ...prev].slice(0, 20));

  React.useEffect(() => {
    reader.onreading = (readingEv: NDEFReadingEvent) => {
      append(
        `reading: serial=${readingEv.serialNumber} records=${readingEv.message.records.length}`,
      );
    };
    reader.onreadingerror = () => append('readingerror');
    return () => {
      reader.onreading = null;
      reader.onreadingerror = null;
    };
  }, [reader]);

  const startScan = async () => {
    try {
      setScanning(true);
      await reader.scan();
      append('scan() resolved — session active');
    } catch (err) {
      append(`scan() failed: ${(err as Error).message}`);
      setScanning(false);
    }
  };

  const writeText = async () => {
    try {
      await reader.write('hello from Live mode');
      append('write() succeeded');
    } catch (err) {
      append(`write() failed: ${(err as Error).message}`);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen} testID="live-screen">
      <Text style={styles.title}>Live mode</Text>
      <Text style={styles.subtitle}>
        Real scan/write via default new NDEFReader() — passthrough on web,
        native NFC on Android/iOS.
      </Text>
      <Text testID="live-supported">
        NDEFReader.isSupported(): {String(supported)}
      </Text>
      <Button
        title={scanning ? 'Scanning…' : 'Start scan()'}
        onPress={startScan}
        testID="live-scan-button"
      />
      <View style={styles.spacer} />
      <Button title="write('hello…')" onPress={writeText} testID="live-write-button" />
      <View style={styles.spacer} />
      {log.map((line, i) => (
        <Text key={`${i}-${line}`} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

function DemoModeScreen({
  transport,
}: {
  transport: InMemoryNfcTransport;
}): React.JSX.Element {
  const [reader] = React.useState(
    () => new NDEFReader({mode: 'managed'}),
  );
  const [log, setLog] = React.useState<string[]>([]);
  const append = (line: string) =>
    setLog(prev => [line, ...prev].slice(0, 20));

  React.useEffect(() => {
    reader.onreading = (readingEv: NDEFReadingEvent) => {
      const record = readingEv.message.records[0];
      append(
        `reading: serial=${readingEv.serialNumber} recordType=${record?.recordType ?? '(none)'}`,
      );
    };
    reader.onreadingerror = () => append('readingerror (non-NDEF tag)');
    void reader.scan().catch(err => append(`scan() failed: ${err.message}`));
    return () => {
      reader.onreading = null;
      reader.onreadingerror = null;
    };
  }, [reader]);

  return (
    <ScrollView contentContainerStyle={styles.screen} testID="demo-screen">
      <Text style={styles.title}>Virtual Tag demo</Text>
      <Text style={styles.subtitle}>
        new NDEFReader({'{mode: "managed"}'}) against an InMemoryNfcTransport
        — works identically on Android, iOS, and web, no physical tag needed.
      </Text>
      <Button
        title="Tap first tag"
        onPress={() => transport.addTag(new TextTag({text: 'tapped'})).tap()}
        testID="demo-tap-button"
      />
      <View style={styles.spacer} />
      {log.map((line, i) => (
        <Text key={`${i}-${line}`} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

// ── Screen 3: Self-Test (§10.3, §6c) ────────────────────────────────────────
//
// Runs the shared, transport-independent conformance suite
// (src/__tests__/conformance-suite.ts's exported runNfcConformance()) and
// surfaces pass/fail per behavioral-matrix row. This is the same suite the
// repo's own Jest run exercises (conformance-suite.test.ts) — the example
// app just gives it an on-device UI, per §6c's "real-device compatibility
// tests" layer.
function SelfTestScreen(): React.JSX.Element {
  const [running, setRunning] = React.useState(false);
  const [results, setResults] = React.useState<
    Array<{name: string; passed: boolean; error?: string}>
  >([]);

  const run = async () => {
    setRunning(true);
    try {
      const outcome = await runNfcConformance();
      setResults(outcome);
    } finally {
      setRunning(false);
    }
  };

  const passedCount = results.filter(r => r.passed).length;

  return (
    <ScrollView contentContainerStyle={styles.screen} testID="selftest-screen">
      <Text style={styles.title}>Self-Test</Text>
      <Text style={styles.subtitle}>
        Runs the library's transport-independent conformance suite against an
        in-memory transport, right here on this device.
      </Text>
      <Button
        title={running ? 'Running…' : 'Run conformance suite'}
        onPress={run}
        disabled={running}
        testID="selftest-run-button"
      />
      <View style={styles.spacer} />
      {results.length > 0 && (
        <Text style={styles.subtitle}>
          {passedCount}/{results.length} passed
        </Text>
      )}
      {results.map(r => (
        <Text
          key={r.name}
          style={[styles.logLine, r.passed ? styles.pass : styles.fail]}>
          {r.passed ? '✓' : '✗'} {r.name}
          {r.error ? ` — ${r.error}` : ''}
        </Text>
      ))}
    </ScrollView>
  );
}

// ── Screen 4: Launch/lifecycle banner (§10.4, §12e) ─────────────────────────
//
// Shows "app was launched by a tag" when a queued launch activation is
// drained, plus manual simulateBackground()/simulateForeground() buttons on
// the InMemoryNfcTransport so scan-suspension behavior (§12d) is directly
// observable without physically backgrounding the app or holding a real tag.
function LifecycleScreen({
  transport,
}: {
  transport: InMemoryNfcTransport;
}): React.JSX.Element {
  const [reader] = React.useState(
    () => new NDEFReader({mode: 'managed'}),
  );
  const [launchBanner, setLaunchBanner] = React.useState<string | null>(null);
  const [foreground, setForeground] = React.useState(true);
  const [log, setLog] = React.useState<string[]>([]);
  const append = (line: string) =>
    setLog(prev => [line, ...prev].slice(0, 20));

  React.useEffect(() => {
    reader.onreading = (readingEv: NDEFReadingEvent) => {
      setLaunchBanner(
        `App was launched/resumed by a tag (serial=${readingEv.serialNumber})`,
      );
      append(`reading (possibly launch-delivered): ${readingEv.serialNumber}`);
    };
    void reader.scan().catch(err => append(`scan() failed: ${err.message}`));
    return () => {
      reader.onreading = null;
    };
  }, [reader]);

  const simulateLaunch = () => {
    transport.simulateLaunchTag([
      {tnf: 1, type: btoa('T'), id: '', payload: textRecordPayload('launch tag payload')},
    ]);
  };

  const simulateBackground = () => {
    transport.simulateBackground();
    setForeground(false);
    append('simulateBackground() — scan suspended internally');
  };

  const simulateForeground = () => {
    transport.simulateForeground();
    setForeground(true);
    append('simulateForeground() — scan resumes with a fresh operationId');
  };

  return (
    <ScrollView contentContainerStyle={styles.screen} testID="lifecycle-screen">
      <Text style={styles.title}>Launch / lifecycle</Text>
      {launchBanner && (
        <Text style={styles.banner} testID="launch-banner">
          {launchBanner}
        </Text>
      )}
      <Text testID="foreground-state">
        App state: {foreground ? 'foreground' : 'background'}
      </Text>
      <Button
        title="Simulate cold-launch tag tap"
        onPress={simulateLaunch}
        testID="simulate-launch-button"
      />
      <View style={styles.spacer} />
      <Button
        title="Simulate background"
        onPress={simulateBackground}
        testID="simulate-background-button"
      />
      <View style={styles.spacer} />
      <Button
        title="Simulate foreground"
        onPress={simulateForeground}
        testID="simulate-foreground-button"
      />
      <View style={styles.spacer} />
      {log.map((line, i) => (
        <Text key={`${i}-${line}`} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

/**
 * The example app for react-native-web-nfc-api: four screens, one per
 * platform-independent way of exercising the library (§10).
 */
function App(): React.JSX.Element {
  const [screen, setScreen] = React.useState<Screen>('demo');

  // One shared InMemoryNfcTransport backs the demo/self-test/lifecycle
  // screens for the lifetime of the app — installed globally via
  // setNfcTransport() (through installGlobally-equivalent wiring) so every
  // managed-mode NDEFReader constructed anywhere in the app shares the same
  // simulated tag field, matching how a real device has exactly one radio.
  const transport = React.useMemo(() => {
    const t = createDemoTransport();
    // Installing globally makes every `new NDEFReader({mode: 'managed'})`
    // constructed anywhere in the app (including future screens) pick up
    // this same transport, mirroring installInMemoryNfcTransport()'s
    // flag-gated Maestro/e2e install (§6f) but done directly here for the
    // interactive demo.
    setNfcTransport(t);
    return t;
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.primaryDark} />
      <View style={styles.tabBar}>
        {(['live', 'demo', 'selftest', 'lifecycle'] as Screen[]).map(s => (
          <Button
            key={s}
            title={s}
            onPress={() => setScreen(s)}
            testID={`tab-${s}`}
          />
        ))}
      </View>
      {screen === 'live' && <LiveModeScreen />}
      {screen === 'demo' && <DemoModeScreen transport={transport} />}
      {screen === 'selftest' && <SelfTestScreen />}
      {screen === 'lifecycle' && <LifecycleScreen transport={transport} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  tabBar: {flexDirection: 'row', justifyContent: 'space-around', padding: 8},
  screen: {padding: 16, gap: 8},
  title: {fontSize: 20, fontWeight: 'bold', color: colors.text},
  subtitle: {fontSize: 14, color: colors.textMuted, marginBottom: 8},
  spacer: {height: 8},
  logLine: {fontSize: 12, color: colors.textMuted, fontFamily: 'monospace'},
  banner: {
    backgroundColor: colors.primary,
    color: '#fff',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  pass: {color: 'green'},
  fail: {color: 'crimson'},
});

export default App;
