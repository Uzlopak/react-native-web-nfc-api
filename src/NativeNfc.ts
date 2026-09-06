/**
 * Turbo Module spec (§3). Native exposes an operation-oriented API: every
 * call that starts work takes a JS-chosen operationId, every native event
 * carries that id, and a single cancelOperation(id) cancels any operation
 * regardless of kind. SessionCoordinator (§5a) is what actually serializes
 * overlapping logical requests onto the one physical NFC reader.
 *
 * NOTE (§3): this Spec, including consumePendingLaunchTag(), is a draft
 * until validated by the native feasibility spikes (§7c) — those spikes are
 * out of scope for this build-order slice (steps 1-5); only the JS-side
 * contract is being frozen here for now.
 */
import {type TurboModule, TurboModuleRegistry} from 'react-native';
import type {NdefWireRecord} from './lib/ndef-wire';

export interface Spec extends TurboModule {
  isSupported(): Promise<boolean>;
  isEnabled(): Promise<boolean>;

  beginScan(
    operationId: string,
    options: {alertMessage?: string},
  ): Promise<void>;
  beginWrite(
    operationId: string,
    records: NdefWireRecord[],
    options: {overwrite: boolean; alertMessage?: string},
  ): Promise<void>;
  beginMakeReadOnly(
    operationId: string,
    options: {alertMessage?: string},
  ): Promise<void>;
  cancelOperation(operationId: string): Promise<void>;

  consumePendingLaunchTag(): Promise<{
    activationId: string;
    serialNumber?: string;
    records: NdefWireRecord[];
  } | null>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('NativeNfc');
