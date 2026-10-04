const $ = (id) => document.getElementById(id);
const state = {
  events: [], event: null, groups: [], devices: [], assets: [], versions: [], releases: [], screenshots: [], audits: [],
  payload: defaultPayload(), report: null, assetDataUrl: '', localAssets: {}, deviceCodes: {}
};

function defaultPayload() {
  return {
    fontMode: 'embedded', fontFamily: 'VowDisplay Serif', fallbackFamily: "system-ui, 'Noto Sans CJK SC', sans-serif",
    fontAssetIds: [], safeMargin: 64, backgroundColor: '#101318', textColor: '#ffffff', accentColor: '#d8b36f',
    photo: { assetId: '', focusX: 50, focusY: 50, dim: 35, captionX: 50, captionY: 72 },
    slides: [
      { id: crypto.randomUUID(), locale: 'zh-CN', names: '张晓明 × Élodie Martin', hallName: '水晶厅 · Crystal Hall', message: '欢迎参加我们的婚礼 · Welcome to our wedding' }
    ]
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Actor': 'designer@example.com', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { data });
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function selected(id, value) { return id === value ? 'selected' : ''; }
function statusPill(value) {
  const good = ['active', 'ready', 'active'];
  const bad = ['failed', 'revoked', 'canceled', 'purged'];
  const cls = good.includes(value) ? 'good' : bad.includes(value) ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${esc(value)}</span>`;
}

async function loadAll() {
  state.events = await api('/api/events');
  renderEvents();
  if (state.event) await loadEvent(state.event.id);
}
async function loadEvent(eventId) {
  const [event, groups, devices, assets, versions, releases, screenshots, audits] = await Promise.all([
    api(`/api/events/${eventId}`), api(`/api/events/${eventId}/groups`), api(`/api/events/${eventId}/devices`),
    api(`/api/events/${eventId}/assets`), api(`/api/events/${eventId}/versions`), api(`/api/events/${eventId}/releases`),
    api(`/api/events/${eventId}/screenshots`), api(`/api/events/${eventId}/audits`)
  ]);
  Object.assign(state, { event, groups, devices, assets, versions, releases, screenshots, audits });
  state.report = null;
  renderEvent(); renderGroups(); renderAssets(); renderSlides(); renderAssetSelects(); renderReleases(); renderScreenshots(); renderAudits(); await drawPreview();
}

function renderEvents() {
  $('eventSelect').innerHTML = state.events.map((event) => `<option value="${event.id}" ${selected(event.id, state.event?.id)}>${esc(event.name)} — ${esc(event.coupleName)}</option>`).join('');
}
function renderEvent() {
  $('eventMeta').innerHTML = state.event ? `<b>${esc(state.event.coupleName)}</b><br>${esc(state.event.name)} ${statusPill(state.event.status)}<br>ID <span class="mono">${state.event.id}</span>` : '';
}

$('createEvent').onclick = async () => {
  const event = await api('/api/events', { method: 'POST', body: { name: $('eventName').value, coupleName: $('coupleName').value } });
  state.event = event; await loadAll(); $('eventSelect').value = event.id;
};
$('eventSelect').onchange = async () => { state.event = state.events.find((event) => event.id === $('eventSelect').value); if (state.event) await loadEvent(state.event.id); };

function renderGroups() {
  const options = state.groups.map((group) => `<option value="${group.id}">${esc(group.name)} / ${esc(group.hallName)}</option>`).join('');
  $('deviceGroup').innerHTML = options; $('publishGroup').innerHTML = options;
  renderDeviceTable(); renderPublishTargets();
}

$('createGroup').onclick = async () => {
  await api(`/api/events/${state.event.id}/groups`, { method: 'POST', body: { name: $('groupName').value, hallName: $('hallName').value } });
  await loadEvent(state.event.id);
};
$('createDevice').onclick = async () => {
  await api(`/api/events/${state.event.id}/devices`, { method: 'POST', body: { name: $('deviceName').value, groupId: $('deviceGroup').value } });
  await loadEvent(state.event.id);
};

function renderDeviceTable() {
  const groupName = (id) => state.groups.find((group) => group.id === id)?.name || '—';
  $('deviceRows').innerHTML = state.devices.map((device) => `<tr>
    <td><b>${esc(device.name)}</b><br><span class="mono">${device.id}</span><br>${device.purgeAcknowledgedAt ? `<span class="good">已按清单擦除 ${esc(device.purgeAcknowledgedAt)}</span>` : device.pendingPurge ? '<span class="warn">待擦除（等待终端确认）</span>' : ''}</td>
    <td>${esc(groupName(device.groupId))}</td><td>${statusPill(device.status)} ${statusPill(device.networkStatus)} ${device.stale ? '<span class="bad">断网/心跳过期</span>' : '<span class="good">在线</span>'}</td>
    <td><button data-code="${device.id}" class="codeBtn">显示配对码</button><div id="code_${device.id}" class="mono"></div><a href="/display?code=${encodeURIComponent(device.registrationCode || '')}" target="_blank">打开现场窗口</a></td>
  </tr>`).join('');
  document.querySelectorAll('.codeBtn').forEach((button) => button.onclick = async () => {
    const data = await api(`/api/devices/${button.dataset.code}/registration`);
    $(`code_${button.dataset.code}`).textContent = data.code;
  });
}

$('assetFile').onchange = async () => {
  const file = $('assetFile').files[0]; if (!file) return;
  state.assetDataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
};
$('uploadAsset').onclick = async () => {
  const file = $('assetFile').files[0]; if (!file || !$('licenseConfirm').checked) return alert('选择文件并确认授权');
  const created = await api(`/api/events/${state.event.id}/assets`, { method: 'POST', body: {
    kind: file.type.startsWith('image/') ? 'photo' : 'font', filename: file.name, dataUrl: state.assetDataUrl,
    license: { source: $('licenseSource').value, scope: 'event field display', until: $('licenseUntil').value, grantedBy: 'couple' }
  } });
  state.localAssets[created.id] = await (await fetch(state.assetDataUrl)).arrayBuffer();
  await loadEvent(state.event.id);
};
function renderAssets() {
  $('assetRows').innerHTML = state.assets.map((asset) => `<tr><td><label class="checkline"><input type="checkbox" class="revokeAsset" value="${asset.id}">${esc(asset.filename)}</label><br><span class="mono">${asset.sha256.slice(0,12)} · ${asset.size}B</span></td><td>${asset.kind}</td><td>${esc(asset.license.source)}<br><span class="small">${esc(asset.license.until || '未限')}</span></td><td>${statusPill(asset.status)}${asset.bytesRemovedAt ? '<br><span class="good">正文已删</span>' : ''}</td></tr>`).join('');
}
function renderAssetSelects() {
  $('photoAsset').innerHTML = '<option value="">无照片（安全纯色）</option>' + state.assets.filter((a) => a.kind === 'photo' && a.status === 'active').map((a) => `<option value="${a.id}" ${selected(state.payload.photo.assetId, a.id)}>${esc(a.filename)}</option>`).join('');
  $('fontAssets').innerHTML = state.assets.filter((a) => a.kind === 'font' && a.status === 'active').map((a) => `<option value="${a.id}" ${state.payload.fontAssetIds.includes(a.id) ? 'selected' : ''}>${esc(a.filename)}</option>`).join('');
}
$('photoAsset').onchange = () => { state.payload.photo.assetId = $('photoAsset').value; drawPreview(); };
document.querySelectorAll('[data-range]').forEach((input) => input.addEventListener('input', () => {
  state.payload.photo[input.dataset.range] = Number(input.value); invalidateReport(); drawPreview();
}));
$('safeMargin').oninput = () => { state.payload.safeMargin = Number($('safeMargin').value); invalidateReport(); drawPreview(); };
$('fontMode').onchange = () => { state.payload.fontMode = $('fontMode').value; invalidateReport(); drawPreview(); };
$('fontFamily').oninput = () => { state.payload.fontFamily = $('fontFamily').value; invalidateReport(); drawPreview(); };
$('fallbackFamily').oninput = () => { state.payload.fallbackFamily = $('fallbackFamily').value; invalidateReport(); drawPreview(); };
$('fontAssets').onchange = () => { state.payload.fontAssetIds = [...$('fontAssets').selectedOptions].map((o) => o.value); invalidateReport(); drawPreview(); };
$('safeToggle').oninput = drawPreview;
$('previewSlide').onchange = drawPreview;

function renderSlides() {
  $('slides').innerHTML = state.payload.slides.map((slide, index) => `<div class="slide" data-index="${index}">
    <div class="row"><div style="flex:1"><label>BCP-47 语言</label><input class="locale" value="${esc(slide.locale)}"></div><button class="removeSlide">删除</button></div>
    <label>长姓名 / 多语混排</label><textarea class="names">${esc(slide.names)}</textarea>
    <label>宴会厅</label><input class="hall" value="${esc(slide.hallName)}">
    <label>字幕文案</label><textarea class="message">${esc(slide.message)}</textarea>
  </div>`).join('');
  document.querySelectorAll('.slide').forEach((div) => {
    const index = Number(div.dataset.index);
    div.querySelector('.locale').oninput = (e) => { state.payload.slides[index].locale = e.target.value; invalidateReport(); };
    div.querySelector('.names').oninput = (e) => { state.payload.slides[index].names = e.target.value; invalidateReport(); drawPreview(); };
    div.querySelector('.hall').oninput = (e) => { state.payload.slides[index].hallName = e.target.value; invalidateReport(); drawPreview(); };
    div.querySelector('.message').oninput = (e) => { state.payload.slides[index].message = e.target.value; invalidateReport(); drawPreview(); };
    const remove = div.querySelector('.removeSlide'); if (remove) remove.onclick = () => { state.payload.slides.splice(index, 1); renderSlides(); invalidateReport(); drawPreview(); };
  });
  $('previewSlide').innerHTML = state.payload.slides.map((s, i) => `<option value="${i}">${esc(s.locale)}</option>`).join('');
}
$('addSlide').onclick = () => { state.payload.slides.push({ id: crypto.randomUUID(), locale: 'en', names: 'Long Name Example', hallName: 'Banquet Hall', message: 'Welcome' }); renderSlides(); invalidateReport(); drawPreview(); };
function invalidateReport() { state.report = null; $('ackFallback').checked = false; $('ackFallback').disabled = true; $('typoSummary').textContent = '设计已变化，需要重新比对'; }

async function imageForPreview() {
  const images = {};
  if (state.payload.photo.assetId) {
    const asset = state.assets.find((a) => a.id === state.payload.photo.assetId);
    const buffer = state.localAssets[asset?.id];
    if (asset && !asset.bytesRemovedAt && buffer) {
      const blob = new Blob([buffer], { type: asset.contentType });
      images[asset.id] = await loadImage(URL.createObjectURL(blob));
    }
  }
  return images;
}
function loadImage(src) { return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; }); }

async function drawPreview() {
  if (!state.event) return;
  const canvas = $('previewCanvas'), ctx = canvas.getContext('2d');
  const images = await imageForPreview();
  const fontAssets = state.assets
    .filter((a) => state.payload.fontAssetIds.includes(a.id))
    .map((a) => ({ ...a, buffer: state.localAssets[a.id] }));
  await VowRender.loadFonts(state.payload, fontAssets);
  VowRender.renderPayload(ctx, canvas.width, canvas.height, state.payload, Number($('previewSlide').value || 0), images, { showSafeArea: $('safeToggle').checked });
}

$('runCheck').onclick = async () => {
  try {
    const assetsForFont = state.assets
      .filter((a) => state.payload.fontAssetIds.includes(a.id))
      .map((asset) => ({ ...asset, buffer: state.localAssets[asset.id] }));
    const browserReport = await VowRender.compareTypography(state.payload, assetsForFont, 1280, 720);
    const normalized = await api(`/api/events/${state.event.id}/versions/validate`, {
      method: 'POST', body: { payload: state.payload, typographyReport: browserReport }
    });
    const report = { ...browserReport, payloadChecksum: normalized.payloadChecksum };
    const checked = await api(`/api/events/${state.event.id}/versions/validate`, {
      method: 'POST', body: { payload: state.payload, typographyReport: report }
    });
    state.report = checked.typography.ok ? { ...report, validatedAt: checked.typography.report.validatedAt } : null;
    $('ackFallback').disabled = !report.differences.length || !checked.canPublish;
    $('typoSummary').innerHTML = checked.canPublish
      ? '<span class="good">资源与排版门禁通过</span>'
      : `<span class="bad">${esc(checked.typography.error?.message || '资源未齐')}</span>`;
    $('typoReport').innerHTML = renderTypoReport(report);
  } catch (error) {
    state.report = null;
    $('typoSummary').innerHTML = `<span class="bad">${esc(error.message)}</span>`;
    $('typoReport').innerHTML = `<pre class="mono">${esc(JSON.stringify(error.data || {}, null, 2))}</pre>`;
  }
};
function renderTypoReport(report) {
  const row = (r, mode) => r.slides.map((s) => `<tr><td>${esc(s.locale)} (${mode})</td><td>${s.names.size}/${s.names.lines.length}</td><td>${s.hall.size}/${s.hall.lines.length}</td><td>${s.message.size}/${s.message.lines.length}</td><td>${s.overflow ? '<span class="bad">溢出</span>' : 'OK'}</td><td>${s.safeAreaViolation ? '<span class="bad">越界</span>' : 'OK'}</td><td>${esc(s.missingGlyphs.join(' ') || '无')}</td></tr>`).join('');
  return `<div class="banner ${report.differences.length ? 'warn' : 'good'}">检测到 ${report.differences.length} 项嵌入/回退差异；长名字、多语混排、换行、字形与安全边距均已比较。</div>
  <table><thead><tr><th>语言/模式</th><th>姓名 字号/行</th><th>厅名</th><th>字幕</th><th>溢出</th><th>安全边距</th><th>缺字</th></tr></thead><tbody>${row(report.embedded, '嵌入')}${row(report.fallback, '回退')}</tbody></table>`;
}
$('ackFallback').onchange = () => { if (state.report) state.report.acknowledgedFallback = $('ackFallback').checked; };

function renderPublishTargets() {
  const groupId = $('publishGroup').value || state.groups[0]?.id;
  $('publishDevices').innerHTML = state.devices.filter((d) => d.groupId === groupId).map((device) => `<label class="checkline"><input type="checkbox" class="targetDevice" value="${device.id}"> ${esc(device.name)} — ${device.stale ? '<span class="bad">当前断网（会等待下载完整后切换）</span>' : '<span class="good">在线</span>'}</label>`).join('');
}
$('publishGroup').onchange = renderPublishTargets;

$('publish').onclick = async () => {
  if (!state.report) return alert('先运行排版比对');
  const version = await api(`/api/events/${state.event.id}/versions`, { method: 'POST', body: { payload: state.payload, typographyReport: state.report } }).catch((e) => { throw e; });
  const deviceIds = [...document.querySelectorAll('.targetDevice:checked')].map((input) => input.value);
  if (!deviceIds.length) return alert('必须明确勾选设备清单');
  const scheduledFor = $('scheduledFor').value ? new Date($('scheduledFor').value).toISOString() : null;
  await api(`/api/events/${state.event.id}/releases`, { method: 'POST', body: { versionId: version.id, groupId: $('publishGroup').value, deviceIds, scheduledFor } });
  await loadEvent(state.event.id);
};

function renderReleases() {
  $('resourceGate').className = `banner ${state.versions.length ? 'good' : 'warn'}`;
  $('resourceGate').textContent = state.versions.length ? `已有 ${state.versions.length} 个不可变版本；发布只切换完整下载并校验通过的终端。` : '资源未齐不允许半版切换。';
  $('releaseRows').innerHTML = state.releases.slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).map((release) => {
    const group = state.groups.find((g) => g.id === release.groupId);
    const aligned = release.devices.filter((d) => d.aligned).length;
    const stale = release.devices.filter((d) => d.stale || d.networkStatus !== 'online').map((d) => esc(d.name)).join(', ');
    return `<tr><td><span class="mono">${release.id}</span>${release.rollbackOf ? '<br><span class="warn">安全回退版</span>' : ''}</td><td>${esc(group?.hallName || group?.name || '')}</td><td>${statusPill(release.status)}</td><td>${aligned}/${release.devices.length} 已切换${stale ? `<br><span class="bad">未确认：${stale}</span>` : ''}</td><td>${esc(release.scheduledFor || release.publishedAt || release.createdAt)}</td><td>${release.status === 'scheduled' ? `<button class="cancelRelease" data-id="${release.id}">撤销定时</button>` : ''} ${['active','rollback'].includes(release.status) ? `<button class="rollbackRelease" data-id="${release.id}">回退</button>` : ''}</td></tr>`;
  }).join('');
  document.querySelectorAll('.cancelRelease').forEach((b) => b.onclick = async () => { await api(`/api/releases/${b.dataset.id}/cancel`, { method: 'POST' }); loadEvent(state.event.id); });
  document.querySelectorAll('.rollbackRelease').forEach((b) => b.onclick = async () => { await api(`/api/releases/${b.dataset.id}/rollback`, { method: 'POST', body: { reason: 'manual screenshot proof' } }); loadEvent(state.event.id); });
}

function renderScreenshots() {
  $('screenshots').innerHTML = state.screenshots.slice().reverse().slice(0, 8).map((shot) => {
    const device = state.devices.find((d) => d.id === shot.deviceId);
    return `<div class="card"><div class="spread"><b>${esc(device?.name || shot.deviceId)}</b><span class="small">${esc(shot.createdAt)} · sha256 <span class="mono">${esc(shot.sha256.slice(0,16))}</span></span></div>${shot.dataUrl ? `<img class="shot" src="${shot.dataUrl}" alt="field screenshot">` : '<div class="banner warn">截图正文已按保留策略删除，仅保留校验和与操作凭据</div>'}<div class="small">${esc(shot.note)}</div></div>`;
  }).join('') || '<p class="small">现场窗口按 P 上传截图。</p>';
}
$('revokeSelected').onclick = async () => {
  const ids = [...document.querySelectorAll('.revokeAsset:checked')].map((i) => i.value);
  for (const assetId of ids) await api(`/api/events/${state.event.id}/assets/${assetId}/revoke`, { method: 'POST', body: { reason: '现场撤销授权' } });
  await loadEvent(state.event.id);
};
$('cleanup').onclick = async () => {
  if (!confirm('将删除服务器照片/字体/截图正文，并向终端下发可核验缓存清理。离线终端不会虚报擦除。继续？')) return;
  await api(`/api/events/${state.event.id}/retention/cleanup`, { method: 'POST' });
  await loadEvent(state.event.id);
};
function renderAudits() {
  $('auditRows').innerHTML = state.audits.slice().reverse().slice(0, 30).map((audit) => `<tr><td>${esc(audit.action)}</td><td class="mono">${esc(audit.targetId)}</td><td>${esc(audit.createdAt)}</td><td><pre class="mono">${esc(JSON.stringify(audit.metadata))}</pre></td></tr>`).join('');
}

loadAll().catch((error) => alert(error.stack));
