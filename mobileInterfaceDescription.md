# JetSurf Mobile BLE Interface

This document describes the BLE interface exposed by the JetSurf main-control ESP32 for a phone or computer application. It is intended to be sufficient for implementing the client without reading the firmware source code.

The interface is designed for:

- Live display of the latest board signals.
- Downloading the log files from the current SD-card session.
- Analytics after a ride, when the board is not being used for propulsion.

The phone is a BLE **central/client**. The JetSurf ESP32 is a BLE **peripheral/server** for this interface.

## Important Status

This is a custom application protocol, not a standardized BLE telemetry profile. The UUIDs and packet layouts in this document are part of the current firmware contract.

The current firmware does not provide:

- A human-readable telemetry characteristic.
- A read operation for the telemetry or log characteristics.
- An acknowledgement or retry protocol for log packets.
- Pairing or application-level authentication.
- A command to select an older session.
- A command to pause or resume a transfer.

The mobile client should therefore validate packets, detect missing sequences, and treat a disconnected or incomplete transfer as failed.

## BLE Device Discovery

The ESP32 advertises with the local name:

```text
jetSurfBoard
```

The mobile application should preferably identify the device by the advertised service UUID rather than by name alone. Names can be changed or duplicated.

### Service UUID

```text
6d6f6269-6c65-2d73-7572-662d61707001
```

The ESP32 also maintains a separate BLE connection to the physical remote controller. That connection is unrelated to the phone-facing service. The remote controller sends throttle notifications to the JetSurf ESP32, and the JetSurf ESP32 remains a BLE central for that link while simultaneously acting as a BLE peripheral for the phone.

A phone connection must not be used to control throttle. The phone-facing service is for monitoring and downloading data only.

## GATT Characteristics

| Name | UUID | Properties | Direction | Purpose |
|---|---|---|---|---|
| Telemetry | `6d6f6269-6c65-2d73-7572-662d61707002` | Notify | ESP32 to app | Live signal snapshots |
| Command | `6d6f6269-6c65-2d73-7572-662d61707003` | Write | App to ESP32 | Requests a log download |
| Log data | `6d6f6269-6c65-2d73-7572-662d61707004` | Notify | ESP32 to app | Log transfer packets |

The telemetry and log characteristics are notification-only. Do not attempt to read their current values. Subscribe to notifications instead.

The command characteristic accepts a one-byte write.

## Recommended Connection Sequence

The client should use this sequence:

1. Scan for the service UUID or the name `jetSurfBoard`.
2. Connect to the device.
3. Discover services and characteristics.
4. On Android, request an ATT MTU of at least `196` bytes.
5. Subscribe to the telemetry characteristic.
6. Decode telemetry notifications as they arrive.
7. Subscribe to the log data characteristic before requesting a download.
8. Write `0x01` to the command characteristic when the user requests the latest logs.
9. Reassemble log packets until a transfer-end packet is received.
10. Unsubscribe and disconnect when the app no longer needs the connection.

The firmware prefers an ATT MTU of 256 bytes. A negotiated MTU of 196 or greater is required for the largest current log notification:

```text
13-byte log header + 180-byte payload = 193 bytes
193-byte ATT value + 3-byte ATT notification overhead = 196-byte MTU
```

If the negotiated MTU is smaller, large log notifications may fail or be rejected. The current firmware does not fragment one log packet into multiple BLE notifications.

Telemetry packets are 72 bytes and therefore fit in the default BLE MTU, but the app should still request a larger MTU for consistent log behavior.

## Live Telemetry

### Delivery behavior

Telemetry is sent approximately every 500 ms while the phone is subscribed to the telemetry characteristic. The exact arrival time can vary because of BLE scheduling and connection intervals.

No telemetry notifications are sent while the phone is not subscribed. This is intentional and avoids unnecessary radio work when no mobile client is connected.

Each notification contains one complete binary telemetry packet. The packet is packed, little-endian, and uses IEEE-754 single-precision floating-point values.

### Telemetry packet layout

The packet length is 72 bytes.

