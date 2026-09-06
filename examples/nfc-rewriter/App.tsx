/**
 * Root component for this port of react-native-nfc-rewriter.
 *
 * Navigation: the original app uses @react-navigation (stack + bottom
 * tabs) — this port has no navigation-library dependency (matching this
 * repo's other example app, ../self-test/App.tsx), and instead switches
 * between screens with a small local state machine. This is a reasonable
 * substitution for a single-purpose example app; a real production app
 * built on this pattern would likely want @react-navigation back.
 *
 * Screens ported (NDEF-scoped only, per IMPLEMENTATION_PLAN.md §0 — see
 * README.md "Ported from react-native-nfc-rewriter" for the full list of
 * what was dropped and why): Landing -> Home -> {NdefTypeList -> NdefWrite,
 * SavedRecord -> (NdefWrite for editing) / TagDetail, Settings}. Dropped
 * entirely: CustomTransceive, TagKit, Toolkit (the original's launcher for
 * those two) — all raw tag-technology features with no equivalent in this
 * library's NDEF-only public API.
 *
 * Virtual Tag demo: not part of the original app. Toggling it switches
 * NfcProxy's underlying NDEFReader to `mode: 'managed'` against an
 * InMemoryNfcTransport (§4, §6b) with a few canned tags, so this whole app
 * — including "Write NDEF" and "My Records" — is exercisable without
 * physical NFC hardware, matching the pattern this repo's other example
 * app (../self-test/App.tsx) already established.
 */
import React from 'react';
import {SafeAreaView, StatusBar, StyleSheet, Switch, Text, View} from 'react-native';
import {setNfcTransport} from 'react-native-web-nfc-api';
import {InMemoryNfcTransport, TextTag, UrlTag} from 'react-native-web-nfc-api/testing';
import {AppProvider, useAppContext} from './src/AppContext';
import NfcProxy, {type SimpleTag} from './src/NfcProxy';
import LandingScreen from './src/Screens/Landing';
import HomeScreen from './src/Screens/Home';
import NdefTypeListScreen from './src/Screens/NdefTypeList';
import NdefWriteScreen from './src/Screens/NdefWrite';
import type {NdefWriteParams} from './src/Screens/NdefTypeList';
import SavedRecordScreen from './src/Screens/SavedRecord';
import TagDetailScreen from './src/Screens/TagDetail';
import SettingsScreen from './src/Screens/Settings';
import NfcPromptAndroid from './src/Components/NfcPromptAndroid';
import Toast from './src/Components/Toast';
import {colors} from './src/theme';
import type {SavedRecord} from './src/Utils/Storage';

type Route =
  | {name: 'home'}
  | {name: 'ndefTypeList'}
  | {name: 'ndefWrite'; params: NdefWriteParams; savedRecord?: SavedRecord}
  | {name: 'savedRecord'}
  | {name: 'tagDetail'; tag: SimpleTag}
  | {name: 'settings'};

/**
 * Unlike ../self-test/App.tsx's Demo screen (which exists specifically to
 * demonstrate the tap-simulation mechanism itself, and so deliberately uses
 * `requireExplicitTap: true` with a visible "Tap first tag" button), this
 * port's demo mode exists to make the REST of the ported app (scan, write,
 * save/reopen records) usable without a physical tag or a separate "tap"
 * step interrupting each flow that expects a tag to already be present —
 * `requireExplicitTap: false` means a tag already in the field (added via
 * addTag()) is auto-discovered the instant a scan() starts, matching "there
 * is always a virtual tag sitting on the reader" rather than requiring a
 * manual tap before every read/write in this demo.
 */
function createDemoTransport(): InMemoryNfcTransport {
  const transport = new InMemoryNfcTransport({requireExplicitTap: false});
  transport.addTag(new TextTag({text: 'hello from a virtual tag'}));
  return transport;
}

