const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const toast = document.getElementById('toast');
const dbName = 'vowdisplay-device';
let db;
let token = localStorage.getItem('vow.deviceToken');
let currentManifest = localStorage.getItem('vow.currentManifestHash');
let desired = null;
let assetsById = {};
let images = {};
let slideIndex = 0;
let status = 'boot';
let lastProof = null;

function resize() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(innerWidth * ratio);
  canvas.height = Math.floor(innerHeight * ratio);
  draw();
}
window.addEventListener('resize', resize);

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('releases')) database.createObjectStore('releases');
      if (!database.objectStoreNames.contains('assets')) database.createObjectStore('assets');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(storeName, key) { return new Promise((resolve, reject) => { const req = db.transaction(storeName).objectStore(storeName).get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function idbPut(storeName, value, key) { return new Promise((resolve, reject) => { const req = db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
function idbDelete(storeName, key) { return new Promise((resolve, reject) => { const req = db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
function idbKeys(storeName) { return new Promise((resolve, reject) => { const req = db.transaction(storeName).objectStore(storeName).getAllKeys(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { data });
  return data;
}

async function register() {
  const code = new URLSearchParams(location.search).get('code') || prompt('请输入设备配对码');
  if (!code) return showHud('未输入配对码，终端未绑定活动。');
  const data = await api('/api/devices/register', { registrationCode: code, name: location.host });
  token = data.token; localStorage.setItem('vow.deviceToken', token);
  showToast(`已绑定：${data.device.name}`);
}

async function bufferSha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function downloadDesired(next) {
  status = 'downloading'; await report('downloading');
  const downloaded = [];
  for (const asset of next.assets) {
    const cached = await idbGet('assets', asset.id);
    if (cached && cached.sha256 === asset.sha256 && cached.data.byteLength === asset.size) {
      downloaded.push(cached); continue;
    }
    const response = await fetch(asset.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Asset ${asset.id} download failed: ${response.status}`);
    const data = await response.arrayBuffer();
    const hash = await bufferSha256(data);
    if (hash !== asset.sha256 || data.byteLength !== asset.size) throw new Error(`Asset ${asset.id} checksum mismatch`);
    const row = { id: asset.id, kind: asset.kind, contentType: asset.contentType, size: asset.size, sha256: hash, data };
    await idbPut('assets', row, asset.id);
    downloaded.push(row);
  }
  const calculated = await calculateManifestHash(next.releaseId, next.versionId || '', downloaded);
  if (calculated !== next.manifestHash) throw new Error('Manifest hash mismatch; refusing partial switch');
  // Atomic semantic switch: all bytes and complete payload are committed before rendering changes.
  await idbPut('releases', next, next.releaseId);
  desired = next; currentManifest = calculated; assetsById = Object.fromEntries(downloaded.map(a => [a.id, a]));
  localStorage.setItem('vow.currentManifestHash', calculated);
  await prepareImages(downloaded);
  await loadEmbeddedFonts(next, downloaded);
  await report('ready');
}

async function calculateManifestHash(releaseId, versionId, assets) {
  const sorted = assets.map((a) => ({ id: a.id, sha256: a.sha256, size: a.size })).sort((a, b) => a.id.localeCompare(b.id));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ releaseId, versionId, assets: sorted })));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function prepareImages(rows) {
  images = {};
  for (const row of rows.filter((a) => a.kind === 'photo')) {
    const blob = new Blob([row.data], { type: row.contentType });
    const url = URL.createObjectURL(blob);
    images[row.id] = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
  }
}

async function loadEmbeddedFonts(release, rows) {
  await VowRender.loadFonts(release.payload, rows.filter((row) => row.kind === 'font').map((row) => ({
    id: row.id, kind: row.kind, buffer: row.data
  })));
}

async function loadCached(release) {
  desired = release;
  const rows = [];
  for (const id of release.assets.map(a => a.id)) {
    const row = await idbGet('assets', id);
    if (row) rows.push(row);
  }
  assetsById = Object.fromEntries(rows.map(a => [a.id, a]));
  await prepareImages(rows);
  await loadEmbeddedFonts(release, rows);
}

async function poll() {
  if (!token) return;
  const data = await api('/api/devices/poll', {});
  showHudFor(data.device);
  if (data.purge) return purgeLocalCache(data.purge);
  const next = data.desired;
  if (next && next.manifestHash !== currentManifest) {
    showToast('新版本资源包下载中；下载与校验完成前继续显示旧版，禁止半版切换。');
    await downloadDesired(next);
    showToast('完整资源已校验，原子切换到新版本。');
  } else if (next && !desired) {
    await loadCached(next);
  } else if (!next) {
    desired = null; draw();
  }
  draw();
}

async function report(networkStatus, extra = {}) {
  try { await api('/api/devices/report', { status: networkStatus, releaseId: desired?.releaseId, currentManifestHash: currentManifest, ...extra }); }
  catch (error) { console.warn(error); }
}

function draw() {
  if (!desired) {
    ctx.fillStyle = '#080a0e'; ctx.fillRect(0,0,canvas.width, canvas.height);
    ctx.fillStyle = '#9fb0c3'; ctx.font = '400 34px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(token ? '等待发布到本设备所属厅组' : '请用配对码绑定现场设备', canvas.width / 2, canvas.height / 2);
    return;
  }
  VowRender.renderPayload(ctx, canvas.width, canvas.height, desired.payload, slideIndex % desired.payload.slides.length, images, { showSafeArea: new URLSearchParams(location.search).get('safe') === '1' });
}

setInterval(() => { if (desired) { slideIndex = (slideIndex + 1) % desired.payload.slides.length; draw(); } }, 9000);
setInterval(() => poll().catch((error) => { status = 'offline'; showToast(`离线：${error.message}；继续显示已缓存版本`); report('offline', { error: error.message }).catch(() => {}); }), 5000);

async function screenshot() {
  const dataUrl = canvas.toDataURL('image/png');
  lastProof = { dataUrl, at: new Date().toISOString(), hash: currentManifest };
  try { await api('/api/devices/screenshot', { dataUrl, releaseId: desired?.releaseId, note: `manual proof ${innerWidth}x${innerHeight}` }); showToast('现场截图已上传，可在管理页校对并回退。'); }
  catch (error) { showToast(`截图保存在本地待联网上传：${error.message}`); }
}

async function purgeLocalCache(purge) {
  const keys = await idbKeys('assets');
  const deletedAssetIds = [];
  for (const key of keys) {
    const asset = await idbGet('assets', key);
    if (asset.kind === 'photo' || (purge.scope.deleteFontBodies && asset.kind === 'font')) {
      await idbDelete('assets', key); deletedAssetIds.push(key);
    }
  }
  const releaseKeys = await idbKeys('releases');
  for (const key of releaseKeys) await idbDelete('releases', key);
  const proof = { manifestHashBeforePurge: currentManifest || 'unknown', scope: { deletedAssetIds, retained: ['operationCredentials'], note: 'browser IndexedDB photo/font bodies deleted; server retains no-photo operational evidence' } };
  try {
    await api('/api/devices/purge-ack', { proof });
    localStorage.removeItem('vow.currentManifestHash'); currentManifest = null; desired = null; images = {}; draw();
    showToast('缓存正文已清除，并提交可证明范围。');
  } catch (error) {
    showToast(`离线：只可确认本机已删除 ${deletedAssetIds.length} 项，管理页不会标记为已擦除。`);
  }
}

function showHudFor(device) {
  hud.innerHTML = `<b>${esc(desired?.eventName || device.eventId)}</b> · ${esc(desired?.hallName || '')}<br>设备 ${esc(device.name)} · ${esc(device.networkStatus)} · <span class="mono">${currentManifest ? currentManifest.slice(0,16) : '无版本'}</span><br><button onclick="document.documentElement.requestFullscreen()">F 全屏</button><button id="shotBtn">P 截图校对</button><button id="hideHud">隐藏</button>`;
  hud.classList.remove('hidden');
  hud.querySelector('#shotBtn').onclick = screenshot;
  hud.querySelector('#hideHud').onclick = () => hud.classList.add('hidden');
}
function showHud(message) { hud.textContent = message; hud.classList.remove('hidden'); }
function showToast(message) { toast.textContent = message; setTimeout(() => toast.textContent = 'VowDisplay 现场终端', 5000); }
function esc(v) { return String(v ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'p') screenshot();
  if (event.key.toLowerCase() === 'f') document.documentElement.requestFullscreen();
  if (event.key.toLowerCase() === 'h') hud.classList.toggle('hidden');
});

(async function boot() {
  db = await openDb(); resize();
  try {
    if (!token) await register();
    await poll();
  } catch (error) {
    showHud(`绑定失败：${error.message}`);
  }
})();
