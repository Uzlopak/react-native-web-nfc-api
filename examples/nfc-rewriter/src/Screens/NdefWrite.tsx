/**
 * Port of the vendored app's Screens/NdefWrite/index.js: picks the right
 * writer component for the requested ndefType (or a saved record's type)
 * and wires up ScreenHeader's save action.
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';
import RtdTextWriter, {type WriterHandle} from '../Components/RtdTextWriter';
import RtdUriWriter from '../Components/RtdUriWriter';
import RtdUriShortcutWriter from '../Components/RtdUriShortcutWriter';
import WifiSimpleWriter from '../Components/WifiSimpleWriter';
import VCardWriter from '../Components/VCardWriter';
import ScreenHeader from '../Components/ScreenHeader';
import {colors} from '../theme';
import type {NdefWriteParams} from './NdefTypeList';
import type {SavedRecord} from '../Utils/Storage';

interface Props {
  params: NdefWriteParams;
  savedRecord?: SavedRecord;
  savedRecordIdx?: number;
  onBack: () => void;
}

function NdefWriteScreen({params, savedRecord, savedRecordIdx, onBack}: Props): React.JSX.Element {
  const handlerRef = React.useRef<WriterHandle>(null);

  const ndefType = savedRecord?.payload.ndefType ?? params.ndefType;
  const savedValue = savedRecord?.payload.value;

  function getRecordPayload(): SavedRecord['payload'] | null {
    if (!handlerRef.current?.getValue) {
      return null;
    }
    return {ndefType, value: handlerRef.current.getValue()};
  }

  function renderWriter() {
    if (ndefType === 'TEXT') {
      return <RtdTextWriter ref={handlerRef} value={savedValue as string | undefined} />;
    }
    if (ndefType === 'URI') {
      const scheme = (savedValue as {scheme?: string} | undefined)?.scheme ?? params.scheme;
      if (scheme) {
        return (
          <RtdUriShortcutWriter
            ref={handlerRef}
            scheme={scheme}
            value={savedValue as {value: string} | undefined}
          />
        );
      }
      return <RtdUriWriter ref={handlerRef} value={savedValue as {value: string; prefix: string} | undefined} />;
    }
    if (ndefType === 'WIFI_SIMPLE') {
      return (
        <WifiSimpleWriter
          ref={handlerRef}
          value={savedValue as {ssid: string; networkKey: string} | undefined}
        />
      );
    }
    if (ndefType === 'VCARD') {
      return (
        <VCardWriter
          ref={handlerRef}
          value={savedValue as {name: string; org?: string; tel?: string; email?: string} | undefined}
        />
      );
    }
    return null;
  }

  return (
    <View style={styles.wrapper} testID="ndef-write-screen">
      <ScreenHeader
        title={savedRecord?.name || 'WRITE NDEF'}
        onBack={onBack}
        getRecordPayload={getRecordPayload}
        savedRecord={savedRecord}
        savedRecordIdx={savedRecordIdx}
      />
      <View style={styles.body}>{renderWriter()}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: colors.surface},
  body: {flex: 1, padding: 20},
});

export default NdefWriteScreen;