| Offset | Size | Type | Field | Meaning |
|---:|---:|---|---|---|
| 0 | 1 | `uint8` | `version` | Packet format version. Currently `1`. |
| 1 | 1 | `uint8` | `bleThrottle` | Latest throttle value received from the remote controller, 0 to 255. |
| 2 | 4 | `uint32` | `sequence` | Increments for each telemetry packet. |
| 6 | 4 | `uint32` | `timestampMs` | ESP32 monotonic time in milliseconds when the packet was created. |
| 10 | 4 | `float32` | `velocityMetSec` | GPS velocity in metres per second. |
| 14 | 4 | `float32` | `latitudeDeg` | GPS latitude in decimal degrees. |
| 18 | 4 | `float32` | `longitudeDeg` | GPS longitude in decimal degrees. |
| 22 | 4 | `float32` | `courseDeg` | GPS course/heading in degrees. 0 is north, 90 is east. |
| 26 | 4 | `uint32` | `gpsTimestampMs` | Timestamp associated with the latest GPS fix, in milliseconds. |
| 30 | 4 | `float32` | `battery1Current` | Battery 1 current, in amperes. |
| 34 | 4 | `float32` | `battery1Voltage` | Battery 1 total voltage, in volts. |
| 38 | 4 | `float32` | `battery1Soc` | Battery 1 state of charge, in percent. |
| 42 | 4 | `float32` | `battery1HighestTemp` | Highest measured Battery 1 temperature, in degrees Celsius. |
| 46 | 1 | `uint8` | `battery1HighestTempSensor` | Sensor number reporting the highest Battery 1 temperature. |
| 47 | 4 | `float32` | `battery1CellVoltageDiff` | Battery 1 maximum cell-voltage difference, in volts. |
| 51 | 4 | `float32` | `battery2Current` | Battery 2 current, in amperes. |
| 55 | 4 | `float32` | `battery2Voltage` | Battery 2 total voltage, in volts. |
| 59 | 4 | `float32` | `battery2Soc` | Battery 2 state of charge, in percent. |
| 63 | 4 | `float32` | `battery2HighestTemp` | Highest measured Battery 2 temperature, in degrees Celsius. |
| 67 | 1 | `uint8` | `battery2HighestTempSensor` | Sensor number reporting the highest Battery 2 temperature. |
| 68 | 4 | `float32` | `battery2CellVoltageDiff` | Battery 2 maximum cell-voltage difference, in volts. |

The final field ends at byte 72.

### Telemetry interpretation

`timestampMs` is not wall-clock time. It is time since the ESP32 runtime clock started. It is useful for ordering packets during one boot/session, but it cannot be converted directly to a calendar timestamp.

`gpsTimestampMs` is also an ESP32/GPS-related millisecond timestamp, not an ISO timestamp. Use it to determine whether the GPS data is newer than a previous GPS fix.

The GPS fields may contain stale or invalid-looking values when the GPS has no current fix. The app should display GPS validity based on data freshness and sensible range checks rather than assuming every packet contains a valid fix.

The app should treat a telemetry sequence gap as a missed live sample, not as a historical-data error. Live telemetry is latest-value monitoring and is not retransmitted.

### JavaScript parsing example

A notification library may provide the value as a Base64 string. Decode it into a `Uint8Array`, then use a `DataView` with little-endian reads:

