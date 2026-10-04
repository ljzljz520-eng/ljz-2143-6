import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ASSET_DIR, id, now } from './store.js';

export const SAFE_PAYLOAD_KEYS = new Set([
  'fontMode', 'fontFamily', 'fallbackFamily', 'fontAssetIds', 'safeMargin',
  'backgroundColor', 'textColor', 'accentColor', 'photo', 'slides'
]);

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function checksum(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function httpError(status, message, details = undefined) {
  return Object.assign(new Error(message), { status, details });
}

export function requireBody(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
  if (missing.length) throw httpError(400, `Missing required fields: ${missing.join(', ')}`);
}

export function requireEvent(store, eventId) {
  const event = store.getById('events', eventId);
  if (!event) throw httpError(404, 'Event not found');
  return event;
}

export function assertActiveEvent(event) {
  if (event.status === 'archived') throw httpError(409, 'Event is archived and cannot be changed');
}

export function audit(store, { eventId = null, actor = 'anonymous', action, targetType, targetId = null, metadata = {} }) {
  const redacted = redactAuditMetadata(metadata);
  const row = {
    id: id('aud'), eventId, actor, action, targetType, targetId,
    metadata: redacted, createdAt: now()
  };
  store.insert('audits', row);
  return row;
}

export function redactAuditMetadata(value) {
  if (Array.isArray(value)) return value.map(redactAuditMetadata);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/dataurl|databody|photobody|binary|base64/i.test(key)) return [key, '[redacted]'];
      return [key, redactAuditMetadata(item)];
    }));
  }
  return value;
}

export function validateSlides(payload) {
  const slides = Array.isArray(payload.slides) ? payload.slides : [];
  if (!slides.length) throw httpError(400, 'At least one multilingual slide is required');
  const locales = new Set();
  return slides.map((slide, index) => {
    const prefix = `slides[${index}]`;
    if (!slide.locale) throw httpError(400, `${prefix}.locale is required`);
    if (locales.has(slide.locale)) throw httpError(400, `Duplicate locale ${slide.locale}`);
    locales.add(slide.locale);
    ['names', 'hallName', 'message'].forEach((field) => {
      if (typeof slide[field] !== 'string' || !slide[field].trim()) {
        throw httpError(400, `${prefix}.${field} is required`);
      }
      if (slide[field].length > 300) throw httpError(400, `${prefix}.${field} is too long`);
    });
    return {
      id: typeof slide.id === 'string' && /^sld_[A-Za-z0-9_-]{6,}$/.test(slide.id) ? slide.id : (slide.id || id('sld')),
      locale: String(slide.locale).slice(0, 35),
      names: slide.names,
      hallName: slide.hallName,
      message: slide.message
    };
  });
}

export function normalizePayload(input) {
  if (!input || typeof input !== 'object') throw httpError(400, 'Design payload is required');
  const photo = input.photo || {};
  const focusX = numberOrDefault(photo.focusX, 50, 0, 100);
  const focusY = numberOrDefault(photo.focusY, 50, 0, 100);
  const dim = numberOrDefault(photo.dim, 35, 0, 90);
  const captionX = numberOrDefault(photo.captionX, 50, 5, 95);
  const captionY = numberOrDefault(photo.captionY, 72, 5, 95);
  const safeMargin = numberOrDefault(input.safeMargin, 64, 0, 240);
  const fontAssetIds = Array.isArray(input.fontAssetIds)
    ? [...new Set(input.fontAssetIds.map(String).filter(Boolean))]
    : [];
  const fontMode = input.fontMode === 'fallback' ? 'fallback' : 'embedded';
  return {
    fontMode,
    fontFamily: String(input.fontFamily || 'VowDisplay Sans').slice(0, 120),
    fallbackFamily: String(input.fallbackFamily || 'system-ui, sans-serif').slice(0, 240),
    fontAssetIds,
    safeMargin,
    backgroundColor: normalizeColor(input.backgroundColor, '#101318'),
    textColor: normalizeColor(input.textColor, '#ffffff'),
    accentColor: normalizeColor(input.accentColor, '#d8b36f'),
    photo: { assetId: String(photo.assetId || ''), focusX, focusY, dim, captionX, captionY },
    slides: validateSlides(input)
  };
}

function numberOrDefault(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeColor(value, fallback) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return fallback;
  return value;
}

export function referencedAssetIds(payload) {
  const ids = new Set(payload.fontAssetIds || []);
  if (payload.photo?.assetId) ids.add(payload.photo.assetId);
  return [...ids];
}

export function assetDiskPath(asset) {
  return path.join(ASSET_DIR, `${asset.id}${asset.ext ? `.${asset.ext}` : ''}`);
}

export function resourceReadiness(store, eventId, payload) {
  const refs = referencedAssetIds(payload);
  const missing = [];
  const revoked = [];
  const unreadable = [];
  const wrongEvent = [];
  const assets = refs.map((assetId) => {
    const asset = store.getById('assets', assetId);
    if (!asset) {
      missing.push(assetId);
      return null;
    }
    if (asset.eventId !== eventId) wrongEvent.push(assetId);
    if (asset.status !== 'active') revoked.push(assetId);
    const file = assetDiskPath(asset);
    if (!fs.existsSync(file) || fs.statSync(file).size !== asset.size) unreadable.push(assetId);
    return asset;
  }).filter(Boolean);

  if (payload.fontMode === 'embedded' && !payload.fontAssetIds.length) {
    missing.push('embedded-font');
  }
  const ready = !missing.length && !revoked.length && !unreadable.length && !wrongEvent.length;
  return { ready, assetIds: refs, missing, revoked, unreadable, wrongEvent, checkedAt: now(), assets };
}

