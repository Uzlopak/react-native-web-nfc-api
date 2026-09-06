/**
 * NfcTransport (§5): the injectable seam between SessionCoordinator and
 * "however native operations actually happen" — real TurboModule on
 * Android/iOS, or InMemoryNfcTransport in tests/demos. Zero react-native
 * imports, zero DOM-only types — must run unchanged under Node/Jest, in
 * Chrome, and on-device (§5).
 *
 * Cancellation is expressed via operationId, not AbortSignal (§5c) — that
 * translation happens in WebNfcReader.ts, which owns AbortSignal handling.
 */
import type {NdefWireRecord} from './lib/ndef-wire';

export type Subscription = {remove: () => void};

export interface LaunchTagActivation {
  activationId: string;
  serialNumber?: string;
  records: NdefWireRecord[];
}

export interface TagDiscoveredEvent {
  operationId: string;
  serialNumber: string;
  records: NdefWireRecord[];
}

export type OperationEndedReason =
  | 'cancelled'
  | 'timeout'
  | 'error'
  | 'success';

export interface OperationEndedEvent {
  operationId: string;
  reason: OperationEndedReason;
  message?: string;
}

export interface StateChangedEvent {
  enabled: boolean;
}

export interface AppStateChangedEvent {
  state: 'foreground' | 'background';
}

export interface LaunchTagReceivedEvent {
  activationId: string;
}

export interface NfcTransportEventMap {
  tagDiscovered: TagDiscoveredEvent;
  operationEnded: OperationEndedEvent;
  stateChanged: StateChangedEvent;
  appStateChanged: AppStateChangedEvent;
  launchTagReceived: LaunchTagReceivedEvent;
}

export type NfcTransportEventType = keyof NfcTransportEventMap;

export interface NfcTransport {
  isSupported(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  beginScan(operationId: string, opts: {alertMessage?: string}): Promise<void>;
  beginWrite(
    operationId: string,
    records: NdefWireRecord[],
    opts: {overwrite: boolean; alertMessage?: string},
  ): Promise<void>;
  beginMakeReadOnly(
    operationId: string,
    opts: {alertMessage?: string},
  ): Promise<void>;
  cancelOperation(operationId: string): Promise<void>;
  consumePendingLaunchTag(): Promise<LaunchTagActivation | null>;
  addEventListener<T extends NfcTransportEventType>(
    type: T,
    cb: (ev: NfcTransportEventMap[T]) => void,
  ): Subscription;
}
