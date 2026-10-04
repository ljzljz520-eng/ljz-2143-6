import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, id, now, sha256, ASSET_DIR, DATA_DIR } from './store.js';
import {
  activeReleaseFor, assetDiskPath, audit, canonicalJson, checksum, createDeviceToken,
  createRegistrationCode, httpError, isStale, makeBlankPayload, makeManifestHash,
  normalizePayload, previousPlayableRelease, referencedAssetIds, releaseIsPlayable,
  requireBody, requireEvent, resourceReadiness, validateDeviceList, validateTypographyReport,
  assertActiveEvent
} from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const PORT = Number(process.env.PORT || 8080);
const store = new JsonStore();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8'
};

const ASSET_MIME = {
  photo: { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' },
  font: {
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    'x-font-ttf': 'font/ttf', 'x-font-otf': 'font/otf', 'vnd.ms-opentype': 'font/otf',
    'application/font-ttf': 'font/ttf', 'application/font-otf': 'font/otf',
    octet: 'application/octet-stream'
  }
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...(Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers
  });
  res.end(payload);
}

function readJson(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) reject(httpError(413, 'Request body is too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return { url, path: url.pathname.replace(/\/+$/, '') || '/', query: url.searchParams };
}

const routes = [];
function route(method, pattern, handler, options = {}) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  })}$`);
  routes.push({ method, regex, names, handler, device: options.device || false });
}

async function router(req, res) {
  const { path, query } = parseUrl(req);
  if (req.method === 'GET' && (path === '/' || path.startsWith('/admin'))) {
    return serveStatic('/admin.html')(req, res);
  }
  if (req.method === 'GET' && path === '/display') return serveStatic('/display.html')(req, res);
  if (req.method === 'GET' && path.startsWith('/assets/') && query.get('token')) {
    return Promise.resolve(serveAuthorizedAsset(path.split('/').pop(), query.get('token'), query.get('type'))(req, res))
      .catch((error) => send(res, error.status || 500, { error: error.message }));
  }
  if (req.method === 'GET' && path.startsWith('/static/')) {
    return serveStatic(`/${path.slice('/static/'.length)}`)(req, res);
  }

  const match = routes.find((candidate) => candidate.method === req.method && candidate.regex.test(path));
  if (!match) return send(res, 404, { error: 'Not found' });
  const params = Object.fromEntries(match.names.map((name, index) => [name, path.match(match.regex)[index + 1]]));
  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
    const actor = req.headers['x-actor'] ? String(req.headers['x-actor']).slice(0, 120) : 'web-admin';
    const auth = { actor };
    if (match.device) {
      auth.device = authenticateDevice(req);
    } else if (req.headers.authorization) {
      auth.adminToken = String(req.headers.authorization).replace(/^Bearer\s+/i, '');
    }
    await match.handler({ req, res, body, params, query, auth });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    send(res, status, { error: error.message || 'Internal error', details: error.details });
  }
}

function serveStatic(fileName) {
  const resolved = path.resolve(PUBLIC_DIR, `.${fileName}`);
  if (!resolved.startsWith(PUBLIC_DIR)) throw httpError(403, 'Forbidden');
  if (!fs.existsSync(resolved)) throw httpError(404, 'Static file not found');
  const data = fs.readFileSync(resolved);
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  };
}

function authenticateDevice(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const device = store.list('devices').find((row) => row.token === token);
  if (!device) throw httpError(401, 'Invalid device token');
  store.update('devices', device.id, { lastSeenAt: now(), networkStatus: 'online' });
  return store.getById('devices', device.id);
}

function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!match) throw httpError(400, 'Asset must be a data URL');
  const mime = match[1] || 'application/octet-stream';
  const raw = match[3];
  const buffer = match[2] ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw));
  return { mime, buffer };
}

function extensionFromMime(mime) {
  return (mime.split(';')[0].split('/')[1] || 'bin').split('+')[0].toLowerCase();
}

function inferFontExtension(filename, buffer, mimeExt) {
  const fromName = path.extname(filename).slice(1).toLowerCase();
  if (['woff', 'woff2', 'ttf', 'otf'].includes(fromName)) return fromName;
  if (['woff', 'woff2', 'ttf', 'otf'].includes(mimeExt)) return mimeExt;
  if (buffer.subarray(0, 4).toString('ascii') === 'wOF2') return 'woff2';
  if (buffer.subarray(0, 4).toString('ascii') === 'wOFF') return 'woff';
  const tag = buffer.subarray(0, 4).toString('ascii');
  if (['OTTO', 'true', 'typ1'].includes(tag) || tag === '\x00\x01\x00\x00') return tag === 'OTTO' ? 'otf' : 'ttf';
  throw httpError(415, 'Cannot identify font file type');
}

route('POST', '/api/events', async ({ res, body, auth }) => {
  requireBody(body, ['name', 'coupleName']);
  const event = store.insert('events', {
    id: id('evt'), name: body.name, coupleName: body.coupleName,
    defaultLocale: body.defaultLocale || 'zh-CN', status: 'active',
    retentionDays: Number(body.retentionDays) || 30, createdAt: now(), updatedAt: now()
  });
  audit(store, { actor: auth.actor, action: 'event.create', targetType: 'event', targetId: event.id, eventId: event.id });
  send(res, 201, event);
});

route('GET', '/api/events', async ({ res }) => send(res, 200, store.list('events')));
route('GET', '/api/events/:eventId', async ({ res, params }) => send(res, 200, requireEvent(store, params.eventId)));

route('POST', '/api/events/:eventId/groups', async ({ res, body, params, auth }) => {
  const event = requireEvent(store, params.eventId); assertActiveEvent(event); requireBody(body, ['name', 'hallName']);
  const group = store.insert('screenGroups', {
    id: id('grp'), eventId: event.id, name: body.name, hallName: body.hallName,
    createdAt: now(), updatedAt: now()
  });
  audit(store, { eventId: event.id, actor: auth.actor, action: 'group.create', targetType: 'screenGroup', targetId: group.id, metadata: { hallName: group.hallName } });
  send(res, 201, group);
});

route('GET', '/api/events/:eventId/groups', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('screenGroups', (row) => row.eventId === params.eventId));
});

route('POST', '/api/events/:eventId/devices', async ({ res, body, params, auth }) => {
  const event = requireEvent(store, params.eventId); assertActiveEvent(event);
  requireBody(body, ['name', 'groupId']);
  const group = store.getById('screenGroups', body.groupId);
  if (!group || group.eventId !== event.id) throw httpError(404, 'Screen group not found in this event');
  const device = store.insert('devices', {
    id: id('dev'), eventId: event.id, groupId: group.id, name: body.name,
    token: createDeviceToken(), registrationCode: createRegistrationCode(),
    status: 'provisioned', networkStatus: 'unknown', lastSeenAt: null,
    currentManifestHash: null, currentReleaseId: null, desiredManifestHash: null,
    pendingPurge: false, purgeAcknowledgedAt: null, purgeScope: null,
    registeredAt: null, createdAt: now(), updatedAt: now()
  });
  audit(store, { eventId: event.id, actor: auth.actor, action: 'device.create', targetType: 'device', targetId: device.id, metadata: { groupId: group.id, name: device.name } });
  send(res, 201, device);
});

route('GET', '/api/events/:eventId/devices', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('devices', (row) => row.eventId === params.eventId).map(maskDevice));
});

route('POST', '/api/devices/register', async ({ res, body, auth }) => {
  requireBody(body, ['registrationCode']);
  const code = String(body.registrationCode).toUpperCase();
  const device = store.find('devices', (row) => row.registrationCode === code);
  if (!device) throw httpError(404, 'Registration code does not match any provisioned device');
  if (device.status === 'retired') throw httpError(409, 'Device has been retired');
  const event = requireEvent(store, device.eventId);
  const updated = store.update('devices', device.id, { status: 'active', registeredAt: now(), networkStatus: 'online', lastSeenAt: now() });
  audit(store, { eventId: device.eventId, actor: body.name || 'field-device', action: 'device.register', targetType: 'device', targetId: device.id, metadata: { eventName: event.name } });
  send(res, 200, { token: updated.token, device: maskDevice(updated) });
}, { device: false });

route('POST', '/api/events/:eventId/assets', async ({ res, body, params, auth }) => {
  const event = requireEvent(store, params.eventId); assertActiveEvent(event);
  requireBody(body, ['kind', 'filename', 'dataUrl']);
  if (!['photo', 'font'].includes(body.kind)) throw httpError(400, 'Asset kind must be photo or font');
  const { mime, buffer } = decodeDataUrl(body.dataUrl);
  let ext = extensionFromMime(mime);
  if (body.kind === 'font') ext = inferFontExtension(body.filename, buffer, ext);
  const allowed = ASSET_MIME[body.kind];
  if (!allowed[ext]) throw httpError(415, `Unsupported ${body.kind} extension/MIME type ${mime}`);
  const canonicalMime = allowed[ext] === 'application/octet-stream' ? mime : allowed[ext];
  const acceptedMime = body.kind === 'font'
    ? [canonicalMime, mime, `application/x-font-${ext}`, 'application/octet-stream', 'application/font-ttf', 'application/font-otf', 'application/vnd.ms-opentype']
    : [canonicalMime];
  if (!acceptedMime.includes(mime)) throw httpError(415, `Unsupported ${body.kind} MIME type ${mime}`);
  if (buffer.length > 20 * 1024 * 1024) throw httpError(413, 'Asset exceeds 20 MiB limit');
  const asset = {
    id: id(body.kind === 'photo' ? 'pho' : 'font'), eventId: event.id, kind: body.kind,
    filename: String(body.filename).slice(0, 220), contentType: canonicalMime, ext, size: buffer.length,
    sha256: sha256(buffer), status: 'active', license: sanitizeLicense(body.license),
    uploadedBy: auth.actor, bytesRemovedAt: null, createdAt: now(), updatedAt: now()
  };
  fs.writeFileSync(assetDiskPath(asset), buffer);
  store.insert('assets', asset);
  audit(store, { eventId: event.id, actor: auth.actor, action: 'asset.upload', targetType: 'asset', targetId: asset.id, metadata: { kind: asset.kind, filename: asset.filename, size: asset.size, sha256: asset.sha256, license: asset.license } });
  send(res, 201, publicAsset(asset));
});

function sanitizeLicense(license) {
  const input = license && typeof license === 'object' ? license : {};
  const until = input.until ? new Date(input.until).toISOString() : null;
  return {
    source: String(input.source || 'unknown').slice(0, 200),
    scope: String(input.scope || 'event').slice(0, 200),
    document: String(input.document || '').slice(0, 500),
    until,
    grantedBy: String(input.grantedBy || '').slice(0, 200)
  };
}

route('GET', '/api/events/:eventId/assets', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('assets', (row) => row.eventId === params.eventId).map(publicAsset));
});

route('POST', '/api/events/:eventId/assets/:assetId/revoke', async ({ res, body, params, auth }) => {
  const event = requireEvent(store, params.eventId); assertActiveEvent(event);
  const asset = store.getById('assets', params.assetId);
  if (!asset || asset.eventId !== event.id) throw httpError(404, 'Asset not found');
  if (asset.status !== 'active') return send(res, 200, publicAsset(store.getById('assets', asset.id)));
  const reason = String(body.reason || 'license revoked').slice(0, 500);
  store.update('assets', asset.id, { status: 'revoked', revokedAt: now(), revokeReason: reason });
  audit(store, { eventId: event.id, actor: auth.actor, action: 'asset.revoke', targetType: 'asset', targetId: asset.id, metadata: { reason } });
  const responses = quarantineAffectedReleases(event.id, asset.id, auth.actor, reason);
  send(res, 200, { asset: publicAsset(store.getById('assets', asset.id)), ...responses });
});

route('POST', '/api/events/:eventId/versions', async ({ res, body, params, auth }) => {
  const event = requireEvent(store, params.eventId); assertActiveEvent(event);
  const payload = normalizePayload(body.payload);
  const readiness = resourceReadiness(store, event.id, payload);
  if (!readiness.ready) throw httpError(409, 'All referenced photo and font resources must be authorized and readable', readiness);
  const typography = validateTypographyReport(payload, body.typographyReport);
  const immutable = JSON.parse(JSON.stringify(payload));
  const version = {
    id: id('ver'), eventId: event.id, number: store.list('versions', (row) => row.eventId === event.id).length + 1,
    payload: immutable, payloadChecksum: checksum(immutable), resourceManifest: readiness.assets.map((asset) => ({
      id: asset.id, kind: asset.kind, sha256: asset.sha256, size: asset.size
    })),
    typographyReport: typography, status: 'ready', createdBy: auth.actor, createdAt: now(), updatedAt: now()
  };
  store.insert('versions', version);
  audit(store, { eventId: event.id, actor: auth.actor, action: 'version.create', targetType: 'version', targetId: version.id, metadata: { number: version.number, fontMode: immutable.fontMode, resources: version.resourceManifest.length } });
  send(res, 201, publicVersion(version));
});

route('GET', '/api/events/:eventId/versions', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('versions', (row) => row.eventId === params.eventId).map(publicVersion));
});

route('POST', '/api/events/:eventId/versions/validate', async ({ res, body, params }) => {
  const event = requireEvent(store, params.eventId);
  const payload = normalizePayload(body.payload);
  const readiness = resourceReadiness(store, event.id, payload);
  let typography = null;
  let typographyError = null;
  try { typography = validateTypographyReport(payload, body.typographyReport); }
  catch (error) { typographyError = { status: error.status, message: error.message }; }
  send(res, 200, {
    payload,
    payloadChecksum: checksum(payload),
    resources: { ...readiness, assets: readiness.assets.map(publicAsset) },
    typography: typography ? { ok: true, report: typography } : { ok: false, error: typographyError },
    canPublish: readiness.ready && !!typography
  });
});

route('POST', '/api/events/:eventId/releases', async ({ res, body, params, auth }) => {
  const event = requireEvent(store, params.eventId); assertActiveEvent(event);
  const version = store.getById('versions', body.versionId);
  if (!version || version.eventId !== event.id || version.status !== 'ready') throw httpError(400, 'A ready, event-bound version is required');
  const { group, devices } = validateDeviceList(store, event.id, body.groupId, body.deviceIds);
  const readiness = resourceReadiness(store, event.id, version.payload);
  if (!readiness.ready) throw httpError(409, 'Resource set is no longer complete; half-version switching is forbidden', readiness);
  validateTypographyReport(version.payload, version.typographyReport);
  const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : null;
  if (scheduledFor && Number.isNaN(scheduledFor.getTime())) throw httpError(400, 'Invalid scheduledFor timestamp');
  const releaseId = id('rel');
  const release = store.insert('releases', {
    id: releaseId, eventId: event.id, groupId: group.id, versionId: version.id,
    deviceIds: devices.map((device) => device.id), deviceSnapshot: devices.map((device) => ({ id: device.id, name: device.name })),
    status: scheduledFor ? 'scheduled' : 'ready', scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
    publishedAt: null, activatedBy: null, manifestHash: makeManifestHash(releaseId, version.id, readiness.assets),
    rollbackOf: null, createdAt: now(), updatedAt: now()
  });
  audit(store, { eventId: event.id, actor: auth.actor, action: scheduledFor ? 'release.schedule' : 'release.prepare', targetType: 'release', targetId: release.id, metadata: { versionId: version.id, groupId: group.id, hallName: group.hallName, deviceCount: devices.length, deviceIds: release.deviceIds, scheduledFor: release.scheduledFor } });
  if (!scheduledFor) activateRelease(release.id, auth.actor, 'manual publish');
  send(res, 201, publicRelease(store.getById('releases', release.id)));
});

route('GET', '/api/events/:eventId/releases', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('releases', (row) => row.eventId === params.eventId).map(publicRelease));
});

route('POST', '/api/releases/:releaseId/cancel', async ({ res, params, auth }) => {
  const release = getReleaseOr404(params.releaseId);
  assertActiveEvent(requireEvent(store, release.eventId));
  if (release.status !== 'scheduled') throw httpError(409, 'Only scheduled releases can be canceled');
  store.update('releases', release.id, { status: 'canceled' });
  audit(store, { eventId: release.eventId, actor: auth.actor, action: 'release.cancel', targetType: 'release', targetId: release.id });
  send(res, 200, publicRelease(store.getById('releases', release.id)));
});

route('POST', '/api/releases/:releaseId/rollback', async ({ res, params, body, auth }) => {
  const release = getReleaseOr404(params.releaseId);
  const event = requireEvent(store, release.eventId); assertActiveEvent(event);
  if (!['active', 'rollback'].includes(release.status)) throw httpError(409, 'Only an active release can be rolled back');
  const previous = body.targetReleaseId
    ? store.getById('releases', body.targetReleaseId)
    : previousPlayableRelease(store, event.id, release.groupId, release.id);
  if (body.targetReleaseId && (!previous || previous.eventId !== event.id || previous.groupId !== release.groupId || !releaseIsPlayable(store, previous))) {
    throw httpError(400, 'Selected rollback target is missing authorized resources or belongs to another hall');
  }
  const rollback = createRollbackRelease(release, previous, auth.actor, body.reason || 'manual proof rollback');
  send(res, 200, rollback);
});

function getReleaseOr404(releaseId) {
  const release = store.getById('releases', releaseId);
  if (!release) throw httpError(404, 'Release not found');
  return release;
}

route('POST', '/api/devices/poll', async ({ res, auth }) => {
  const device = auth.device;
  const release = activeReleaseFor(store, device);
  const event = store.getById('events', device.eventId);
  let desired = null;
  let purge = null;
  if (device.pendingPurge) {
    purge = {
      scope: device.purgeScope || { deletePhotoBodies: true, deleteFontBodies: event?.status === 'archived', retainOperationCredentials: true },
      proof: { deviceId: device.id, eventId: device.eventId, issuedAt: now() }
    };
  } else if (release) {
    const version = release.versionId ? store.getById('versions', release.versionId) : null;
    if (version || !release.versionId) {
      const payload = version ? version.payload : release.blankPayload;
      const refs = referencedAssetIds(payload);
      const assets = refs.map((assetId) => store.getById('assets', assetId)).filter(Boolean).map((asset) => ({
        id: asset.id, kind: asset.kind, contentType: asset.contentType, size: asset.size, sha256: asset.sha256,
        url: `/assets/${asset.id}.${asset.ext}?type=${device.id}&token=${encodeURIComponent(device.token)}`
      }));
      desired = {
        releaseId: release.id, groupId: device.groupId, eventId: device.eventId,
        eventName: event.name, hallName: store.getById('screenGroups', device.groupId)?.hallName,
        versionId: version?.id || null, payloadChecksum: version?.payloadChecksum || checksum(payload),
        manifestHash: makeManifestHash(release.id, version?.id || '', assets),
        payload, assets
      };
    }
  }
  send(res, 200, {
    now: now(),
    device: maskDevice(store.getById('devices', device.id)),
    eventStatus: event.status,
    desired,
    purge
  });
}, { device: true });

route('POST', '/api/devices/report', async ({ res, body, auth }) => {
  const device = auth.device;
  const status = ['downloading', 'ready', 'failed', 'offline'].includes(body.status) ? body.status : 'unknown';
  const patch = { networkStatus: status, currentManifestHash: body.currentManifestHash || null, currentReleaseId: body.releaseId || null };
  if (body.error) patch.lastError = String(body.error).slice(0, 500);
  store.update('devices', device.id, patch);
  if (body.screenshot) await saveScreenshot(device, body.screenshot, body.releaseId, body.note || 'field report');
  send(res, 200, { ok: true, device: maskDevice(store.getById('devices', device.id)) });
}, { device: true });

route('POST', '/api/devices/screenshot', async ({ res, body, auth }) => {
  const shot = await saveScreenshot(auth.device, body.dataUrl, body.releaseId, body.note || 'manual proof');
  send(res, 201, shot);
}, { device: true });

route('POST', '/api/devices/purge-ack', async ({ res, body, auth }) => {
  const device = auth.device;
  const ack = body.proof || {};
  const scope = ack.scope || {};
  if (!Array.isArray(scope.deletedAssetIds) || !ack.manifestHashBeforePurge) {
    throw httpError(400, 'Purge acknowledgement must include deleted asset IDs and pre-purge manifest hash');
  }
  const updated = store.update('devices', device.id, {
    pendingPurge: false,
    purgeAcknowledgedAt: now(),
    purgeScope: {
      manifestHashBeforePurge: String(ack.manifestHashBeforePurge),
      deletedAssetIds: scope.deletedAssetIds.map(String),
      retained: scope.retained || ['operationCredentials'],
      note: String(scope.note || 'terminal-reported local cache purge').slice(0, 500)
    },
    currentManifestHash: null,
    currentReleaseId: null,
    networkStatus: 'purged'
  });
  audit(store, { eventId: device.eventId, actor: 'field-device', action: 'device.purge-ack', targetType: 'device', targetId: device.id, metadata: updated.purgeScope });
  send(res, 200, { ok: true, device: maskDevice(updated) });
}, { device: true });

route('GET', '/api/events/:eventId/screenshots', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('screenshots', (row) => row.eventId === params.eventId).map(publicScreenshot));
});

route('GET', '/api/devices/:deviceId/registration', async ({ res, params }) => {
  const device = store.getById('devices', params.deviceId);
  if (!device) throw httpError(404, 'Device not found');
  send(res, 200, { code: device.registrationCode });
});

route('GET', '/api/events/:eventId/audits', async ({ res, params }) => {
  requireEvent(store, params.eventId);
  send(res, 200, store.list('audits', (row) => row.eventId === params.eventId));
});

route('POST', '/api/events/:eventId/retention/cleanup', async ({ res, params, auth }) => {
  const event = requireEvent(store, params.eventId);
  const assets = store.list('assets', (row) => row.eventId === event.id && row.status !== 'deleted' && row.bytesRemovedAt === null);
  let assetBodies = 0;
  for (const asset of assets) {
    const file = assetDiskPath(asset);
    if (fs.existsSync(file)) { fs.unlinkSync(file); assetBodies += 1; }
    store.update('assets', asset.id, { status: 'deleted', bytesRemovedAt: now() });
  }
  const shots = store.list('screenshots', (row) => row.eventId === event.id && row.dataUrl);
  let screenshotBodies = 0;
  for (const shot of shots) {
    store.update('screenshots', shot.id, { dataUrl: null, bytesRemovedAt: now() });
    screenshotBodies += 1;
  }
  store.update('events', event.id, { status: 'archived', archivedAt: now() });
  store.replace('devices', (row) => row.eventId === event.id, (row) => ({ ...row, pendingPurge: true, purgeScope: { deletePhotoBodies: true, deleteFontBodies: true, retainOperationCredentials: true }, networkStatus: 'purge-pending' }));
  audit(store, { eventId: event.id, actor: auth.actor, action: 'retention.cleanup', targetType: 'event', targetId: event.id, metadata: { assetBodies, screenshotBodies, retained: ['audit metadata', 'version checksums', 'license metadata without photo bodies'], offlineDevices: 'reported as purge-pending, not erased' } });
  send(res, 200, { ok: true, archived: true, assetBodies, screenshotBodies, note: 'Offline terminals remain purge-pending until they acknowledge a provable scope.' });
});

function serveAuthorizedAsset(assetIdMaybeExt, token, deviceId) {
  const assetId = assetIdMaybeExt.replace(/\.[^.]+$/, '');
  return (req, res) => {
    const device = store.find('devices', (row) => row.id === deviceId && row.token === token);
    if (!device) throw httpError(403, 'Asset access denied');
    const asset = store.getById('assets', assetId);
    if (!asset || asset.eventId !== device.eventId || asset.status !== 'active') throw httpError(404, 'Asset not available');
    const release = activeReleaseFor(store, device);
    const version = release?.versionId ? store.getById('versions', release.versionId) : null;
    const allowed = version ? referencedAssetIds(version.payload) : [];
    if (!allowed.includes(asset.id)) throw httpError(403, 'Asset is not assigned to this device release');
    const file = assetDiskPath(asset);
    if (!fs.existsSync(file)) throw httpError(404, 'Asset bytes missing');
    res.writeHead(200, {
      'Content-Type': asset.contentType,
      'Content-Length': asset.size,
      'Cache-Control': 'no-store',
      'X-Content-SHA256': asset.sha256
    });
    fs.createReadStream(file).pipe(res);
  };
}

async function saveScreenshot(device, dataUrl, releaseId, note) {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) throw httpError(400, 'PNG screenshot data URL is required');
  const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw httpError(413, 'Screenshot exceeds 8 MiB');
  const release = releaseId ? store.getById('releases', releaseId) : activeReleaseFor(store, device);
  const shot = {
    id: id('shot'), eventId: device.eventId, deviceId: device.id, releaseId: release?.id || null,
    releaseStatus: release?.status || null, note: String(note || '').slice(0, 300),
    sha256: sha256(buffer), size: buffer.length, dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
    createdAt: now()
  };
  store.insert('screenshots', shot);
  audit(store, { eventId: device.eventId, actor: 'field-device', action: 'screenshot.create', targetType: 'screenshot', targetId: shot.id, metadata: { deviceId: device.id, releaseId: shot.releaseId, sha256: shot.sha256, size: shot.size } });
  return publicScreenshot(shot);
}

function activateRelease(releaseId, actor, reason) {
  const release = store.getById('releases', releaseId);
  if (!release || !['ready', 'scheduled'].includes(release.status)) return null;
  const version = store.getById('versions', release.versionId);
  const readiness = version ? resourceReadiness(store, release.eventId, version.payload) : { ready: true, assets: [] };
  if (!readiness.ready) {
    store.update('releases', release.id, { status: 'failed', failure: readiness });
    audit(store, { eventId: release.eventId, actor, action: 'release.fail', targetType: 'release', targetId: release.id, metadata: readiness });
    return store.getById('releases', release.id);
  }
  store.replace('releases', (row) =>
    row.eventId === release.eventId && row.groupId === release.groupId &&
    row.id !== release.id && ['active', 'rollback'].includes(row.status),
    (row) => ({ ...row, status: 'superseded' })
  );
  store.update('releases', release.id, { status: 'active', publishedAt: now(), activatedBy: actor, activationReason: reason, manifestHash: makeManifestHash(release.id, release.versionId, readiness.assets) });
  const updated = store.getById('releases', release.id);
  for (const deviceId of release.deviceIds) {
    store.update('devices', deviceId, { desiredManifestHash: updated.manifestHash });
  }
  audit(store, { eventId: release.eventId, actor, action: 'release.activate', targetType: 'release', targetId: release.id, metadata: { versionId: release.versionId, deviceCount: release.deviceIds.length, reason, manifestHash: updated.manifestHash } });
  return updated;
}

function quarantineAffectedReleases(eventId, assetId, actor, reason) {
  const affected = store.list('releases', (row) => row.eventId === eventId && ['active', 'scheduled', 'ready'].includes(row.status));
  let activeRevoked = 0;
  let scheduledFailed = 0;
  const fallbacks = [];
  for (const release0 of affected) {
    const version = release0.versionId ? store.getById('versions', release0.versionId) : null;
    const refs = version ? referencedAssetIds(version.payload) : referencedAssetIds(release0.blankPayload || makeBlankPayload());
    if (!refs.includes(assetId)) continue;
    if (release0.status === 'active') {
      store.update('releases', release0.id, { status: 'revoked', revokedAt: now(), revokeReason: reason });
      activeRevoked += 1;
      const fallback = createRollbackRelease(release0, null, actor, `automatic safe rollback: ${reason}`);
      fallbacks.push(fallback.id);
    } else {
      store.update('releases', release0.id, { status: 'failed', failure: { reason, revokedAssetId: assetId } });
      scheduledFailed += 1;
    }
  }
  return { activeRevoked, scheduledFailed, fallbackReleaseIds: fallbacks };
}

function createRollbackRelease(release, previous, actor, reason) {
  let versionId = null;
  let blankPayload = null;
  if (previous && previous.versionId) {
    const candidate = store.getById('versions', previous.versionId);
    if (candidate && resourceReadiness(store, release.eventId, candidate.payload).ready) versionId = candidate.id;
  }
  if (!versionId && !previous?.blankPayload) blankPayload = makeBlankPayload('A photo authorization changed. Showing a safe non-photo screen.');
  else if (previous?.blankPayload) blankPayload = previous.blankPayload;

  store.replace('releases', (row) =>
    row.eventId === release.eventId && row.groupId === release.groupId &&
    row.id !== release.id && ['active', 'rollback'].includes(row.status),
    (row) => ({ ...row, status: 'superseded' })
  );
  const assets = versionId ? resourceReadiness(store, release.eventId, store.getById('versions', versionId).payload).assets : [];
  const rollbackId = id('rel');
  const row = {
    id: rollbackId, eventId: release.eventId, groupId: release.groupId, versionId,
    blankPayload, deviceIds: release.deviceIds, deviceSnapshot: release.deviceSnapshot,
    status: 'rollback', scheduledFor: null, publishedAt: now(), activatedBy: actor,
    activationReason: reason, manifestHash: makeManifestHash(rollbackId, versionId, assets),
    rollbackOf: release.id, createdAt: now(), updatedAt: now()
  };
  store.insert('releases', row);
  for (const deviceId of row.deviceIds) store.update('devices', deviceId, { desiredManifestHash: row.manifestHash });
  audit(store, { eventId: row.eventId, actor, action: 'release.rollback', targetType: 'release', targetId: row.id, metadata: { from: release.id, toVersion: versionId, blank: !versionId, reason, deviceCount: row.deviceIds.length } });
  return publicRelease(store.getById('releases', row.id));
}

const scheduler = setInterval(() => {
  const current = Date.now();
  for (const release of store.list('releases', (row) => row.status === 'scheduled' && row.scheduledFor)) {
    if (current >= Date.parse(release.scheduledFor)) activateRelease(release.id, 'scheduler', 'scheduled activation');
  }
}, 1000);
scheduler.unref();

function maskDevice(device) {
  const { token, registrationCode, ...safe } = device;
  return { ...safe, stale: isStale(device.lastSeenAt), hasToken: true, registrationCode: undefined };
}
function publicAsset(asset) {
  const { ...safe } = asset;
  return safe;
}
function publicVersion(version) {
  return { id: version.id, eventId: version.eventId, number: version.number, payload: version.payload, payloadChecksum: version.payloadChecksum, resourceManifest: version.resourceManifest, typographyReport: version.typographyReport, status: version.status, createdBy: version.createdBy, createdAt: version.createdAt };
}
function publicRelease(release) {
  const devices = store.list('devices', (row) => release.deviceIds.includes(row.id));
  return {
    ...release,
    devices: devices.map((device) => ({
      id: device.id, name: device.name, stale: isStale(device.lastSeenAt),
      networkStatus: device.networkStatus, currentManifestHash: device.currentManifestHash,
      desiredManifestHash: device.desiredManifestHash, aligned: device.currentManifestHash === release.manifestHash,
      pendingPurge: device.pendingPurge, purgeAcknowledgedAt: device.purgeAcknowledgedAt
    }))
  };
}
function publicScreenshot(shot) { return shot; }

export function createAppServer() {
  return http.createServer((req, res) => router(req, res));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  createAppServer().listen(PORT, () => {
    console.log(`VowDisplay listening on http://localhost:${PORT}`);
  });
}