```js
function readTelemetry(bytes) {
  if (bytes.byteLength !== 72) {
    throw new Error(`Unexpected telemetry length: ${bytes.byteLength}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packet = {
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

  if (packet.version !== 1) {
    throw new Error(`Unsupported telemetry version: ${packet.version}`);
  }

  return packet;
}
```

The example assumes the BLE library has already converted Base64 into bytes. The exact Base64 conversion depends on the library used by the app.

## Log Download

### Starting a download

The command characteristic accepts exactly one byte:

```text
01
```

`0x01` means `DOWNLOAD_LATEST_SESSION`.

The app must subscribe to the log data characteristic before sending the command. The ESP32 checks that the log notification subscription is enabled before starting the transfer.

The transfer includes all files named `logN.log` in the current session directory on the SD card, up to the firmware limit of 32 files. The current session is the session created by the currently running firmware instance. A new board boot normally creates a new session, so the command does not select an older session.

The transfer is deliberately slow and low priority. The firmware waits approximately 20 ms between packets. It can take a substantial amount of time for large files.

### Log packet layout

Every log notification begins with this packed 13-byte header, followed by `payloadLength` bytes of payload.

| Offset | Size | Type | Field | Meaning |
|---:|---:|---|---|---|
| 0 | 1 | `uint8` | `type` | Packet type. |
| 1 | 4 | `uint32` | `sequence` | Increments for each log notification. |
| 5 | 2 | `uint16` | `fileIndex` | Zero-based file index within this transfer. |
| 7 | 4 | `uint32` | `offset` | Byte offset in the file for data packets. |
| 11 | 2 | `uint16` | `payloadLength` | Number of valid payload bytes after the header. |
| 13 | variable | `uint8[]` | `payload` | Packet payload. |

All integer fields are little-endian. The maximum payload is 180 bytes. Therefore the maximum notification value is 193 bytes.

### Packet types

#### File start: `0x10`

Sent once before each file.

- `fileIndex` identifies the file in this transfer.
- `payload` is the UTF-8 filename including a trailing null byte, for example:

```text
log1.log\0
```

- `payloadLength` includes the trailing null byte.
- `offset` is zero.

The client should store the filename associated with `fileIndex`.

#### File data: `0x11`

Contains a consecutive chunk of one file.

- `fileIndex` identifies the file.
- `offset` is the byte position of the payload within that file.
- `payloadLength` is normally 180, except for the final chunk.
- `payload` contains raw log-file bytes.

Append or place the payload at the specified offset. Do not rely only on arrival order; verify that the offset is the expected next offset.

The current files are text logs, normally UTF-8-compatible ASCII text. Treat the payload as bytes while receiving and decode it as text only after the complete file has been assembled.

#### File end: `0x12`

Sent after all data for one file.

- `fileIndex` identifies the file.
- `offset` is the total number of file bytes sent.
- `payloadLength` is zero.

The client should verify that the assembled file length equals `offset`.

#### Transfer end: `0x13`

Sent after all files have been sent.

- `payloadLength` is zero.
- The client can mark the transfer complete after receiving this packet.

#### Transfer error: `0x7f`

Indicates that the ESP32 could not perform the transfer. Possible causes include:

- The SD card is unavailable.
- The current session directory could not be read.
- A file could not be opened or read.
- The notification subscription was not active.

The app should discard or mark the incomplete transfer as failed when it receives this packet.

### Log transfer state machine

A robust client can use this state machine:

```text
IDLE
  -> connect and discover
READY
  -> subscribe to log data
LOG_READY
  -> write 01 to command
DOWNLOADING
  -> receive FILE_START
FILE_OPEN
  -> receive FILE_DATA repeatedly
FILE_OPEN
  -> receive FILE_END
LOG_READY or DOWNLOADING
  -> receive next FILE_START
DOWNLOADING
  -> receive TRANSFER_END
