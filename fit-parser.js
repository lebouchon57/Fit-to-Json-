/**
 * Pure Vanilla JS Garmin .FIT Binary Protocol Decoder & JSON Synthesizer
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
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 octet";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} Mo (${bytes.toLocaleString("fr-FR")} octets)`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Ko (${bytes.toLocaleString("fr-FR")} octets)`;
  return `${bytes} octets`;
}

export function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "00:00";
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatPace(secondsPerKm) {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0 || secondsPerKm > 3600) {
    return null;
  }
  const rounded = Math.round(secondsPerKm);
  const min = Math.floor(rounded / 60);
  const sec = rounded % 60;
  return `${min}:${String(sec).padStart(2, "0")} /km`;
}

function formatFitTimestamp(fitSeconds) {
  if (
    fitSeconds === null ||
    fitSeconds === undefined ||
    fitSeconds === 0xffffffff ||
    fitSeconds < 0x10000000
  ) {
    return "";
  }
  const date = new Date((fitSeconds + FIT_EPOCH_OFFSET_SEC) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function readSingleValue(view, offset, baseTypeNum, littleEndian) {
  const typeId = baseTypeNum & 0x1f;
  const size = BASE_TYPE_SIZES[typeId] || 1;
  if (offset + size > view.byteLength) return null;

  switch (typeId) {
    case 0:
    case 2: {
      const val = view.getUint8(offset);
      return val === 0xff ? null : val;
    }
    case 1: {
      const val = view.getInt8(offset);
      return val === 0x7f ? null : val;
    }
    case 3: {
      const val = view.getInt16(offset, littleEndian);
      return val === 0x7fff ? null : val;
    }
    case 4: {
      const val = view.getUint16(offset, littleEndian);
      return val === 0xffff ? null : val;
    }
    case 5: {
      const val = view.getInt32(offset, littleEndian);
      return val === 0x7fffffff ? null : val;
    }
    case 6: {
      const val = view.getUint32(offset, littleEndian);
      return val === 0xffffffff ? null : val;
    }
    case 8: {
      const val = view.getFloat32(offset, littleEndian);
      return Number.isNaN(val) ? null : val;
    }
    case 9: {
      const val = view.getFloat64(offset, littleEndian);
      return Number.isNaN(val) ? null : val;
    }
    case 10: {
      const val = view.getUint8(offset);
      return val === 0x00 ? null : val;
    }
    case 11: {
      const val = view.getUint16(offset, littleEndian);
      return val === 0x0000 ? null : val;
    }
    case 12: {
      const val = view.getUint32(offset, littleEndian);
      return val === 0x00000000 ? null : val;
    }
    default:
      return null;
  }
}

function readFieldValue(view, offset, size, baseTypeNum, littleEndian) {
  const typeId = baseTypeNum & 0x1f;
  if (typeId === 7) return null; // string not needed numerically
  const unitSize = BASE_TYPE_SIZES[typeId] || 1;
  if (offset + size > view.byteLength) return null;

  if (size === unitSize) {
    return readSingleValue(view, offset, baseTypeNum, littleEndian);
  }

  if (size > unitSize && size % unitSize === 0) {
    const count = size / unitSize;
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push(readSingleValue(view, offset + i * unitSize, baseTypeNum, littleEndian));
    }
    return arr;
  }

  return null;
}

function readDeveloperString(view, offset, size) {
  let out = "";
  const end = Math.min(offset + size, view.byteLength);
  for (let i = offset; i < end; i++) {
    const code = view.getUint8(i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeElevationFromRecords(records, thresholdMeters = 2.0) {
  let gain = 0;
  let loss = 0;
  let anchorAlt = null;

  for (const r of records) {
    if (r.altitudeMeters === null || !Number.isFinite(r.altitudeMeters)) continue;
    if (anchorAlt === null) {
      anchorAlt = r.altitudeMeters;
      continue;
    }
    const diff = r.altitudeMeters - anchorAlt;
    if (diff >= thresholdMeters) {
      gain += diff;
      anchorAlt = r.altitudeMeters;
    } else if (diff <= -thresholdMeters) {
      loss += Math.abs(diff);
      anchorAlt = r.altitudeMeters;
    }
  }

  return {
    gain: Math.round(gain),
    loss: Math.round(loss)
  };
}

function computeNormalizedPower(records) {
  const powers = records
    .map((r) => r.power)
    .filter((p) => p !== null && Number.isFinite(p) && p >= 0);

  if (powers.length < 30) return null;

  const rolling30s = [];
  let sum = 0;
  for (let i = 0; i < powers.length; i++) {
    sum += powers[i];
    if (i >= 30) sum -= powers[i - 30];
    if (i >= 29) {
      rolling30s.push(sum / 30);
    }
  }

  if (rolling30s.length === 0) return null;
  let fourthSum = 0;
  for (const avg of rolling30s) {
    fourthSum += Math.pow(avg, 4);
  }
  return Math.round(Math.pow(fourthSum / rolling30s.length, 0.25));
}

function normalizeRunningCadence(rawCadence, fractionalCadence = 0, sport = null) {
  if (rawCadence === null || !Number.isFinite(rawCadence) || rawCadence <= 0) return null;
  const val = rawCadence + (fractionalCadence || 0);
  // Garmin FIT stores running cadence as single-foot strides/min (typically 60-115 -> 120-230 spm)
  if (sport === 1 || val < 130) {
    return Math.round(val * 2);
  }
  return Math.round(val);
}

function decodeFitMessages(arrayBuffer) {
  const view = new DataView(arrayBuffer);

  const records = [];
  const laps = [];
  const sessions = [];
  const events = [];
  const timeInZones = [];
  const hrZoneBoundaries = [];
  let zonesTargetMaxHr = null;
  let zonesTargetThresholdHr = null;
  const devFieldMeta = new Map(); // `${devDataIndex}:${fieldDefNum}` -> { name, units }

  let offset = 0;

  while (offset + 14 <= view.byteLength) {
    const headerSize = view.getUint8(offset);
    if (headerSize < 12 || offset + headerSize > view.byteLength) break;

    const bytes = new Uint8Array(arrayBuffer, offset, 12);
    const hasMagic =
      bytes[8] === 0x2e &&
      bytes[9] === 0x46 &&
      bytes[10] === 0x49 &&
      bytes[11] === 0x54;
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

        cursor += 1; // reserved
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

        const devFields = [];
        if (hasDeveloperFields && cursor < dataEnd) {
          const numDevFields = view.getUint8(cursor);
          cursor += 1;
          for (let i = 0; i < numDevFields; i++) {
            if (cursor + 3 > dataEnd) break;
            devFields.push({
              fieldNum: view.getUint8(cursor),
              size: view.getUint8(cursor + 1),
              devDataIndex: view.getUint8(cursor + 2)
            });
            cursor += 3;
          }
        }

        definitions.set(localMesgNum, {
          globalMesgNum,
          littleEndian,
          fields,
          devFields
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
        if (!def) break;

        const targetMesg = def.globalMesgNum;
        const shouldDecode =
          targetMesg === 20 || // Record
          targetMesg === 19 || // Lap
          targetMesg === 18 || // Session
          targetMesg === 21 || // Event
          targetMesg === 7 ||  // ZonesTarget
          targetMesg === 8 ||  // HrZone
          targetMesg === 216 || // TimeInZone
          targetMesg === 206; // FieldDescription

        const fieldValues = {};
        const stringValues = {};
        let aborted = false;

        for (const field of def.fields) {
          if (cursor + field.size > dataEnd) {
            aborted = true;
            break;
          }
          if (shouldDecode) {
            if (targetMesg === 206 && (field.fieldDefNum === 3 || field.fieldDefNum === 8)) {
              stringValues[field.fieldDefNum] = readDeveloperString(view, cursor, field.size);
            } else {
              const val = readFieldValue(
                view,
                cursor,
                field.size,
                field.baseType,
                def.littleEndian
              );
              if (val !== null) {
                fieldValues[field.fieldDefNum] = val;
              }
            }
          }
          cursor += field.size;
        }

        if (aborted) break;

        const devValues = {};
        for (const df of def.devFields) {
          if (cursor + df.size > dataEnd) {
            aborted = true;
            break;
          }
          if (targetMesg === 18 && df.size <= 4) {
            const meta = devFieldMeta.get(`${df.devDataIndex}:${df.fieldNum}`);
            if (meta) {
              const baseGuess = df.size === 4 ? 8 : df.size === 2 ? 4 : 2;
              const numVal = readSingleValue(view, cursor, baseGuess, def.littleEndian);
              if (numVal !== null) {
                devValues[meta.name.toLowerCase()] = numVal;
              }
            }
          }
          cursor += df.size;
        }

        if (aborted) break;

        if (typeof fieldValues[253] === "number") {
          lastTimestamp = fieldValues[253];
        } else if (isCompressedTs && lastTimestamp > 0) {
          fieldValues[253] = lastTimestamp;
        }

        if (targetMesg === 206) {
          const devIdx = fieldValues[0];
          const fieldDef = fieldValues[1];
          const name = stringValues[3] || "";
          if (devIdx !== undefined && fieldDef !== undefined && name) {
            devFieldMeta.set(`${devIdx}:${fieldDef}`, {
              name,
              units: stringValues[8] || ""
            });
          }
        } else if (targetMesg === 7) {
          if (typeof fieldValues[1] === "number") zonesTargetMaxHr = fieldValues[1];
          if (typeof fieldValues[2] === "number") zonesTargetThresholdHr = fieldValues[2];
        } else if (targetMesg === 8) {
          if (typeof fieldValues[1] === "number") hrZoneBoundaries.push(fieldValues[1]);
        } else if (targetMesg === 216) {
          const refMesg = fieldValues[0];
          const timeArr = Array.isArray(fieldValues[2]) ? fieldValues[2] : null;
          const boundaryArr = Array.isArray(fieldValues[6]) ? fieldValues[6] : null;
          if (timeArr) {
            timeInZones.push({
              referenceMesg: refMesg,
              timesSec: timeArr.map((v) => (typeof v === "number" ? v / 1000.0 : 0)),
              boundaries: boundaryArr
            });
          }
        } else if (targetMesg === 21) {
          events.push({
            timestampSec: typeof fieldValues[253] === "number" ? fieldValues[253] : null,
            event: fieldValues[0] ?? null,
            eventType: fieldValues[1] ?? null,
            data: typeof fieldValues[3] === "number" ? fieldValues[3] : null
          });
        } else if (targetMesg === 20) {
          const latRaw = typeof fieldValues[0] === "number" ? fieldValues[0] : null;
          const lonRaw = typeof fieldValues[1] === "number" ? fieldValues[1] : null;
          const altRaw =
            typeof fieldValues[78] === "number"
              ? fieldValues[78]
              : typeof fieldValues[2] === "number"
                ? fieldValues[2]
                : null;
          const speedRaw =
            typeof fieldValues[73] === "number"
              ? fieldValues[73]
              : typeof fieldValues[6] === "number"
                ? fieldValues[6]
                : null;
          const distRaw = typeof fieldValues[5] === "number" ? fieldValues[5] : null;
          const cadRaw = typeof fieldValues[4] === "number" ? fieldValues[4] : null;
          const fracCad =
            typeof fieldValues[53] === "number" ? fieldValues[53] / 128.0 : 0;

          records.push({
            timestampSec: typeof fieldValues[253] === "number" ? fieldValues[253] : null,
            timestamp: formatFitTimestamp(fieldValues[253]),
            latitude: latRaw !== null && latRaw !== 0 ? latRaw * SEMICIRCLE_TO_DEGREE : null,
            longitude: lonRaw !== null && lonRaw !== 0 ? lonRaw * SEMICIRCLE_TO_DEGREE : null,
            distanceMeters: distRaw !== null ? distRaw / 100.0 : null,
            altitudeMeters: altRaw !== null ? altRaw / 5.0 - 500.0 : null,
            speedMs: speedRaw !== null ? speedRaw / 1000.0 : null,
            heartRate: typeof fieldValues[3] === "number" ? fieldValues[3] : null,
            cadenceRaw: cadRaw,
            fractionalCadence: fracCad,
            power: typeof fieldValues[7] === "number" ? fieldValues[7] : null
          });
        } else if (targetMesg === 19) {
          const elapsedRaw = typeof fieldValues[7] === "number" ? fieldValues[7] : null;
          const timerRaw = typeof fieldValues[8] === "number" ? fieldValues[8] : null;
          const distRaw = typeof fieldValues[9] === "number" ? fieldValues[9] : null;
          const speedRaw =
            typeof fieldValues[110] === "number"
              ? fieldValues[110]
              : typeof fieldValues[13] === "number"
                ? fieldValues[13]
                : null;

          laps.push({
            timestampSec: typeof fieldValues[253] === "number" ? fieldValues[253] : null,
            startTimeSec: typeof fieldValues[2] === "number" ? fieldValues[2] : null,
            totalElapsedSec: elapsedRaw !== null ? elapsedRaw / 1000.0 : null,
            totalTimerSec: timerRaw !== null ? timerRaw / 1000.0 : null,
            distanceMeters: distRaw !== null ? distRaw / 100.0 : null,
            calories: typeof fieldValues[11] === "number" ? fieldValues[11] : null,
            avgSpeedMs: speedRaw !== null ? speedRaw / 1000.0 : null,
            avgHeartRate: typeof fieldValues[15] === "number" ? fieldValues[15] : null,
            maxHeartRate: typeof fieldValues[16] === "number" ? fieldValues[16] : null,
            avgCadenceRaw: typeof fieldValues[17] === "number" ? fieldValues[17] : null,
            avgPower: typeof fieldValues[19] === "number" ? fieldValues[19] : null,
            totalAscent: typeof fieldValues[21] === "number" ? fieldValues[21] : null,
            totalDescent: typeof fieldValues[22] === "number" ? fieldValues[22] : null,
            intensity: typeof fieldValues[23] === "number" ? fieldValues[23] : null
          });
        } else if (targetMesg === 18) {
          const elapsedRaw = typeof fieldValues[7] === "number" ? fieldValues[7] : null;
          const timerRaw = typeof fieldValues[8] === "number" ? fieldValues[8] : null;
          const distRaw = typeof fieldValues[9] === "number" ? fieldValues[9] : null;
          const speedRaw =
            typeof fieldValues[124] === "number"
              ? fieldValues[124]
              : typeof fieldValues[14] === "number"
                ? fieldValues[14]
                : null;

          sessions.push({
            timestampSec: typeof fieldValues[253] === "number" ? fieldValues[253] : null,
            startTimeSec: typeof fieldValues[2] === "number" ? fieldValues[2] : null,
            sport: typeof fieldValues[5] === "number" ? fieldValues[5] : null,
            subSport: typeof fieldValues[6] === "number" ? fieldValues[6] : null,
            totalElapsedSec: elapsedRaw !== null ? elapsedRaw / 1000.0 : null,
            totalTimerSec: timerRaw !== null ? timerRaw / 1000.0 : null,
            distanceMeters: distRaw !== null ? distRaw / 100.0 : null,
            calories: typeof fieldValues[11] === "number" ? fieldValues[11] : null,
            avgSpeedMs: speedRaw !== null ? speedRaw / 1000.0 : null,
            avgHeartRate: typeof fieldValues[16] === "number" ? fieldValues[16] : null,
            maxHeartRate: typeof fieldValues[17] === "number" ? fieldValues[17] : null,
            avgCadenceRaw: typeof fieldValues[18] === "number" ? fieldValues[18] : null,
            avgPower: typeof fieldValues[20] === "number" ? fieldValues[20] : null,
            maxPower: typeof fieldValues[21] === "number" ? fieldValues[21] : null,
            totalAscent: typeof fieldValues[22] === "number" ? fieldValues[22] : null,
            totalDescent: typeof fieldValues[23] === "number" ? fieldValues[23] : null,
            totalTrainingEffect:
              typeof fieldValues[24] === "number" ? Number((fieldValues[24] / 10.0).toFixed(1)) : null,
            totalAnaerobicTrainingEffect:
              typeof fieldValues[137] === "number" ? Number((fieldValues[137] / 10.0).toFixed(1)) : null,
            normalizedPower: typeof fieldValues[34] === "number" ? fieldValues[34] : null,
            trainingLoadPeak: typeof fieldValues[168] === "number" ? fieldValues[168] : null,
            devValues
          });
        }
      }
    }

    offset = dataEnd + 2;
  }

  return {
    records,
    laps,
    sessions,
    events,
    timeInZones,
    hrZoneBoundaries,
    zonesTargetMaxHr,
    zonesTargetThresholdHr
  };
}

function buildHrZones(decoded, session) {
  const zoneLabels = [
    { key: "Z1", label: "Z1 · Récupération (<60%)" },
    { key: "Z2", label: "Z2 · Endurance (60-70%)" },
    { key: "Z3", label: "Z3 · Tempo (70-80%)" },
    { key: "Z4", label: "Z4 · Seuil (80-90%)" },
    { key: "Z5", label: "Z5 · Anaérobie (>90%)" }
  ];

  // Prefer native TimeInZone (global 216) for Session if present with 5+ zones
  const sessionZone = decoded.timeInZones.find(
    (tz) => (tz.referenceMesg === 18 || tz.referenceMesg === undefined) && tz.timesSec.length >= 5
  );

  let secondsPerZone = [0, 0, 0, 0, 0];

  if (sessionZone && sessionZone.timesSec.slice(0, 5).some((s) => s > 0)) {
    // Note: Garmin TimeInZone index 0 is sometimes below Z1, or Z1..Z5 depending on array length
    const arr = sessionZone.timesSec;
    if (arr.length >= 6) {
      secondsPerZone = [arr[1], arr[2], arr[3], arr[4], arr[5]];
    } else {
      secondsPerZone = arr.slice(0, 5);
    }
  } else {
    // Compute directly from Record heart_rate & timestamps
    const hrValues = decoded.records
      .map((r) => r.heartRate)
      .filter((hr) => hr !== null && hr > 30);

    const maxRecordHr = hrValues.length > 0 ? Math.max(...hrValues) : 0;
    const fcMax =
      decoded.zonesTargetMaxHr ||
      Math.max(session?.maxHeartRate || 0, maxRecordHr, 185);

    const validBoundaries = decoded.hrZoneBoundaries.filter((b) => b > 40 && b < 240);
    const bounds =
      validBoundaries.length >= 4
        ? [
            validBoundaries[0],
            validBoundaries[1],
            validBoundaries[2],
            validBoundaries[3]
          ]
        : [
            Math.round(fcMax * 0.6),
            Math.round(fcMax * 0.7),
            Math.round(fcMax * 0.8),
            Math.round(fcMax * 0.9)
          ];

    for (let i = 0; i < decoded.records.length; i++) {
      const rec = decoded.records[i];
      if (rec.heartRate === null || rec.heartRate <= 30) continue;

      let dt = 1;
      if (i > 0 && rec.timestampSec !== null && decoded.records[i - 1].timestampSec !== null) {
        const diff = rec.timestampSec - decoded.records[i - 1].timestampSec;
        if (diff > 0 && diff <= 15) dt = diff;
        else if (diff > 15) dt = 1;
        else if (diff === 0) dt = 0;
      }

      if (rec.heartRate < bounds[0]) secondsPerZone[0] += dt;
      else if (rec.heartRate < bounds[1]) secondsPerZone[1] += dt;
      else if (rec.heartRate < bounds[2]) secondsPerZone[2] += dt;
      else if (rec.heartRate < bounds[3]) secondsPerZone[3] += dt;
      else secondsPerZone[4] += dt;
    }
  }

  const roundedSecs = secondsPerZone.map((s) => Math.round(s));
  const totalZoneSec = roundedSecs.reduce((acc, v) => acc + v, 0);

  const zones = {};
  for (let i = 0; i < 5; i++) {
    const sec = roundedSecs[i];
    const pct = totalZoneSec > 0 ? Number(((sec / totalZoneSec) * 100).toFixed(1)) : 0;
    zones[zoneLabels[i].key] = {
      label: zoneLabels[i].label,
      seconds: sec,
      percent: pct
    };
  }

  return zones;
}

function buildRunningSplits(decoded, sport) {
  const records = decoded.records;
  if (records.length === 0) return [];

  // Ensure each record has cumulative distance
  let cumulativeDist = 0;
  let prevLat = null;
  let prevLon = null;
  const enriched = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let dist = r.distanceMeters;
    if (dist === null) {
      if (r.latitude !== null && r.longitude !== null && prevLat !== null && prevLon !== null) {
        cumulativeDist += haversineMeters(prevLat, prevLon, r.latitude, r.longitude);
      }
      dist = cumulativeDist;
    } else {
      cumulativeDist = dist;
    }
    if (r.latitude !== null && r.longitude !== null) {
      prevLat = r.latitude;
      prevLon = r.longitude;
    }

    let dt = 1;
    if (i > 0 && r.timestampSec !== null && records[i - 1].timestampSec !== null) {
      const diff = r.timestampSec - records[i - 1].timestampSec;
      dt = diff >= 0 && diff <= 30 ? diff : 1;
    }

    enriched.push({
      ...r,
      cumDist: dist,
      dt
    });
  }

  const totalDist = enriched.length > 0 ? enriched[enriched.length - 1].cumDist : 0;
  if (totalDist < 50) return [];

  const splits = [];
  let currentKmIndex = 1;
  let bucketRecords = [];
  let splitStartDist = 0;

  const finalizeSplit = (kmNum, items, endDist) => {
    const distCovered = Math.max(0, endDist - splitStartDist);
    if (distCovered < 25 || items.length === 0) return;

    const durationSec = items.reduce((sum, item) => sum + item.dt, 0);
    const hrs = items.map((x) => x.heartRate).filter((v) => v !== null && v > 0);
    const cads = items
      .map((x) => normalizeRunningCadence(x.cadenceRaw, x.fractionalCadence, sport))
      .filter((v) => v !== null && v > 0);
    const elev = computeElevationFromRecords(items, 1.5);

    const paceSecPerKm = distCovered > 0 && durationSec > 0 ? durationSec / (distCovered / 1000) : null;

    splits.push({
      km: kmNum,
      distance_m: Math.round(distCovered),
      duration_s: Math.round(durationSec),
      avg_pace: formatPace(paceSecPerKm) || "N/A",
      avg_heart_rate_bpm: hrs.length > 0 ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
      avg_cadence_spm: cads.length > 0 ? Math.round(cads.reduce((a, b) => a + b, 0) / cads.length) : null,
      elevation_gain_m: elev.gain
    });
  };

  for (const item of enriched) {
    bucketRecords.push(item);
    const threshold = currentKmIndex * 1000;
    if (item.cumDist >= threshold) {
      finalizeSplit(currentKmIndex, bucketRecords, threshold);
      splitStartDist = threshold;
      currentKmIndex += 1;
      bucketRecords = [item];
    }
  }

  if (bucketRecords.length > 1 && totalDist - splitStartDist >= 50) {
    finalizeSplit(currentKmIndex, bucketRecords, totalDist);
  }

  return splits;
}

function buildDownsampledGpsTrack(records) {
  const gpsPoints = records.filter(
    (r) =>
      r.latitude !== null &&
      r.longitude !== null &&
      Number.isFinite(r.latitude) &&
      Number.isFinite(r.longitude)
  );

  if (gpsPoints.length === 0) return [];

  const track = [];
  let lastKeptTs = null;

  for (let i = 0; i < gpsPoints.length; i++) {
    const pt = gpsPoints[i];
    const hasTs = pt.timestampSec !== null;

    if (track.length === 0) {
      track.push({
        lat: Number(pt.latitude.toFixed(5)),
        lon: Number(pt.longitude.toFixed(5)),
        alt: pt.altitudeMeters !== null ? Number(pt.altitudeMeters.toFixed(1)) : null
      });
      lastKeptTs = hasTs ? pt.timestampSec : i;
      continue;
    }

    const elapsed = hasTs && lastKeptTs !== null ? pt.timestampSec - lastKeptTs : i - lastKeptTs;
    // Strictly downsample to at least 30 seconds between points (or 30 samples fallback if no timestamps)
    if (elapsed >= 30) {
      track.push({
        lat: Number(pt.latitude.toFixed(5)),
        lon: Number(pt.longitude.toFixed(5)),
        alt: pt.altitudeMeters !== null ? Number(pt.altitudeMeters.toFixed(1)) : null
      });
      lastKeptTs = hasTs ? pt.timestampSec : i;
    }
  }

  return track;
}

function computeHeartRateRecovery(decoded) {
  // Check Garmin recovery_hr Event (event = 38)
  const recoveryEvent = decoded.events.find((ev) => ev.event === 38 && ev.data !== null);
  const records = decoded.records.filter((r) => r.heartRate !== null && r.timestampSec !== null);

  let drop1Min = null;
  let drop2Min = null;

  // Attempt to locate end of last active effort (cooldown / rest lap start, or last active lap end)
  const activeLaps = decoded.laps.filter((l) => l.intensity === 0 || l.intensity === 5 || l.intensity === null);
  const lastActiveLap = activeLaps.length > 0 ? activeLaps[activeLaps.length - 1] : null;
  const effortEndTs = lastActiveLap?.timestampSec ?? null;

  if (effortEndTs !== null && records.length > 0) {
    // Find reference HR near effortEndTs
    let endRec = null;
    let minDiff = Infinity;
    for (const r of records) {
      const diff = Math.abs(r.timestampSec - effortEndTs);
      if (diff < minDiff && diff <= 15) {
        minDiff = diff;
        endRec = r;
      }
    }

    if (endRec) {
      const target1 = effortEndTs + 60;
      const target2 = effortEndTs + 120;
      let rec1 = null;
      let rec2 = null;
      let best1 = Infinity;
      let best2 = Infinity;

      for (const r of records) {
        const d1 = Math.abs(r.timestampSec - target1);
        if (d1 < best1 && d1 <= 15) {
          best1 = d1;
          rec1 = r;
        }
        const d2 = Math.abs(r.timestampSec - target2);
        if (d2 < best2 && d2 <= 15) {
          best2 = d2;
          rec2 = r;
        }
      }

      if (rec1) drop1Min = Math.max(0, endRec.heartRate - rec1.heartRate);
      if (rec2) drop2Min = Math.max(0, endRec.heartRate - rec2.heartRate);
    }
  }

  if (drop1Min === null && drop2Min === null && !recoveryEvent) {
    return null;
  }

  return {
    drop_1min_bpm: drop1Min,
    drop_2min_bpm: drop2Min,
    event_recovery_bpm: recoveryEvent ? recoveryEvent.data : null
  };
}

function buildStrengthIntervals(decoded) {
  const laps = decoded.laps;
  if (laps.length === 0) return [];

  const intervals = [];
  let setNumber = 1;

  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    const isRestLap = lap.intensity === 1 || lap.intensity === 4;

    if (isRestLap) {
      // Attach rest duration to previous active interval if not already set
      if (intervals.length > 0 && intervals[intervals.length - 1].rest_duration_s === 0) {
        const restSec = lap.totalTimerSec ?? lap.totalElapsedSec ?? 0;
        intervals[intervals.length - 1].rest_duration_s = Math.round(restSec);
      }
      continue;
    }

    const effortSec = lap.totalTimerSec ?? lap.totalElapsedSec ?? 0;
    let restSec = 0;

    // Look ahead for an explicit rest/recovery lap
    const nextLap = laps[i + 1];
    if (nextLap && (nextLap.intensity === 1 || nextLap.intensity === 4)) {
      restSec = nextLap.totalTimerSec ?? nextLap.totalElapsedSec ?? 0;
    } else if (nextLap && lap.timestampSec !== null && nextLap.startTimeSec !== null) {
      // Otherwise check timer pause gap between this lap end and next lap start
      const gap = nextLap.startTimeSec - lap.timestampSec;
      if (gap > 2 && gap < 3600) {
        restSec = gap;
      }
    }

    // Fallback HR from records inside lap timeframe if Lap message didn't store avg/max HR
    let avgHr = lap.avgHeartRate;
    let maxHr = lap.maxHeartRate;
    if ((avgHr === null || maxHr === null) && lap.startTimeSec !== null && lap.timestampSec !== null) {
      const lapHrs = decoded.records
        .filter(
          (r) =>
            r.heartRate !== null &&
            r.timestampSec !== null &&
            r.timestampSec >= lap.startTimeSec &&
            r.timestampSec <= lap.timestampSec
        )
        .map((r) => r.heartRate);
      if (lapHrs.length > 0) {
        if (avgHr === null) {
          avgHr = Math.round(lapHrs.reduce((a, b) => a + b, 0) / lapHrs.length);
        }
        if (maxHr === null) {
          maxHr = Math.max(...lapHrs);
        }
      }
    }

    intervals.push({
      set_number: setNumber++,
      effort_duration_s: Math.round(effortSec),
      rest_duration_s: Math.round(restSec),
      avg_heart_rate_bpm: avgHr,
      max_heart_rate_bpm: maxHr
    });
  }

  return intervals;
}

export function parseFitToJson(arrayBuffer, fileName = "activity.fit", profile = "running_trail") {
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    throw new Error("Le fichier .FIT est vide (0 octet).");
  }

  if (!isValidFitBuffer(arrayBuffer)) {
    throw new Error("Signature .FIT invalide : ce fichier ne respecte pas le protocole Garmin FIT.");
  }

  const decoded = decodeFitMessages(arrayBuffer);
  if (decoded.records.length === 0 && decoded.laps.length === 0 && decoded.sessions.length === 0) {
    throw new Error("Aucune donnée d'activité (Record, Lap ou Session) trouvée dans ce fichier .FIT.");
  }

  const session = decoded.sessions[decoded.sessions.length - 1] || null;
  const sport = session?.sport ?? null;
  const records = decoded.records;

  const hrList = records.map((r) => r.heartRate).filter((v) => v !== null && v > 0);
  const powerList = records.map((r) => r.power).filter((v) => v !== null && v >= 0);

  const avgHr =
    session?.avgHeartRate ??
    (hrList.length > 0 ? Math.round(hrList.reduce((a, b) => a + b, 0) / hrList.length) : null);
  const maxHr =
    session?.maxHeartRate ??
    (hrList.length > 0 ? Math.max(...hrList) : null);

  let durationSec = session?.totalTimerSec ?? session?.totalElapsedSec ?? null;
  if (durationSec === null && decoded.laps.length > 0) {
    durationSec = decoded.laps.reduce((acc, l) => acc + (l.totalTimerSec ?? l.totalElapsedSec ?? 0), 0);
  }
  if (durationSec === null && records.length > 1) {
    const firstTs = records.find((r) => r.timestampSec !== null)?.timestampSec;
    const lastTs = [...records].reverse().find((r) => r.timestampSec !== null)?.timestampSec;
    if (firstTs !== undefined && lastTs !== undefined && lastTs >= firstTs) {
      durationSec = lastTs - firstTs;
    } else {
      durationSec = records.length;
    }
  }
  durationSec = Math.round(durationSec || 0);

  const hrZones = buildHrZones(decoded, session);
  const startTimeIso =
    (session?.startTimeSec ? formatFitTimestamp(session.startTimeSec) : "") ||
    records.find((r) => r.timestamp)?.timestamp ||
    null;

  let jsonPayload;

  if (profile === "strength_cardio") {
    const activeCalories =
      session?.calories ??
      (decoded.laps.some((l) => l.calories !== null)
        ? decoded.laps.reduce((acc, l) => acc + (l.calories || 0), 0)
        : null);

    const hrRecovery = computeHeartRateRecovery(decoded);
    const epocDevKey = session?.devValues
      ? Object.keys(session.devValues).find((k) => k.includes("epoc"))
      : null;
    const epocValue =
      (epocDevKey ? session.devValues[epocDevKey] : null) ??
      session?.trainingLoadPeak ??
      null;

    const intervals = buildStrengthIntervals(decoded);

    jsonPayload = {
      profile: "strength_cardio",
      profile_label: "Renforcement / Cardio",
      source_file: fileName,
      start_time: startTimeIso,
      global_stats: {
        total_duration_s: durationSec,
        total_duration_formatted: formatDuration(durationSec),
        active_calories_kcal: activeCalories,
        avg_heart_rate_bpm: avgHr,
        max_heart_rate_bpm: maxHr,
        hr_recovery: hrRecovery,
        training_effect: {
          aerobic: session?.totalTrainingEffect ?? null,
          anaerobic: session?.totalAnaerobicTrainingEffect ?? null,
          epoc_load: epocValue
        }
      },
      hr_zones: hrZones,
      intervals
    };
  } else {
    // Course à pied / Trail
    const distMeters =
      session?.distanceMeters ??
      (() => {
        const dists = records.map((r) => r.distanceMeters).filter((v) => v !== null);
        return dists.length > 0 ? dists[dists.length - 1] : 0;
      })();

    const computedElev = computeElevationFromRecords(records, 2.0);
    const elevationGain = session?.totalAscent ?? computedElev.gain;
    const elevationLoss = session?.totalDescent ?? computedElev.loss;

    const avgPower =
      session?.avgPower ??
      (powerList.length > 0 ? Math.round(powerList.reduce((a, b) => a + b, 0) / powerList.length) : null);
    const normalizedPower = session?.normalizedPower ?? computeNormalizedPower(records);

    const cadList = records
      .map((r) => normalizeRunningCadence(r.cadenceRaw, r.fractionalCadence, sport ?? 1))
      .filter((v) => v !== null && v > 0);
    const avgCadence =
      normalizeRunningCadence(session?.avgCadenceRaw ?? null, 0, sport ?? 1) ??
      (cadList.length > 0 ? Math.round(cadList.reduce((a, b) => a + b, 0) / cadList.length) : null);

    const splits = buildRunningSplits(decoded, sport ?? 1);
    const gpsTrack = buildDownsampledGpsTrack(records);

    jsonPayload = {
      profile: "running_trail",
      profile_label: "Course à pied / Trail",
      source_file: fileName,
      start_time: startTimeIso,
      global_stats: {
        total_distance_km: Number((distMeters / 1000).toFixed(2)),
        total_duration_s: durationSec,
        total_duration_formatted: formatDuration(durationSec),
        elevation_gain_m: elevationGain,
        elevation_loss_m: elevationLoss,
        avg_heart_rate_bpm: avgHr,
        max_heart_rate_bpm: maxHr,
        avg_power_w: avgPower,
        normalized_power_w: normalizedPower,
        avg_cadence_spm: avgCadence
      },
      hr_zones: hrZones,
      splits,
      gps_track: gpsTrack
    };
  }

  const jsonContent = JSON.stringify(jsonPayload, null, 2);
  const jsonSizeBytes = new TextEncoder().encode(jsonContent).length;

  return {
    profile,
    jsonPayload,
    jsonContent,
    jsonSizeBytes,
    jsonSizeFormatted: formatFileSize(jsonSizeBytes),
    rawRecordCount: records.length,
    rawLapCount: decoded.laps.length,
    fileName
  };
}