function MainApp(): React.JSX.Element {
  const {initStorage} = useAppContext();
  const [route, setRoute] = React.useState<Route>({name: 'home'});
  const [demoMode, setDemoMode] = React.useState(false);
  // Whether a real scan()/write() would work right now: unknown until
  // Landing's mount-time init() check resolves, or unconditionally true
  // once demo mode is on (§4 — the managed polyfill is always "supported").
  const [realNfcSupported, setRealNfcSupported] = React.useState<
    boolean | null
  >(null);
  const initializedStorage = React.useRef(false);

  const demoTransport = React.useMemo(() => createDemoTransport(), []);

  // Whether to show the app (Home/...) or stay on Landing is DERIVED from
  // current support state, not a one-way "ready" flag — so turning demo
  // mode off after having turned it on returns to Landing's "not
  // supported" message if the underlying device/browser genuinely has no
  // real NFC (matching what would happen if the user had never enabled
  // demo mode in the first place), rather than leaving the user stranded
  // in Home with a reader that silently can't do anything.
  const ready = demoMode || realNfcSupported === true;

  React.useEffect(() => {
    if (ready && !initializedStorage.current) {
      initializedStorage.current = true;
      initStorage();
    }
  }, [ready, initStorage]);

  // Applied synchronously (not via a useEffect reacting to `demoMode`
  // state) so that by the time a re-render mounts a screen, NfcProxy is
  // already switched over — a useEffect here would run AFTER that
  // re-render commits, racing against the newly-mounted screen's own
  // mount-time isSupported()/isEnabled() checks (e.g. Home.tsx), which
  // could read the stale mode before the switch took effect.
  function setDemoModeEnabled(enabled: boolean): void {
    NfcProxy.setMode(enabled ? 'managed' : 'passthrough');
    setNfcTransport(enabled ? demoTransport : null);
    setDemoMode(enabled);
  }

  const demoBar = (
    <View style={styles.demoBar} testID="demo-mode-bar">
      <Text style={styles.demoBarText}>Virtual Tag demo</Text>
      <Switch
        value={demoMode}
        onValueChange={setDemoModeEnabled}
        testID="demo-mode-switch"
      />
    </View>
  );

  if (!ready) {
    return (
      <View style={styles.root}>
        {demoBar}
        <LandingScreen onSupportChecked={setRealNfcSupported} />
      </View>
    );
  }

  let screen: React.JSX.Element;
  switch (route.name) {
    case 'ndefTypeList':
      screen = (
        <NdefTypeListScreen
          onBack={() => setRoute({name: 'home'})}
          onSelect={params => setRoute({name: 'ndefWrite', params})}
        />
      );
      break;
    case 'ndefWrite':
      screen = (
        <NdefWriteScreen
          params={route.params}
          savedRecord={route.savedRecord}
          onBack={() => setRoute({name: 'home'})}
        />
      );
      break;
    case 'savedRecord':
      screen = (
        <SavedRecordScreen
          onBack={() => setRoute({name: 'home'})}
          onOpenRecord={(record: SavedRecord) =>
            setRoute({
              name: 'ndefWrite',
              params: {ndefType: record.payload.ndefType},
              savedRecord: record,
            })
          }
        />
      );
      break;
    case 'tagDetail':
      screen = (
        <TagDetailScreen tag={route.tag} onBack={() => setRoute({name: 'home'})} />
      );
      break;
    case 'settings':
      screen = <SettingsScreen onBack={() => setRoute({name: 'home'})} />;
      break;
    default:
      screen = (
        <HomeScreen
          onScannedTag={(tag: SimpleTag) => setRoute({name: 'tagDetail', tag})}
          onOpenNdefTypeList={() => setRoute({name: 'ndefTypeList'})}
          onOpenSavedRecords={() => setRoute({name: 'savedRecord'})}
          onOpenSettings={() => setRoute({name: 'settings'})}
        />
      );
  }

  return (
    <View style={styles.root}>
      {demoBar}
      {screen}
      <NfcPromptAndroid />
      <Toast />
    </View>
  );
}

export default function App(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.surface} />
      <AppProvider>
        <MainApp />
      </AppProvider>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: colors.surface},
  root: {flex: 1},
  demoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  demoBarText: {fontSize: 13, color: colors.textMuted},
});
