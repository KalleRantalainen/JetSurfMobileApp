export const SERVICE_UUID = '6d6f6269-6c65-2d73-7572-662d61707001';
export const TELEMETRY_UUID = '6d6f6269-6c65-2d73-7572-662d61707002';
export const COMMAND_UUID = '6d6f6269-6c65-2d73-7572-662d61707003';
export const LOG_DATA_UUID = '6d6f6269-6c65-2d73-7572-662d61707004';

export const TELEMETRY_PACKET_LENGTH = 72;
export const LOG_HEADER_LENGTH = 13;

export type Telemetry = {
  version: number;
  bleThrottle: number;
  sequence: number;
  timestampMs: number;
  velocityMetSec: number;
  latitudeDeg: number;
  longitudeDeg: number;
  courseDeg: number;
  gpsTimestampMs: number;
  battery1Current: number;
  battery1Voltage: number;
  battery1Soc: number;
  battery1HighestTemp: number;
  battery1HighestTempSensor: number;
  battery1CellVoltageDiff: number;
  battery2Current: number;
  battery2Voltage: number;
  battery2Soc: number;
  battery2HighestTemp: number;
  battery2HighestTempSensor: number;
  battery2CellVoltageDiff: number;
};

export type LogPacket = {
  type: number;
  sequence: number;
  fileIndex: number;
  offset: number;
  payload: Uint8Array;
};

export function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const cleanValue = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((cleanValue.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const character of cleanValue) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid Base64 notification');
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

export function parseTelemetry(bytes: Uint8Array): Telemetry {
  if (bytes.byteLength !== TELEMETRY_PACKET_LENGTH) {
    throw new Error(`Unexpected telemetry length: ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packet: Telemetry = {
    version: view.getUint8(0),
    bleThrottle: view.getUint8(1),
    sequence: view.getUint32(2, true),
    timestampMs: view.getUint32(6, true),
    velocityMetSec: view.getFloat32(10, true),
    latitudeDeg: view.getFloat32(14, true),
    longitudeDeg: view.getFloat32(18, true),
    courseDeg: view.getFloat32(22, true),
    gpsTimestampMs: view.getUint32(26, true),
    battery1Current: view.getFloat32(30, true),
    battery1Voltage: view.getFloat32(34, true),
    battery1Soc: view.getFloat32(38, true),
    battery1HighestTemp: view.getFloat32(42, true),
    battery1HighestTempSensor: view.getUint8(46),
    battery1CellVoltageDiff: view.getFloat32(47, true),
    battery2Current: view.getFloat32(51, true),
    battery2Voltage: view.getFloat32(55, true),
    battery2Soc: view.getFloat32(59, true),
    battery2HighestTemp: view.getFloat32(63, true),
    battery2HighestTempSensor: view.getUint8(67),
    battery2CellVoltageDiff: view.getFloat32(68, true),
  };
  if (packet.version !== 1) throw new Error(`Unsupported telemetry version: ${packet.version}`);
  return packet;
}

export function parseLogPacket(bytes: Uint8Array): LogPacket {
  if (bytes.byteLength < LOG_HEADER_LENGTH) throw new Error('Log packet is shorter than its header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint16(11, true);
  if (payloadLength > 180 || LOG_HEADER_LENGTH + payloadLength !== bytes.byteLength) {
    throw new Error('Invalid log packet length');
  }
  return {
    type: view.getUint8(0),
    sequence: view.getUint32(1, true),
    fileIndex: view.getUint16(5, true),
    offset: view.getUint32(7, true),
    payload: bytes.slice(LOG_HEADER_LENGTH),
  };
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0$/, '');
}

export function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    result += alphabet[first >> 2];
    result += alphabet[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
    result += second === undefined ? '==' : alphabet[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
    result += third === undefined ? '=' : alphabet[third & 63];
  }
  return result;
}