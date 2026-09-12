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
    console.log('[BLE] Connect requested');
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const permissions = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      console.log('[BLE] Android permission result:', permissions);
      if (Object.values(permissions).some((permission) => permission !== PermissionsAndroid.RESULTS.GRANTED)) {
        console.warn('[BLE] Bluetooth permission was denied');
        throw new Error('Bluetooth permission was denied.');
      }
    }
    const bluetoothState = await this.manager.state();
    console.log('[BLE] Bluetooth state:', bluetoothState);
    if (bluetoothState !== State.PoweredOn) {
      console.warn('[BLE] Bluetooth is not powered on');
      throw new Error('Bluetooth is disabled or unavailable. Turn on Bluetooth and try again.');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let discoveredCount = 0;
      console.log('[BLE] Starting scan. Target name: jetSurfBoard');
      this.manager.startDeviceScan(null, null, async (error, device) => {
        if (error) {
          console.error('[BLE] Scan error:', error.message, error);
          this.manager.stopDeviceScan();
          reject(error);
          return;
        }
        if (!device) return;
        discoveredCount += 1;
        console.log('[BLE] Device discovered:', {
          id: device.id,
          name: device.name,
          localName: device.localName,
          serviceUUIDs: device.serviceUUIDs,
          rssi: device.rssi,
        });
        const advertisedService = device.serviceUUIDs?.some(
          (uuid) => uuid.toLowerCase() === SERVICE_UUID.toLowerCase(),
        );
        const advertisedName = device.name === 'jetSurfBoard' || device.localName === 'jetSurfBoard';
        if (!advertisedName && !advertisedService) {
          console.log('[BLE] Ignoring device: name/service did not match');
          return;
        }
        console.log('[BLE] Matching JetSurf candidate:', device.id);
        this.manager.stopDeviceScan();
        try {
          console.log('[BLE] Connecting to candidate:', device.id);
          const connected = await device.connect();
          console.log('[BLE] Connected, discovering services and characteristics');
          await connected.discoverAllServicesAndCharacteristics();
          this.device = connected;
          settled = true;
          console.log('[BLE] JetSurf connection ready:', connected.id);
          resolve(connected);
        } catch (connectionError) {
          console.error('[BLE] Connection or service discovery failed:', connectionError);
          settled = true;
          reject(connectionError);
        }
      });
      setTimeout(() => {
        if (!settled) {
          this.manager.stopDeviceScan();
          const message = `No JetSurf board found. BLE devices discovered: ${discoveredCount}. See [BLE] logs in the Metro terminal.`;
          console.warn(`[BLE] Scan timeout. ${message}`);
          settled = true;
          reject(new Error(message));
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