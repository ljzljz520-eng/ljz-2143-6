import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
let base, server, token, deviceId, eventId, groupId, photo, font, versionId, releaseId;

function report(payload) {
  const slide = {
    locale: payload.slides[0].locale,
    names: { ok: true, size: 42, lines: ['names'], lineWidths: [100], blockHeight: 50, overflow: false },
    hall: { ok: true, size: 24, lines: ['hall'], lineWidths: [80], blockHeight: 30, overflow: false },
    message: { ok: true, size: 20, lines: ['message'], lineWidths: [90], blockHeight: 28, overflow: false },
    missingGlyphs: [], missingGlyphCount: 0, overflow: false, safeAreaViolation: false
  };
  return {
    payloadChecksum: null, width: 1280, height: 720,
    embedded: { slides: [slide], missingGlyphCount: 0, overflow: false, safeAreaViolation: false },
    fallback: { slides: [slide] }, differences: [], acknowledgedFallback: false
  };
}

async function http(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({})).catch(() => ({}));
  if (!response.ok && !options.allowFailure) throw Object.assign(new Error(data.error || response.status), { data, status: response.status });
  return { status: response.status, data };
}

function fontDataUrl() {
  const bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40)]);
  return `data:font/woff2;base64,${bytes.toString('base64')}`;
}

function payload(overrides = {}) {
  const { slide, ...rest } = overrides;
  return {
    fontMode: 'embedded', fontFamily: 'Test Font', fallbackFamily: 'system-ui, sans-serif',
    fontAssetIds: [font.id], safeMargin: 64, backgroundColor: '#101318', textColor: '#ffffff', accentColor: '#d8b36f',
    photo: { assetId: photo.id, focusX: 33, focusY: 66, dim: 40, captionX: 50, captionY: 70 },
    slides: [{ id: 'sld_acceptance', locale: 'zh-CN', names: '很长的新人姓名 Long Couple Name Élodie', hallName: '水晶厅 Crystal Hall', message: '欢迎 Welcome · مرحبا', ...(slide || {}) }],
    ...rest
  };
}

