import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';

import {
    COMMAND_UUID,
    decodeBase64,
    LOG_DATA_UUID,
    SERVICE_UUID,
    TELEMETRY_UUID,
} from '@/services/ble-protocol';

export class JetSurfBleClient {
  private readonly manager = new BleManager();
  private device: Device | null = null;

  async connect(): Promise<Device> {
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const permissions = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      if (Object.values(permissions).some((permission) => permission !== PermissionsAndroid.RESULTS.GRANTED)) {
        throw new Error('Bluetooth permission was denied.');
      }
    }
    if ((await this.manager.state()) !== State.PoweredOn) {
      throw new Error('Bluetooth is disabled or unavailable. Turn on Bluetooth and try again.');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      this.manager.startDeviceScan([SERVICE_UUID], null, async (error, device) => {
        if (error) {
          this.manager.stopDeviceScan();
          reject(error);
          return;
        }
        if (!device || device.name !== 'jetSurfBoard') return;
        this.manager.stopDeviceScan();
        try {
          const connected = await device.connect();
          await connected.discoverAllServicesAndCharacteristics();
          this.device = connected;
          settled = true;
          resolve(connected);
        } catch (connectionError) {
          reject(connectionError);
        }
      });
      setTimeout(() => {
        if (!settled) {
          this.manager.stopDeviceScan();
          reject(new Error('No JetSurf board found nearby.'));
        }
      }, 12000);
    });
  }

  subscribeToTelemetry(onValue: (bytes: Uint8Array) => void): Subscription {
    const device = this.requireDevice();
    return device.monitorCharacteristicForService(SERVICE_UUID, TELEMETRY_UUID, (error, characteristic) => {
      if (!error && characteristic?.value) onValue(decodeBase64(characteristic.value));
    });
  }

  subscribeToLogs(onValue: (bytes: Uint8Array) => void): Subscription {
    const device = this.requireDevice();
    return device.monitorCharacteristicForService(SERVICE_UUID, LOG_DATA_UUID, (error, characteristic) => {
      if (!error && characteristic?.value) onValue(decodeBase64(characteristic.value));
    });
  }

  async requestLatestLogs(): Promise<void> {
    const device = this.requireDevice();
    await device.writeCharacteristicWithResponseForService(SERVICE_UUID, COMMAND_UUID, 'AQ==');
  }

  async disconnect(): Promise<void> {
    if (this.device) await this.device.cancelConnection();
    this.device = null;
  }

  destroy(): void {
    this.manager.destroy();
  }

  private requireDevice(): Device {
    if (!this.device) throw new Error('Connect to a JetSurf board first.');
    return this.device;
  }
}