import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum, normalizePayload, validateDeviceList, validateTypographyReport } from '../server/domain.js';

test('normalizePayload publishes focus, dim layer and caption position together', () => {
  const payload = normalizePayload({
    photo: { focusX: 12, focusY: 88, dim: 52, captionX: 30, captionY: 61 },
    fontAssetIds: [],
    slides: [{ locale: 'zh-CN', names: '非常长的新人姓名 Very Long Name', hallName: '水晶厅 Crystal Hall', message: '欢迎 Welcome' }]
  });
  assert.deepEqual(payload.photo, { assetId: '', focusX: 12, focusY: 88, dim: 52, captionX: 30, captionY: 61 });
});

test('payload checksum changes with multilingual copy', () => {
  const base = normalizePayload({ slides: [{ locale: 'zh', names: 'A', hallName: 'H', message: 'M' }] });
  const translated = normalizePayload({ slides: [{ locale: 'en', names: 'A', hallName: 'H', message: 'M' }] });
  assert.notEqual(checksum(base), checksum(translated));
});

test('typography report must be generated for current payload and detect embedded overflow', () => {
  const payload = normalizePayload({ fontAssetIds: ['font_x'], slides: [{ locale: 'zh', names: 'A', hallName: 'H', message: 'M' }] });
  const slide = { locale: 'zh', names: { ok: true, lines: ['A'], lineWidths: [10], blockHeight: 10 }, hall: { ok: true, lines: ['H'], lineWidths: [10], blockHeight: 10 }, message: { ok: true, lines: ['M'], lineWidths: [10], blockHeight: 10 }, missingGlyphs: [], missingGlyphCount: 0, overflow: false, safeAreaViolation: false };
  assert.throws(() => validateTypographyReport(payload, { payloadChecksum: 'stale', embedded: { slides: [slide] }, fallback: { slides: [slide] }, differences: [] }), /stale/);
  const bad = {
    payloadChecksum: checksum(payload),
    embedded: { slides: [{ ...slide, overflow: true, missingGlyphCount: 0 }], missingGlyphCount: 0, overflow: true, safeAreaViolation: false },
    fallback: { slides: [slide] }, differences: []
  };
  assert.throws(() => validateTypographyReport(payload, bad), /safe-margin|glyph|line-wrap/);
});

test('device list is event and hall scoped to prevent cross-hall push', () => {
  const store = {
    getById(collection, id) {
      if (collection === 'screenGroups') return { id: 'g1', eventId: 'e1' };
      if (collection === 'devices') return { id: 'd1', eventId: 'e2', groupId: 'g9', name: 'other hall', status: 'active' };
    }
  };
  assert.throws(() => validateDeviceList(store, 'e1', 'g1', ['d1']), /another hall|not bound/);
});