COMPLETE
```

At every stage, the client should handle:

- Disconnect.
- Notification errors.
- Unexpected packet type.
- Unknown `fileIndex`.
- Sequence gaps.
- Offset gaps or overlaps.
- Payload lengths larger than the received notification.
- A second download request while one is already running.

There is currently no retry command. If a transfer fails, reconnect and request the download again.

### JavaScript log packet parsing example

```js
function readLogPacket(bytes) {
  if (bytes.byteLength < 13) {
    throw new Error("Log packet is shorter than its header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const sequence = view.getUint32(1, true);
  const fileIndex = view.getUint16(5, true);
  const offset = view.getUint32(7, true);
  const payloadLength = view.getUint16(11, true);

  if (payloadLength > 180 || 13 + payloadLength !== bytes.byteLength) {
    throw new Error("Invalid log packet length");
  }

  return {
    type,
    sequence,
    fileIndex,
    offset,
    payload: bytes.slice(13, 13 + payloadLength),
  };
}
```

## Expo and React Native

A BLE library requires native Bluetooth code. The standard Expo Go application does not include arbitrary third-party native BLE modules.

For a library such as `react-native-ble-plx`, use an Expo development build rather than relying on Expo Go:

1. Create the project with `create-expo-app`.
2. Install the BLE library.
3. Add the required Android Bluetooth permissions through the Expo configuration plugin or native configuration.
4. Build and install a development client on the Android phone.
5. Test BLE using that development client.

The application should not assume that `npm start` plus Expo Go is enough for BLE access.

The BLE library must provide support for:

- Scanning by service UUID.
- Connecting by device identifier.
- Discovering all services and characteristics.
- Enabling notifications.
- Writing a one-byte command.
- Requesting an Android MTU.
- Converting notification values from Base64 to bytes.
- Detecting disconnects and reconnecting.

On Android, the app must request the appropriate runtime permissions. The exact permissions vary by Android version, but modern Android generally requires Bluetooth scan and connect permissions. Location permission may also be relevant for older Android versions or device-specific BLE scanning behavior.

The user may also need to enable Bluetooth. The app should show a useful error when Bluetooth is disabled or when the required permission is denied.

### Suggested BLE service wrapper

Keep BLE operations behind a small service module rather than spreading UUIDs and packet parsing throughout UI components. A useful boundary is:

```text
bleClient
  scanForJetSurfBoard()
  connect(deviceId)
  subscribeToTelemetry(listener)
  requestLatestLogs()
  subscribeToLogTransfer(listener)
  disconnect()

telemetryParser
  parseTelemetry(bytes)

logTransferParser
  parsePacket(bytes)
  consumePacket(packet)
```

The UI should receive decoded telemetry objects and completed log files, not raw Base64 strings.

## Connection and lifecycle behavior

The ESP32 advertises continuously after its BLE host starts. When a phone connects, the firmware logs a message similar to:

```text
bleMobileInterface: Mobile phone connected
```

That message means the link is connected. It does not mean that telemetry notifications have been enabled. The client must subscribe to the telemetry characteristic.

Telemetry is emitted only after the subscription succeeds.

The phone connection is independent of the remote-controller connection. The existing remote link requests a 7.5 ms connection interval and receives throttle notifications. The phone application should not attempt to alter that link or write to its characteristics.

If the phone disconnects:

- The remote controller should continue operating.
- The JetSurf throttle timeout remains independent of the phone.
- Live telemetry stops because there is no subscriber.
- An active log transfer becomes incomplete and should be discarded or marked failed by the app.

If the phone reconnects, it must rediscover services and subscribe again. Notification subscriptions should not be assumed to survive a new connection.

## Data storage recommendations

For live values, keep only the latest decoded telemetry packet in React state or a small rolling buffer. A 500 ms stream is suitable for a live dashboard.

For analytics:

1. Receive telemetry while connected.
2. Store completed log files locally after download.
3. Parse the text log format separately from BLE packet parsing.
4. Convert signal lines into typed samples for charts.
5. Preserve the original raw log file so parsing can be improved later.

The BLE interface currently transfers the existing text log files. It does not transfer a structured binary historical telemetry format.

## Security and trust

The current interface does not require pairing, encryption, authentication, or authorization. Any nearby compatible BLE client may be able to connect and request the current logs.

This is acceptable for initial development but should be revisited before treating the app as a production or privacy-sensitive system. GPS data and ride history may be sensitive.

Possible future improvements include:

- BLE security and encrypted characteristics.
- Application-level authentication.
- A session-list command.
- Download checksums.
- Transfer acknowledgements and resume support.
- A structured binary historical-data format.

## Quick manual test

A generic BLE inspection tool can test the firmware before the React Native app exists:

1. Connect to `jetSurfBoard`.
2. Discover service `...7001`.
3. Enable notifications on `...7002`.
4. Confirm approximately 72-byte notifications arrive every 500 ms.
5. Enable notifications on `...7004`.
6. Write hexadecimal `01` to `...7003`.
7. Confirm `0x10`, `0x11`, `0x12`, and finally `0x13` log packets arrive.

The full UUIDs should be used in the client; the suffixes above are only shorthand:

```text
Service:    6d6f6269-6c65-2d73-7572-662d61707001
Telemetry:  6d6f6269-6c65-2d73-7572-662d61707002
Command:    6d6f6269-6c65-2d73-7572-662d61707003
Log data:   6d6f6269-6c65-2d73-7572-662d61707004
```