export function validateTypographyReport(payload, report) {
  if (!report || typeof report !== 'object') {
    throw httpError(400, 'Typography comparison report is required. Run browser preview checks first.');
  }
  if (payload.fontMode === 'embedded' && report.embeddedFontLoaded === false) {
    throw httpError(400, 'Embedded font package failed to load in browser preview');
  }
  if (report.payloadChecksum !== checksum(payload)) {
    throw httpError(409, 'Typography report is stale: design changed after preview check');
  }
  const modes = ['embedded', 'fallback'];
  for (const mode of modes) {
    const result = report[mode];
    if (!result || typeof result !== 'object') throw httpError(400, `Missing ${mode} typography result`);
    if (!Array.isArray(result.slides)) throw httpError(400, `${mode} report must contain slides`);
    if (result.slides.length !== payload.slides.length) {
      throw httpError(400, `${mode} report slide count does not match design`);
    }
  }
  const embedded = report.embedded;
  if (embedded.missingGlyphCount || embedded.overflow || embedded.safeAreaViolation) {
    throw httpError(400, 'Embedded font package does not pass glyph, line-wrap or safe-margin checks');
  }
  const differences = Array.isArray(report.differences) ? report.differences : [];
  if (differences.length && !report.acknowledgedFallback) {
    throw httpError(409, 'Embedded and on-site fallback rendering differ; acknowledgement is required before publish');
  }
  if (payload.fontMode === 'fallback' && report.fallback?.overflow) {
    throw httpError(400, 'Fallback font does not pass field screen safe-margin checks');
  }
  return { ...report, validatedAt: now() };
}

export function validateDeviceList(store, eventId, groupId, deviceIds) {
  if (!groupId) throw httpError(400, 'A screen group is required');
  const group = store.getById('screenGroups', groupId);
  if (!group || group.eventId !== eventId) throw httpError(404, 'Screen group not found in this event');
  if (!Array.isArray(deviceIds) || !deviceIds.length) throw httpError(400, 'An explicit device list is required');
  const unique = [...new Set(deviceIds)];
  const devices = unique.map((deviceId) => {
    const device = store.getById('devices', deviceId);
    if (!device || device.eventId !== eventId) throw httpError(400, `Device ${deviceId} is not bound to this event`);
    if (device.groupId !== groupId) throw httpError(400, `Device ${device.name} belongs to another hall/screen group`);
    if (device.status === 'retired') throw httpError(400, `Retired device ${device.name} cannot be a publish target`);
    return device;
  });
  return { group, devices };
}

export function activeReleaseFor(store, device) {
  if (!device.groupId) return null;
  const release = store.list('releases', (row) =>
    row.eventId === device.eventId &&
    row.groupId === device.groupId &&
    row.deviceIds.includes(device.id) &&
    ['active', 'rollback'].includes(row.status)
  ).sort((a, b) => Date.parse(b.publishedAt || b.createdAt) - Date.parse(a.publishedAt || a.createdAt))[0];
  return release || null;
}

export function releaseIsPlayable(store, release) {
  if (!release) return false;
  if (!release.versionId) return true; // blank safe screen
  const version = store.getById('versions', release.versionId);
  if (!version || version.eventId !== release.eventId) return false;
  const readiness = resourceReadiness(store, release.eventId, version.payload);
  return readiness.ready;
}

export function previousPlayableRelease(store, eventId, groupId, excludeReleaseId) {
  return store.list('releases', (row) =>
    row.eventId === eventId &&
    row.groupId === groupId &&
    row.id !== excludeReleaseId &&
    ['active', 'rollback', 'superseded'].includes(row.status)
  ).sort((a, b) => Date.parse(b.publishedAt || b.createdAt) - Date.parse(a.publishedAt || a.createdAt))
   .find((candidate) => releaseIsPlayable(store, candidate)) || null;
}

export function makeBlankPayload(reason) {
  return {
    fontMode: 'fallback',
    fontFamily: 'system-ui',
    fallbackFamily: 'system-ui, sans-serif',
    fontAssetIds: [],
    safeMargin: 64,
    backgroundColor: '#101318',
    textColor: '#ffffff',
    accentColor: '#d8b36f',
    photo: { assetId: '', focusX: 50, focusY: 50, dim: 35, captionX: 50, captionY: 72 },
    slides: [{
      id: id('sld'),
      locale: 'en',
      names: 'Welcome',
      hallName: 'Safe holding screen',
      message: reason || 'The approved presentation will resume shortly.'
    }]
  };
}

export function makeManifestHash(releaseId, versionId, assets) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ releaseId, versionId, assets: assets.map((asset) => ({ id: asset.id, sha256: asset.sha256, size: asset.size })).sort((a, b) => a.id.localeCompare(b.id)) }))
    .digest('hex');
}

export function isStale(lastSeenAt, milliseconds = 45000) {
  return !lastSeenAt || Date.now() - Date.parse(lastSeenAt) > milliseconds;
}

export function createDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function createRegistrationCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}
