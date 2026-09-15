import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device, State, Subscription } from 'react-native-ble-plx';

import {
    COMMAND_UUID,
    decodeBase64,
    LOG_DATA_UUID,
    LOG_HEADER_LENGTH,
    SERVICE_UUID,
    TELEMETRY_PACKET_LENGTH,
    TELEMETRY_UUID,
} from '@/services/ble-protocol';

export class JetSurfBleClient {
  private readonly manager = new BleManager();
  private device: Device | null = null;
  private telemetryBuffer: number[] = [];
  private logBuffer: number[] = [];
  private logPacketCount = 0;
  private lastLogProgressAt = 0;

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
          if (Platform.OS === 'android') {
            console.log('[BLE] Requesting Android MTU 196');
            const mtuDevice = await connected.requestMTU(196);
            console.log('[BLE] Negotiated Android MTU:', mtuDevice.mtu);
          }
          console.log('[BLE] Connected, discovering services and characteristics');
          await connected.discoverAllServicesAndCharacteristics();
          const services = await connected.services();
          for (const service of services) {
            const characteristics = await connected.characteristicsForService(service.uuid);
            console.log('[BLE] GATT service:', service.uuid, 'characteristics:', characteristics.map((characteristic) => ({
              uuid: characteristic.uuid,
              isNotifiable: characteristic.isNotifiable,
              isIndicatable: characteristic.isIndicatable,
              isWritableWithResponse: characteristic.isWritableWithResponse,
              isWritableWithoutResponse: characteristic.isWritableWithoutResponse,
            })));
          }
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
    this.telemetryBuffer = [];
    console.log('[BLE] Subscribing to telemetry:', SERVICE_UUID, TELEMETRY_UUID);
    return device.monitorCharacteristicForService(SERVICE_UUID, TELEMETRY_UUID, (error, characteristic) => {
      if (error) {
        console.error('[BLE] Telemetry notification error:', error.message, error);
        return;
      }
      if (!characteristic?.value) {
        console.warn('[BLE] Telemetry callback had no value');
        return;
      }
      const bytes = decodeBase64(characteristic.value);
      console.log('[BLE] Telemetry notification received:', bytes.byteLength, 'bytes');
      this.telemetryBuffer.push(...bytes);
      while (this.telemetryBuffer.length >= TELEMETRY_PACKET_LENGTH) {
        const packet = new Uint8Array(this.telemetryBuffer.splice(0, TELEMETRY_PACKET_LENGTH));
        console.log('[BLE] Complete telemetry packet reassembled:', packet.byteLength, 'bytes');
        onValue(packet);
      }
      if (this.telemetryBuffer.length > 0) {
        console.log('[BLE] Telemetry bytes buffered:', this.telemetryBuffer.length);
      }
    });
  }

  subscribeToLogs(onValue: (bytes: Uint8Array) => void): Subscription {
    const device = this.requireDevice();
    this.logBuffer = [];
    this.logPacketCount = 0;
    this.lastLogProgressAt = 0;
    console.log('[BLE] Subscribing to logs:', SERVICE_UUID, LOG_DATA_UUID);
    return device.monitorCharacteristicForService(SERVICE_UUID, LOG_DATA_UUID, (error, characteristic) => {
      if (error) {
        console.error('[BLE] Log notification error:', error.message, error);
        return;
      }
      if (!characteristic?.value) {
        console.warn('[BLE] Log callback had no value');
        return;
      }
      const bytes = decodeBase64(characteristic.value);
      this.logBuffer.push(...bytes);
      while (this.logBuffer.length >= LOG_HEADER_LENGTH) {
        const payloadLength = this.logBuffer[11] | (this.logBuffer[12] << 8);
        if (payloadLength > 180) {
          console.error('[BLE] Invalid log payload length in buffered data:', payloadLength);
          this.logBuffer = [];
          return;
        }
        const packetLength = LOG_HEADER_LENGTH + payloadLength;
        if (this.logBuffer.length < packetLength) break;
        const packet = new Uint8Array(this.logBuffer.splice(0, packetLength));
        this.logPacketCount += 1;
        const now = Date.now();
        if (now - this.lastLogProgressAt >= 1000) {
          console.log('[BLE] Log transfer packets received:', this.logPacketCount, 'latest packet:', packet.byteLength, 'bytes');
          this.lastLogProgressAt = now;
        }
        onValue(packet);
      }
      if (this.logBuffer.length > 0) console.log('[BLE] Log bytes buffered:', this.logBuffer.length);
    });
  }

  async requestLatestLogs(): Promise<void> {
    const device = this.requireDevice();
    await device.writeCharacteristicWithResponseForService(SERVICE_UUID, COMMAND_UUID, 'AQ==');
  }

  async disconnect(): Promise<void> {
    if (this.device) await this.device.cancelConnection();
    this.device = null;
    this.telemetryBuffer = [];
    this.logBuffer = [];
    this.logPacketCount = 0;
  }

  destroy(): void {
    this.manager.destroy();
  }

  private requireDevice(): Device {
    if (!this.device) throw new Error('Connect to a JetSurf board first.');
    return this.device;
  }
}