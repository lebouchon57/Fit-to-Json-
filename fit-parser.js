/**
 * Pure Vanilla JS Garmin .FIT Binary Protocol Decoder
 * Zero external dependencies — runs 100% offline in any modern mobile or desktop browser.
 */

const FIT_EPOCH_OFFSET_SEC = 631065600; // 1989-12-31T00:00:00Z in Unix epoch seconds
const SEMICIRCLE_TO_DEGREE = 180.0 / 2147483648.0;

const BASE_TYPE_SIZES = {
  0: 1, // enum
  1: 1, // sint8
  2: 1, // uint8
  3: 2, // sint16
  4: 2, // uint16
  5: 4, // sint32
  6: 4, // uint32
  7: 1, // string
  8: 4, // float32
  9: 8, // float64
  10: 1, // uint8z
  11: 2, // uint16z
  12: 4, // uint32z
  13: 1, // byte
  14: 8, // sint64
  15: 8, // uint64
  16: 8  // uint64z
};

export function isValidFitBuffer(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 14) return false;
  const bytes = new Uint8Array(arrayBuffer, 0, 14);
  return (
    bytes[8] === 0x2e && // '.'
    bytes[9] === 0x46 && // 'F'
    bytes[10] === 0x49 && // 'I'
    bytes[11] === 0x54    // 'T'
  );
}

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatFitTimestamp(fitSeconds) {
  if (fitSeconds === null || fitSeconds === undefined || fitSeconds === 0xffffffff || fitSeconds < 0x10000000) {
    return "";
  }
  const date = new Date((fitSeconds + FIT_EPOCH_OFFSET_SEC) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readScalarField(view, offset, size, baseTypeNum, littleEndian) {
  const typeId = baseTypeNum & 0x1f;
  const expectedSize = BASE_TYPE_SIZES[typeId] || 1;
  if (offset + size > view.byteLength) return null;
  if (size !== expectedSize) return null;

  switch (typeId) {
    case 0: // enum
    case 2: { // uint8
      const val = view.getUint8(offset);
      return val === 0xff ? null : val;
    }
    case 1: { // sint8
      const val = view.getInt8(offset);
      return val === 0x7f ? null : val;
    }
    case 3: { // sint16
      const val = view.getInt16(offset, littleEndian);
      return val === 0x7fff ? null : val;
    }
    case 4: { // uint16
      const val = view.getUint16(offset, littleEndian);
      return val === 0xffff ? null : val;
    }
    case 5: { // sint32
      const val = view.getInt32(offset, littleEndian);
      return val === 0x7fffffff ? null : val;
    }
    case 6: { // uint32
      const val = view.getUint32(offset, littleEndian);
      return val === 0xffffffff ? null : val;
    }
    case 8: { // float32
      const val = view.getFloat32(offset, littleEndian);
      return Number.isNaN(val) ? null : val;
    }
    case 9: { // float64
      const val = view.getFloat64(offset, littleEndian);
      return Number.isNaN(val) ? null : val;
    }
    case 10: { // uint8z
      const val = view.getUint8(offset);
      return val === 0x00 ? null : val;
    }
    case 11: { // uint16z
      const val = view.getUint16(offset, littleEndian);
      return val === 0x0000 ? null : val;
    }
    case 12: { // uint32z
      const val = view.getUint32(offset, littleEndian);
      return val === 0x00000000 ? null : val;
    }
    default:
      return null;
  }
}

export function parseFitBuffer(arrayBuffer, fileName = "activity.fit", reportedSize = 0) {
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new Error("Le fichier .FIT est vide (0 octet).");
  }

  const view = new DataView(arrayBuffer);
  const effectiveSize = reportedSize > 0 ? reportedSize : arrayBuffer.byteLength;

  if (!isValidFitBuffer(arrayBuffer)) {
    throw new Error("Signature .FIT invalide : ce fichier ne respecte pas le protocole Garmin FIT.");
  }

  const records = [];
  const lapRecords = [];
  const sessionRecords = [];

  let offset = 0;

  while (offset + 14 <= view.byteLength) {
    const headerSize = view.getUint8(offset);
    if (headerSize < 12 || offset + headerSize > view.byteLength) break;

    const bytes = new Uint8Array(arrayBuffer, offset, 12);
    const hasMagic = bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
    if (!hasMagic) break;

    const dataSize = view.getUint32(offset + 4, true);
    const dataStart = offset + headerSize;
    const dataEnd = Math.min(dataStart + dataSize, view.byteLength);

    let cursor = dataStart;
    const definitions = new Map();
    let lastTimestamp = 0;

    while (cursor < dataEnd) {
      const recordHeader = view.getUint8(cursor);
      cursor += 1;

      const isCompressedTs = (recordHeader & 0x80) !== 0;
      const isDefinition = !isCompressedTs && (recordHeader & 0x40) !== 0;

      if (isDefinition) {
        if (cursor + 5 > dataEnd) break;
        const hasDeveloperFields = (recordHeader & 0x20) !== 0;
        const localMesgNum = recordHeader & 0x0f;

        cursor += 1; // reserved byte
        const architecture = view.getUint8(cursor);
        cursor += 1;
        const littleEndian = architecture === 0;

        const globalMesgNum = view.getUint16(cursor, littleEndian);
        cursor += 2;

        const numFields = view.getUint8(cursor);
        cursor += 1;

        const fields = [];
        for (let i = 0; i < numFields; i++) {
          if (cursor + 3 > dataEnd) break;
          fields.push({
            fieldDefNum: view.getUint8(cursor),
            size: view.getUint8(cursor + 1),
            baseType: view.getUint8(cursor + 2)
          });
          cursor += 3;
        }

        let devBytesTotal = 0;
        if (hasDeveloperFields && cursor < dataEnd) {
          const numDevFields = view.getUint8(cursor);
          cursor += 1;
          for (let i = 0; i < numDevFields; i++) {
            if (cursor + 3 > dataEnd) break;
            devBytesTotal += view.getUint8(cursor + 1);
            cursor += 3;
          }
        }

        definitions.set(localMesgNum, {
          globalMesgNum,
          littleEndian,
          fields,
          devBytesTotal
        });
      } else {
        const localMesgNum = isCompressedTs
          ? (recordHeader >> 5) & 0x03
          : recordHeader & 0x0f;

        if (isCompressedTs) {
          const timeOffset = recordHeader & 0x1f;
          let ts = (lastTimestamp & 0xffffffe0) + timeOffset;
          if (timeOffset < (lastTimestamp & 0x1f)) {
            ts += 32;
          }
          lastTimestamp = ts;
        }

        const def = definitions.get(localMesgNum);
        if (!def) {
          break;
        }

        const fieldValues = {};
        let aborted = false;

        for (const field of def.fields) {
          if (cursor + field.size > dataEnd) {
            aborted = true;
            break;
          }
          // Only extract scalar values from messages we care about (Record=20, Lap=19, Session=18)
          if (def.globalMesgNum === 20 || def.globalMesgNum === 19 || def.globalMesgNum === 18) {
            const val = readScalarField(view, cursor, field.size, field.baseType, def.littleEndian);
            if (val !== null) {
              fieldValues[field.fieldDefNum] = val;
            }
          }
          cursor += field.size;
        }

        if (aborted) break;
        cursor += def.devBytesTotal;

        if (fieldValues[253] !== undefined) {
          lastTimestamp = fieldValues[253];
        } else if (isCompressedTs && lastTimestamp > 0) {
          fieldValues[253] = lastTimestamp;
        }

        if (def.globalMesgNum === 20) {
          // Record message
          const latRaw = fieldValues[0];
          const lonRaw = fieldValues[1];
          const altRaw = fieldValues[78] !== undefined ? fieldValues[78] : fieldValues[2];
          const speedRaw = fieldValues[73] !== undefined ? fieldValues[73] : fieldValues[6];
          const distRaw = fieldValues[5];

          records.push({
            timestamp: formatFitTimestamp(fieldValues[253]),
            latitude: latRaw !== undefined && latRaw !== 0 ? latRaw * SEMICIRCLE_TO_DEGREE : null,
            longitude: lonRaw !== undefined && lonRaw !== 0 ? lonRaw * SEMICIRCLE_TO_DEGREE : null,
            distanceMeters: distRaw !== undefined ? distRaw / 100.0 : null,
            altitudeMeters: altRaw !== undefined ? altRaw / 5.0 - 500.0 : null,
            speedMs: speedRaw !== undefined ? speedRaw / 1000.0 : null,
            heartRate: fieldValues[3] !== undefined ? fieldValues[3] : null,
            power: fieldValues[7] !== undefined ? fieldValues[7] : null
          });
        } else if (def.globalMesgNum === 19) {
          // Lap message fallback
          const latRaw = fieldValues[3];
          const lonRaw = fieldValues[4];
          const altRaw = fieldValues[112] !== undefined ? fieldValues[112] : fieldValues[42];
          const speedRaw = fieldValues[110] !== undefined ? fieldValues[110] : fieldValues[13];
          const distRaw = fieldValues[9];
          const tsVal = fieldValues[2] !== undefined ? fieldValues[2] : fieldValues[253];

          lapRecords.push({
            timestamp: formatFitTimestamp(tsVal),
            latitude: latRaw !== undefined && latRaw !== 0 ? latRaw * SEMICIRCLE_TO_DEGREE : null,
            longitude: lonRaw !== undefined && lonRaw !== 0 ? lonRaw * SEMICIRCLE_TO_DEGREE : null,
            distanceMeters: distRaw !== undefined ? distRaw / 100.0 : null,
            altitudeMeters: altRaw !== undefined ? altRaw / 5.0 - 500.0 : null,
            speedMs: speedRaw !== undefined ? speedRaw / 1000.0 : null,
            heartRate: fieldValues[15] !== undefined ? fieldValues[15] : null,
            power: fieldValues[19] !== undefined ? fieldValues[19] : null
          });
        } else if (def.globalMesgNum === 18) {
          // Session message fallback
          const latRaw = fieldValues[3];
          const lonRaw = fieldValues[4];
          const altRaw = fieldValues[126] !== undefined ? fieldValues[126] : fieldValues[49];
          const speedRaw = fieldValues[124] !== undefined ? fieldValues[124] : fieldValues[14];
          const distRaw = fieldValues[9];
          const tsVal = fieldValues[2] !== undefined ? fieldValues[2] : fieldValues[253];

          sessionRecords.push({
            timestamp: formatFitTimestamp(tsVal),
            latitude: latRaw !== undefined && latRaw !== 0 ? latRaw * SEMICIRCLE_TO_DEGREE : null,
            longitude: lonRaw !== undefined && lonRaw !== 0 ? lonRaw * SEMICIRCLE_TO_DEGREE : null,
            distanceMeters: distRaw !== undefined ? distRaw / 100.0 : null,
            altitudeMeters: altRaw !== undefined ? altRaw / 5.0 - 500.0 : null,
            speedMs: speedRaw !== undefined ? speedRaw / 1000.0 : null,
            heartRate: fieldValues[16] !== undefined ? fieldValues[16] : null,
            power: fieldValues[20] !== undefined ? fieldValues[20] : null
          });
        }
      }
    }

    // Advance past 2-byte trailing CRC for chained FIT segments
    offset = dataEnd + 2;
  }

  const usedFallback = records.length === 0;
  const effectiveRecords =
    records.length > 0
      ? records
      : lapRecords.length > 0
        ? lapRecords
        : sessionRecords;

  if (effectiveRecords.length === 0) {
    throw new Error("Aucune donnée d'activité (Record, Lap ou Session) trouvée dans ce fichier .FIT.");
  }

  const lines = ["timestamp,latitude,longitude,distance,altitude,speed,heart_rate,power"];
  for (const rec of effectiveRecords) {
    const latStr = rec.latitude !== null ? rec.latitude.toFixed(6) : "";
    const lonStr = rec.longitude !== null ? rec.longitude.toFixed(6) : "";
    const distStr = rec.distanceMeters !== null ? rec.distanceMeters.toFixed(2) : "";
    const altStr = rec.altitudeMeters !== null ? rec.altitudeMeters.toFixed(1) : "";
    const speedStr = rec.speedMs !== null ? rec.speedMs.toFixed(2) : "";
    const hrStr = rec.heartRate !== null ? String(rec.heartRate) : "";
    const powerStr = rec.power !== null ? String(rec.power) : "";

    lines.push(`${rec.timestamp},${latStr},${lonStr},${distStr},${altStr},${speedStr},${hrStr},${powerStr}`);
  }

  const csvContent = `${lines.join("\n")}\n`;
  const csvSizeBytes = new TextEncoder().encode(csvContent).length;

  const hrList = effectiveRecords.map((r) => r.heartRate).filter((v) => v !== null && v > 0);
  const powerList = effectiveRecords.map((r) => r.power).filter((v) => v !== null && v > 0);
  const speedList = effectiveRecords.map((r) => r.speedMs).filter((v) => v !== null && v > 0);
  const distList = effectiveRecords.map((r) => r.distanceMeters).filter((v) => v !== null);

  const totalDistanceMeters = usedFallback
    ? distList.reduce((acc, v) => acc + v, 0)
    : distList.length > 0
      ? distList[distList.length - 1]
      : 0;

  const avgHeartRate = hrList.length > 0
    ? Math.round(hrList.reduce((a, b) => a + b, 0) / hrList.length)
    : null;
  const avgPower = powerList.length > 0
    ? Math.round(powerList.reduce((a, b) => a + b, 0) / powerList.length)
    : null;
  const avgSpeedKmh = speedList.length > 0
    ? (speedList.reduce((a, b) => a + b, 0) / speedList.length) * 3.6
    : null;

  return {
    csvContent,
    csvSizeBytes,
    csvSizeFormatted: formatFileSize(csvSizeBytes),
    records: effectiveRecords,
    summary: {
      totalRecords: effectiveRecords.length,
      totalDistanceMeters,
      avgHeartRate,
      avgPower,
      avgSpeedKmh
    },
    fileName,
    fileSizeFormatted: formatFileSize(effectiveSize)
  };
}