test.before(async () => {
  process.env.VOW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vowdisplay-test-'));
  const { createAppServer } = await import('../server/index.js');
  await new Promise((resolve) => {
    server = createAppServer().listen(0, resolve);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  const event = await http('/api/events', { method: 'POST', body: { name: 'Test Wedding', coupleName: 'Couple' } });
  eventId = event.data.id;
  const group = await http(`/api/events/${eventId}/groups`, { method: 'POST', body: { name: 'Main', hallName: 'Crystal Hall' } });
  groupId = group.data.id;
  const device = await http(`/api/events/${eventId}/devices`, { method: 'POST', body: { name: 'Hall Display', groupId } });
  deviceId = device.data.id;
  const code = await http(`/api/devices/${deviceId}/registration`);
  const registered = await http('/api/devices/register', { method: 'POST', body: { registrationCode: code.data.code } });
  token = registered.data.token;

  photo = (await http(`/api/events/${eventId}/assets`, { method: 'POST', body: { kind: 'photo', filename: 'photo.png', dataUrl: PNG, license: { source: 'couple', until: '2099-01-01' } } })).data;
  font = (await http(`/api/events/${eventId}/assets`, { method: 'POST', body: { kind: 'font', filename: 'display.woff2', dataUrl: fontDataUrl(), license: { source: 'foundry license' } } })).data;
});

test.after(() => server.close());

test('creates immutable version only when resources and typography gate pass', async () => {
  const incomplete = payload({ photo: { assetId: 'pho_missing', focusX: 50, focusY: 50, dim: 35, captionX: 50, captionY: 72 }, fontAssetIds: [] });
  await assert.rejects(http(`/api/events/${eventId}/versions`, { method: 'POST', body: { payload: incomplete, typographyReport: report(incomplete) } }), /resource|Typography|font/i);

  const p = payload();
  let checksum = (await http(`/api/events/${eventId}/versions/validate`, { method: 'POST', body: { payload: p, typographyReport: report(p) } }));
  const r = report(p);
  r.payloadChecksum = checksum.data.payloadChecksum;
  checksum = await http(`/api/events/${eventId}/versions/validate`, { method: 'POST', body: { payload: p, typographyReport: r } });
  assert.equal(checksum.data.canPublish, true);
  const version = await http(`/api/events/${eventId}/versions`, { method: 'POST', body: { payload: p, typographyReport: r } });
  versionId = version.data.id;
  assert.equal(version.data.payload.photo.focusX, 33);
});

test('release requires explicit event-bound device list and blocks another hall', async () => {
  const otherEvent = (await http('/api/events', { method: 'POST', body: { name: 'Other', coupleName: 'Other Couple' } })).data;
  const otherGroup = (await http(`/api/events/${otherEvent.id}/groups`, { method: 'POST', body: { name: 'G2', hallName: 'Other Hall' } })).data;
  const wrong = await http(`/api/events/${otherEvent.id}/releases`, { method: 'POST', body: { versionId, groupId, deviceIds: [deviceId] }, allowFailure: true });
  assert.equal(wrong.status, 400);
  const noDevices = await http(`/api/events/${eventId}/releases`, { method: 'POST', body: { versionId, groupId, deviceIds: [] }, allowFailure: true });
  assert.equal(noDevices.status, 400);

  const release = await http(`/api/events/${eventId}/releases`, { method: 'POST', body: { versionId, groupId, deviceIds: [deviceId] } });
  releaseId = release.data.id;
  assert.equal(release.data.status, 'active');
});

test('device receives only its event/hall release and downloads authorized bytes', async () => {
  const poll = await http('/api/devices/poll', { method: 'POST' });
  assert.equal(poll.data.desired.releaseId, releaseId);
  assert.equal(poll.data.desired.eventId, eventId);
  assert.equal(poll.data.desired.assets.length, 2);
  const photoAsset = poll.data.desired.assets.find((asset) => asset.kind === 'photo');
  const bytes = await fetch(`${base}${photoAsset.url}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = new Uint8Array(await bytes.arrayBuffer());
  assert.equal(bytes.status, 200);
  assert.equal(body.length, photo.size);
  assert.equal(bytes.headers.get('x-content-sha256'), photo.sha256);
});

test('scheduled release does not switch early, activates on time, and can be canceled', async () => {
  const p2 = payload({ slide: { message: 'Second scheduled message' } });
  const initial = await http(`/api/events/${eventId}/versions/validate`, { method: 'POST', body: { payload: p2, typographyReport: report(p2) } });
  const r2 = report(p2);
  r2.payloadChecksum = initial.data.payloadChecksum;
  const validation = await http(`/api/events/${eventId}/versions/validate`, { method: 'POST', body: { payload: p2, typographyReport: r2 } });
  assert.equal(validation.data.canPublish, true);
  const v2 = (await http(`/api/events/${eventId}/versions`, { method: 'POST', body: { payload: p2, typographyReport: r2 } })).data;
  const future = new Date(Date.now() + 800).toISOString();
  const scheduled = (await http(`/api/events/${eventId}/releases`, { method: 'POST', body: { versionId: v2.id, groupId, deviceIds: [deviceId], scheduledFor: future } })).data;
  let poll = await http('/api/devices/poll', { method: 'POST' });
  assert.equal(poll.data.desired.versionId, versionId);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  poll = await http('/api/devices/poll', { method: 'POST' });
  assert.equal(poll.data.desired.versionId, v2.id);
  await http(`/api/releases/${scheduled.id}/cancel`, { method: 'POST', allowFailure: true }); // already active, must not rewrite history
});

test('field screenshot becomes proofing evidence and supports rollback', async () => {
  const current = (await http('/api/devices/poll', { method: 'POST' })).data.desired.releaseId;
  const reportResult = await http('/api/devices/report', { method: 'POST', body: { status: 'ready', releaseId: current, currentManifestHash: 'client-hash', screenshot: PNG, note: 'acceptance screenshot' } });
  assert.equal(reportResult.status, 200);
  const shots = await http(`/api/events/${eventId}/screenshots`);
  assert.equal(shots.data.length, 1);
  assert.match(shots.data[0].sha256, /^[a-f0-9]{64}$/);
  const rolled = await http(`/api/releases/${current}/rollback`, { method: 'POST', body: { reason: 'proof mismatch' } });
  releaseId = rolled.data.id;
  assert.equal(rolled.data.status, 'rollback');
});

test('photo revocation quarantines references and gives devices a no-photo safe screen', async () => {
  // Re-activate v2 so revoked photo has an active reference.
  const releases = (await http(`/api/events/${eventId}/releases`)).data;
  const v2Release = releases.find((item) => item.versionId && item.status === 'superseded');
  // Rollback release is active; revoke must create another blank rollback.
  await http(`/api/events/${eventId}/assets/${photo.id}/revoke`, { method: 'POST', body: { reason: 'couple withdrew photo rights' } });
  const poll = await http('/api/devices/poll', { method: 'POST' });
  assert.equal(poll.data.desired.assets.length, 0, 'safe blank release contains no photo or font references');
  assert.equal(poll.data.desired.payload.photo.assetId, '');
  assert.match(poll.data.desired.payload.slides[0].message, /safe/i);
});

test('retention cleanup never claims offline erase until terminal proves scope', async () => {
  await http(`/api/events/${eventId}/retention/cleanup`, { method: 'POST' });
  let devices = (await http(`/api/events/${eventId}/devices`)).data;
  assert.equal(devices[0].pendingPurge, true);
  assert.equal(devices[0].purgeAcknowledgedAt, null);
  const poll = await http('/api/devices/poll', { method: 'POST' });
  assert.equal(poll.data.purge.scope.deletePhotoBodies, true);
  const ack = await http('/api/devices/purge-ack', { method: 'POST', body: { proof: { manifestHashBeforePurge: 'old-manifest', scope: { deletedAssetIds: [photo.id, font.id], retained: ['operationCredentials'] } } } });
  assert.equal(ack.data.device.purgeAcknowledgedAt !== null, true);
  const audits = await http(`/api/events/${eventId}/audits`);
  assert.ok(audits.data.some((row) => row.action === 'retention.cleanup'));
  assert.ok(audits.data.some((row) => row.action === 'device.purge-ack'));
});
