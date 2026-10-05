import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileTypeFromBuffer } from './node-util.js';
import { db, id, sha256, token, nowIso, parseJson, audit, UPLOAD_DIR } from './db.js';
import { structuralValidation } from './public/layout-core.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';
app.use(express.json({ limit: '2mb' }));
app.use('/vendor/opentype.js', express.static(path.resolve('node_modules/opentype.js/dist/opentype.module.js'), {
  setHeaders: (res) => res.setHeader('Content-Type', 'text/javascript')
}));
app.use(express.static('public', { index: 'admin.html' }));

function asyncRoute(fn) { return (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next); }
function requireAdmin(req,res,next) {
  const given = req.get('x-admin-token') || req.query.adminToken;
  if (given !== ADMIN_TOKEN) return res.status(401).json({ error: '管理令牌无效' });
  next();
}
function getEvent(idOrCode) {
  return db.prepare('SELECT * FROM events WHERE id=? OR code=?').get(idOrCode, idOrCode);
}
function eventAssets(eventId, includePurged = false) {
  return db.prepare(includePurged ? 'SELECT * FROM assets WHERE event_id=?' : 'SELECT * FROM assets WHERE event_id=? AND file_purged=0').all(eventId);
}
function normalizeDesign(x) {
  const d = typeof x === 'string' ? parseJson(x, null) : x;
  if (!d || !Array.isArray(d.slides)) throw Object.assign(new Error('设计 JSON 缺少 slides'), { status: 400 });
  d.canvas = { width: 1920, height: 1080, ...(d.canvas || {}) };
  d.languages = Array.isArray(d.languages) && d.languages.length ? [...new Set(d.languages)] : ['zh-CN'];
  d.slides.forEach((s, i) => {
    if (!s.id) s.id = `slide_${i}_${crypto.randomBytes(4).toString('hex')}`;
    s.focalX = clamp(Number(s.focalX ?? .5), 0, 1);
    s.focalY = clamp(Number(s.focalY ?? .5), 0, 1);
    s.darken = clamp(Number(s.darken ?? .34), 0, .9);
    s.captionPosition = ['top','middle','bottom'].includes(s.captionPosition) ? s.captionPosition : 'bottom';
  });
  return d;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function activeLicense(a, at = new Date()) {
  if (!a || a.revoked || a.file_purged) return false;
  if (a.licensed_from && new Date(a.licensed_from) > at) return false;
  if (a.licensed_until && new Date(a.licensed_until) < at) return false;
  return true;
}
function designAssetIds(design) {
  const ids = new Set();
  for (const s of design.slides || []) if (s.photoAssetId) ids.add(s.photoAssetId);
  return [...ids];
}
function fontAssets(eventId) { return db.prepare("SELECT * FROM assets WHERE event_id=? AND type='font' AND file_purged=0").all(eventId); }
function photosForDesign(eventId, design) {
  const map = new Map(eventAssets(eventId).map(a => [a.id,a]));
  return designAssetIds(design).map(x => map.get(x)).filter(Boolean);
}
function makeManifest(version, design) {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(version.event_id);
  const photos = photosForDesign(version.event_id, design);
  const fonts = version.font_embedded ? fontAssets(version.event_id) : [];
  return {
    schema: 'wedding-welcome/v1',
    event: { id: ev.id, code: ev.code, hall: ev.hall, couple_name: ev.couple_name },
    version: { id: version.id, label: version.label, published_at: version.published_at || nowIso() },
    design,
    assets: [...photos, ...fonts].map(a => ({
      id: a.id, type: a.type, sha256: a.sha256, size: a.size, mime_type: a.mime_type, filename: a.filename,
      license_version: a.license_version,
      license: { scope: a.license_scope, holder: a.license_holder, from: a.licensed_from, until: a.licensed_until, revoked: !!a.revoked }
    })),
    checks: { require_all_assets: true, atomic_activation: true, event_lock: true, font_embedded: !!version.font_embedded }
  };
}
function validatePublish(design, assets, targets, fontEmbedded) {
  const { errors, warnings } = structuralValidation(design, assets);
  const byId = new Map(assets.map(a => [a.id,a]));
  const now = new Date();
  for (const aid of designAssetIds(design)) {
    const a = byId.get(aid);
    if (!a) errors.push(`照片素材 ${aid} 不属于本活动或不存在`);
    else if (a.type !== 'photo') errors.push(`${a.filename} 不是照片`);
    else if (!activeLicense(a, now)) errors.push(`照片 ${a.filename} 缺少有效授权或已撤销`);
  }
  if (fontEmbedded) {
    const fonts = assets.filter(a => a.type === 'font');
    if (!fonts.length) errors.push('选择嵌入字体时必须上传至少一个 TTF/WOFF 字体');
    for (const f of fonts) if (!activeLicense(f, now)) errors.push(`字体 ${f.filename} 缺少有效授权`);
  }
  if (!targets.devices.length && !targets.groups.length) errors.push('发布必须明确设备清单');
  for (const d of targets.devices) {
    if (!d || d.event_id !== design.__eventId) errors.push(`设备 ${d.name} 不属于当前活动，禁止换厅误推`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
function expandTargets(eventId, deviceIds = [], groupIds = []) {
  const devices = new Map();
  for (const did of deviceIds) {
    const d = db.prepare('SELECT * FROM devices WHERE id=? AND active=1').get(did);
    if (d) devices.set(d.id,d);
  }
  if (groupIds.length) {
    const rows = db.prepare(`SELECT d.* FROM devices d JOIN device_groups dg ON dg.device_id=d.id
      WHERE dg.group_id IN (${groupIds.map(()=>'?').join(',')}) AND d.active=1`).all(...groupIds);
    rows.forEach(d => devices.set(d.id,d));
  }
  const eventMismatch = [...devices.values()].filter(d => d.event_id !== eventId && d.pending_event_id !== eventId);
  return { devices: [...devices.values()], groups: groupIds, eventMismatch };
}
function upsertDeviceVersion(deviceId, versionId, state, scheduledAt = null) {
  db.prepare(`INSERT INTO device_versions(device_id,version_id,state,scheduled_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(device_id,version_id) DO UPDATE SET state=excluded.state,
    scheduled_at=COALESCE(excluded.scheduled_at,device_versions.scheduled_at),updated_at=excluded.updated_at`)
    .run(deviceId,versionId,state,scheduledAt,nowIso(),nowIso());
}
function issueDeleteTask(deviceId, scope, eventId, opts = {}) {
  const key = [deviceId, scope, opts.assetSha || '', opts.versionId || '', eventId || ''].join('|');
  db.prepare(`INSERT OR IGNORE INTO delete_tasks(id,event_id,device_id,scope,asset_sha,version_id,status,issued_at,note,task_key)
              VALUES(?,?,?,?,?,?,'pending',?,?,?)`)
    .run(id('del'), eventId, deviceId, scope, opts.assetSha || null, opts.versionId || null, nowIso(), opts.note || '', key);
}
function setActiveVersion(versionId, deviceId, actor = 'system') {
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(versionId);
  const tx = db.transaction(() => {
    db.prepare("UPDATE device_versions SET state='superseded', updated_at=? WHERE device_id=? AND state='active' AND version_id<>?")
      .run(nowIso(), deviceId, versionId);
    db.prepare("UPDATE device_versions SET state='active', updated_at=? WHERE device_id=? AND version_id=?").run(nowIso(), deviceId, versionId);
    audit(actor, 'activate-version', 'device', deviceId, v.event_id, { versionId });
  }); tx();
}
function manifestLicensesValid(v) {
  const manifest=parseJson(v.manifest_json,{});
  for(const item of manifest.assets||[]) {
    const a=db.prepare('SELECT * FROM assets WHERE id=? AND event_id=?').get(item.id,v.event_id)
      || db.prepare('SELECT * FROM assets WHERE sha256=? AND event_id=?').get(item.sha256,v.event_id);
    if(!activeLicense(a)) return false;
  }
  return true;
}
function fallbackCommandForDevice(deviceId) {
  const active = db.prepare(`SELECT dv.*,v.event_id,v.design_json FROM device_versions dv JOIN versions v ON v.id=dv.version_id
    WHERE dv.device_id=? AND dv.state='active'`).get(deviceId);
  if (!active) return null;
  const design = parseJson(active.design_json, {});
  const invalid = designAssetIds(design).some(aid => {
    const a = db.prepare('SELECT * FROM assets WHERE id=?').get(aid);
    return !activeLicense(a);
  });
  if (!invalid) return null;
  const previous = db.prepare(`SELECT dv.version_id FROM device_versions dv JOIN versions v ON v.id=dv.version_id
    WHERE dv.device_id=? AND dv.state='superseded' AND v.status='published' AND v.event_id=?
    ORDER BY dv.updated_at DESC LIMIT 1`).get(deviceId, active.event_id);
  const target = previous?.version_id || 'SAFE_SCREEN';
  db.prepare("UPDATE device_versions SET state='failed',updated_at=? WHERE device_id=? AND version_id=?").run(nowIso(), deviceId, active.version_id);
  if (previous) setActiveVersion(previous.version_id, deviceId, 'license-guard');
  return { type: 'activate', versionId: target, reason: 'photo license revoked; switch only after complete bundle' };
}
function deviceFromReq(req) {
  const t = req.get('x-device-token');
  const device = t && db.prepare('SELECT * FROM devices WHERE device_token=? AND active=1').get(t);
  if (!device) throw Object.assign(new Error('设备令牌无效'), { status: 401 });
  return device;
}

app.get('/api/health', (req,res)=>res.json({ ok:true, now: nowIso() }));
app.get('/api/config', requireAdmin, (req,res)=>res.json({ adminTokenConfigured: true }));

app.get('/api/events', requireAdmin, (req,res)=>res.json(db.prepare('SELECT * FROM events ORDER BY created_at DESC').all()));
app.post('/api/events', requireAdmin, (req,res)=>{
  const { couple_name, hall, language='zh-CN', retention_days=30, starts_at, ends_at } = req.body || {};
  if (!couple_name || !hall) return res.status(400).json({ error:'新人姓名和宴会厅必填' });
  const code = String(req.body.code || crypto.randomBytes(3).toString('hex')).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8) || crypto.randomBytes(3).toString('hex').toUpperCase();
  const e = { id:id('evt'), code, couple_name, hall, default_language:language, retention_days:Number(retention_days)||30, starts_at:starts_at||null, ends_at:ends_at||null, created_at:nowIso(), updated_at:nowIso(), active:1 };
  db.prepare(`INSERT INTO events(id,code,couple_name,hall,default_language,retention_days,starts_at,ends_at,created_at,updated_at,active)
    VALUES(@id,@code,@couple_name,@hall,@default_language,@retention_days,@starts_at,@ends_at,@created_at,@updated_at,@active)`).run(e);
  audit(req.get('x-admin-token').slice(0,8)+'…','create-event','event',e.id,e.id,{ code, hall });
  res.status(201).json(e);
});
app.patch('/api/events/:eventId', requireAdmin, (req,res)=>{
  const ev = getEvent(req.params.eventId); if (!ev) return res.status(404).json({error:'活动不存在'});
  const fields = ['couple_name','hall','default_language','retention_days','starts_at','ends_at','active'];
  const next = { ...ev }; for (const f of fields) if (req.body[f] !== undefined) next[f] = req.body[f];
  next.updated_at = nowIso();
  db.prepare(`UPDATE events SET couple_name=@couple_name,hall=@hall,default_language=@default_language,retention_days=@retention_days,
    starts_at=@starts_at,ends_at=@ends_at,active=@active,updated_at=@updated_at WHERE id=@id`).run(next);
  audit(req.get('x-admin-token').slice(0,8)+'…','update-event','event',ev.id,ev.id,{ fields:Object.keys(req.body).filter(f=>fields.includes(f)) });
  res.json(next);
});

app.get('/api/events/:eventId/assets', requireAdmin, (req,res)=>{
  const ev = getEvent(req.params.eventId); if (!ev) return res.status(404).json({error:'活动不存在'});
  res.json(eventAssets(ev.id,true));
});
app.post('/api/events/:eventId/assets', requireAdmin, asyncRoute(async (req,res)=>{
  const ev = getEvent(req.params.eventId); if (!ev) return res.status(404).json({error:'活动不存在'});
  const raw = Buffer.from(req.body.dataBase64 || '', 'base64');
  if (!raw.length) return res.status(400).json({error:'缺少素材内容'});
  const kind = req.body.type;
  const detected = await fileTypeFromBuffer(raw);
  const mime = req.body.mimeType || detected?.mime || (kind==='font' ? 'font/ttf' : 'application/octet-stream');
  const validPhoto = kind==='photo' && mime.startsWith('image/') && ['image/jpeg','image/png','image/webp','image/svg+xml'].includes(mime);
  const validFont = kind==='font' && ['font/ttf','application/font-ttf','font/otf','font/woff','font/woff2'].includes(mime);
  if (!validPhoto && !validFont) return res.status(400).json({error:`不支持的素材类型 ${mime}`});
  if (raw.length > 25*1024*1024) return res.status(413).json({error:'素材不能超过 25MB'});
  const hash = sha256(raw), filename = req.body.filename || `${kind}-${hash.slice(0,10)}`;
  fs.mkdirSync(path.join(UPLOAD_DIR, ev.id), { recursive:true });
  fs.writeFileSync(path.join(UPLOAD_DIR, ev.id, hash), raw);
  const existing = db.prepare('SELECT * FROM assets WHERE event_id=? AND sha256=?').get(ev.id,hash);
  if (existing) {
    db.prepare('UPDATE assets SET file_purged=0, revoked=0, revoked_at=NULL, license_holder=?, license_scope=?, licensed_from=?, licensed_until=?, license_version=license_version+1 WHERE id=?')
      .run(req.body.licenseHolder||existing.license_holder, req.body.licenseScope||existing.license_scope, req.body.licensedFrom||null, req.body.licensedUntil||null, existing.id);
    audit(req.get('x-admin-token').slice(0,8)+'…','reupload-asset','asset',existing.id,ev.id,{filename, hash, photoBody:false});
    return res.status(200).json(db.prepare('SELECT * FROM assets WHERE id=?').get(existing.id));
  }
  const a = { id:id(kind), event_id:ev.id, type:kind, filename, mime_type:mime, sha256:hash, size:raw.length,
    focal_x:Number(req.body.focalX ?? .5), focal_y:Number(req.body.focalY ?? .5), darken:Number(req.body.darken ?? .34),
    license_scope:req.body.licenseScope || 'event', license_holder:req.body.licenseHolder || '', licensed_from:req.body.licensedFrom||null, licensed_until:req.body.licensedUntil||null,
    license_version:1, revoked:0, revoked_at:null, revoked_reason:null, file_purged:0, created_at:nowIso() };
  db.prepare(`INSERT INTO assets(id,event_id,type,filename,mime_type,sha256,size,focal_x,focal_y,darken,license_scope,license_holder,licensed_from,licensed_until,license_version,revoked,revoked_at,revoked_reason,file_purged,created_at)
    VALUES(@id,@event_id,@type,@filename,@mime_type,@sha256,@size,@focal_x,@focal_y,@darken,@license_scope,@license_holder,@licensed_from,@licensed_until,@license_version,@revoked,@revoked_at,@revoked_reason,@file_purged,@created_at)`).run(a);
  audit(req.get('x-admin-token').slice(0,8)+'…','upload-asset','asset',a.id,ev.id,{filename, hash:a.sha256, size:a.size, license:a.license_scope});
  res.status(201).json(a);
}));
app.patch('/api/assets/:assetId', requireAdmin, (req,res)=>{
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.assetId); if(!a) return res.status(404).json({error:'素材不存在'});
  const fields = ['focalX','focalY','darken','licenseScope','licenseHolder','licensedFrom','licensedUntil'];
  const stmt = db.prepare('UPDATE assets SET focal_x=?,focal_y=?,darken=?,license_scope=?,license_holder=?,licensed_from=?,licensed_until=?,license_version=license_version+1 WHERE id=?');
  stmt.run(clamp(Number(req.body.focalX ?? a.focal_x),0,1), clamp(Number(req.body.focalY ?? a.focal_y),0,1), clamp(Number(req.body.darken ?? a.darken),0,.9),
    req.body.licenseScope ?? a.license_scope, req.body.licenseHolder ?? a.license_holder, req.body.licensedFrom ?? a.licensed_from, req.body.licensedUntil ?? a.licensed_until, a.id);
  audit(req.get('x-admin-token').slice(0,8)+'…','update-asset-meta','asset',a.id,a.event_id,{fields});
  res.json(db.prepare('SELECT * FROM assets WHERE id=?').get(a.id));
});
app.post('/api/assets/:assetId/revoke', requireAdmin, (req,res)=>{
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.assetId); if(!a) return res.status(404).json({error:'素材不存在'});
  db.prepare('UPDATE assets SET revoked=1,revoked_at=?,revoked_reason=?,license_version=license_version+1 WHERE id=?').run(nowIso(), req.body.reason || '授权撤销', a.id);
  const affectedDevices = db.prepare(`SELECT DISTINCT dv.device_id, dv.state, v.id, v.design_json
    FROM device_versions dv JOIN versions v ON v.id=dv.version_id
    WHERE v.event_id=? AND dv.state IN ('assigned','preloading','ready','active')`).all(a.event_id);
  const targetDevices=[];
  for (const row of affectedDevices) {
    const touches = designAssetIds(parseJson(row.design_json,{})).includes(a.id);
    if (touches) {
      issueDeleteTask(row.device_id,'assets',a.event_id,{assetSha:a.sha256,versionId:row.id,note:'照片授权撤销'});
      targetDevices.push(row.device_id);
    }
  }
  audit(req.get('x-admin-token').slice(0,8)+'…','revoke-asset','asset',a.id,a.event_id,{reason:req.body.reason, devices:targetDevices});
  res.json({ ok:true, revokeAt:nowIso(), deviceDeleteCommands:[...new Set(targetDevices)] });
});
app.get('/api/admin/assets/:assetId/download', requireAdmin, (req,res)=>{
  const a = db.prepare('SELECT * FROM assets WHERE id=?').get(req.params.assetId);
  if (!a || a.file_purged) return res.status(404).json({error:'素材文件已清理'});
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-License-Version', a.license_version);
  res.type(a.mime_type).sendFile(path.join(UPLOAD_DIR, a.event_id, a.sha256));
});

app.get('/api/devices', requireAdmin, (req,res)=>{
  const rows = db.prepare(`SELECT d.*, e.code event_code, e.couple_name event_couple,
    (SELECT v.id FROM device_versions dv JOIN versions v ON v.id=dv.version_id WHERE dv.device_id=d.id AND dv.state='active' LIMIT 1) active_version_id
    FROM devices d LEFT JOIN events e ON e.id=d.event_id ORDER BY d.registered_at DESC`).all();
  res.json(rows);
});
app.post('/api/devices', requireAdmin, (req,res)=>{
  const { name, hall, resolution='1920x1080' } = req.body || {};
  if (!name || !hall) return res.status(400).json({error:'设备名和会场必填'});
  const d = { id:id('dev'), event_id:null, pending_event_id:null, name, hall, resolution, device_token:token(), registered_at:nowIso(), last_seen_at:null, last_ip:null, active:1 };
  db.prepare(`INSERT INTO devices(id,event_id,pending_event_id,name,hall,device_token,resolution,registered_at,last_seen_at,last_ip,active)
    VALUES(@id,@event_id,@pending_event_id,@name,@hall,@device_token,@resolution,@registered_at,@last_seen_at,@last_ip,@active)`).run(d);
  audit(req.get('x-admin-token').slice(0,8)+'…','register-device','device',d.id,null,{name,hall});
  res.status(201).json(d);
});
app.post('/api/devices/:deviceId/bind-event', requireAdmin, (req,res)=>{
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.deviceId);
  const ev = getEvent(req.body.eventId);
  if (!d || !ev) return res.status(404).json({error:'设备或活动不存在'});
  const requireWipe = d.event_id && d.event_id !== ev.id;
  db.prepare('UPDATE devices SET pending_event_id=?, hall=?, updated_at=? WHERE id=?').run(ev.id, ev.hall, nowIso(), d.id);
  if (requireWipe) {
    issueDeleteTask(d.id,'event',d.event_id,{note:`换厅前擦除 ${d.event_id}，确认后才能绑定 ${ev.id}`});
  } else {
    db.prepare('UPDATE devices SET event_id=?, pending_event_id=NULL, hall=?, updated_at=? WHERE id=?').run(ev.id, ev.hall, nowIso(), d.id);
  }
  audit(req.get('x-admin-token').slice(0,8)+'…','request-device-bind','device',d.id,ev.id,{from:d.event_id,to:ev.id,gated:requireWipe});
  res.json({ ok:true, pending_event_id:ev.id, wipeRequired:requireWipe, status:requireWipe?'awaiting-provable-wipe':'ready' });
});
app.get('/api/events/:eventId/groups', requireAdmin, (req,res)=>{
  const ev = getEvent(req.params.eventId); if (!ev) return res.status(404).json({error:'活动不存在'});
  const groups = db.prepare('SELECT * FROM groups WHERE event_id=? ORDER BY created_at').all(ev.id);
  res.json(groups.map(g=>({...g, devices: db.prepare(`SELECT d.* FROM devices d JOIN device_groups dg ON dg.device_id=d.id WHERE dg.group_id=?`).all(g.id)})));
});
app.post('/api/events/:eventId/groups', requireAdmin, (req,res)=>{
  const ev = getEvent(req.params.eventId); if (!ev) return res.status(404).json({error:'活动不存在'});
  const g={id:id('grp'),event_id:ev.id,name:req.body.name || '新屏幕组',created_at:nowIso()};
  db.prepare('INSERT INTO groups(id,event_id,name,created_at) VALUES(?,?,?,?)').run(g.id,g.event_id,g.name,g.created_at);
  if (Array.isArray(req.body.deviceIds)) {
    for (const did of req.body.deviceIds) {
      const d=db.prepare('SELECT * FROM devices WHERE id=?').get(did);
      if (d && (d.event_id===ev.id || d.pending_event_id===ev.id)) db.prepare('INSERT OR IGNORE INTO device_groups(device_id,group_id) VALUES(?,?)').run(did,g.id);
    }
  }
  audit(req.get('x-admin-token').slice(0,8)+'…','create-group','group',g.id,ev.id,{name:g.name,devices:req.body.deviceIds||[]});
  res.status(201).json(g);
});

app.get('/api/events/:eventId/versions', requireAdmin,(req,res)=>{
  const ev=getEvent(req.params.eventId); if(!ev)return res.status(404).json({error:'活动不存在'});
  const versions=db.prepare('SELECT * FROM versions WHERE event_id=? ORDER BY created_at DESC').all(ev.id);
  res.json(versions.map(v=>({...v,design_json:parseJson(v.design_json,{}),manifest_json:parseJson(v.manifest_json,{}),
    devices:db.prepare(`SELECT d.*,dv.state,dv.scheduled_at FROM devices d JOIN device_versions dv ON dv.device_id=d.id WHERE dv.version_id=?`).all(v.id),
    groups:db.prepare(`SELECT g.* FROM groups g JOIN version_groups vg ON vg.group_id=g.id WHERE vg.version_id=?`).all(v.id)
  })));
});
app.post('/api/events/:eventId/versions/draft', requireAdmin,(req,res)=>{
  const ev=getEvent(req.params.eventId); if(!ev)return res.status(404).json({error:'活动不存在'});
  const design=normalizeDesign(req.body.design);
  const v={id:id('ver'),event_id:ev.id,label:req.body.label || `草稿 ${new Date().toLocaleString()}`,design_json:JSON.stringify(design),
    font_embedded:req.body.fontEmbedded === false ? 0 : 1,status:'draft',manifest_json:'{}',published_at:null,created_at:nowIso(),updated_at:nowIso()};
  db.prepare(`INSERT INTO versions(id,event_id,label,design_json,font_embedded,status,manifest_json,published_at,created_at,updated_at)
    VALUES(@id,@event_id,@label,@design_json,@font_embedded,@status,@manifest_json,@published_at,@created_at,@updated_at)`).run(v);
  audit(req.get('x-admin-token').slice(0,8)+'…','save-draft','version',v.id,ev.id,{label:v.label,slides:design.slides.length});
  res.status(201).json({...v,design_json:design});
});
app.patch('/api/versions/:versionId', requireAdmin,(req,res)=>{
  const v=db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.versionId); if(!v)return res.status(404).json({error:'版本不存在'});
  if(v.status!=='draft') return res.status(409).json({error:'已发布版本不可修改；请复制为新版本'});
  const design=normalizeDesign(req.body.design ?? parseJson(v.design_json,{}));
  const fontEmbedded=req.body.fontEmbedded===false?0:1;
  db.prepare('UPDATE versions SET label=?,design_json=?,font_embedded=?,updated_at=? WHERE id=?')
    .run(req.body.label || v.label, JSON.stringify(design), fontEmbedded, nowIso(), v.id);
  audit(req.get('x-admin-token').slice(0,8)+'…','update-draft','version',v.id,v.event_id,{fontEmbedded:!!fontEmbedded});
  res.json(db.prepare('SELECT * FROM versions WHERE id=?').get(v.id));
});
app.post('/api/versions/:versionId/publish', requireAdmin,(req,res)=>{
  const v=db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.versionId); if(!v)return res.status(404).json({error:'版本不存在'});
  if(!['draft','scheduled','ready'].includes(v.status)) return res.status(409).json({error:'当前版本状态不能发布'});
  const ev=db.prepare('SELECT * FROM events WHERE id=?').get(v.event_id);
  const design=normalizeDesign(parseJson(v.design_json,{})); design.__eventId=ev.id;
  const {devices,eventMismatch}=expandTargets(v.event_id,req.body.deviceIds||[],req.body.groupIds||[]);
  const allAssets=eventAssets(v.event_id,true);
  const result=validatePublish(design,allAssets,{devices,groups:req.body.groupIds||[]},!!v.font_embedded);
  if(eventMismatch.length) result.errors.push(`设备 ${eventMismatch.map(d=>d.name).join(',')} 未绑定本活动`);
  if(result.errors.length) return res.status(422).json({error:'发布被阻止：资源或设备清单未齐',errors:result.errors,warnings:result.warnings});
  const status=req.body.scheduledAt && new Date(req.body.scheduledAt)>new Date() ? 'scheduled' : 'published';
  const publicDesign = { ...design, slides: design.slides.map(({...s})=>s) };
  delete publicDesign.__eventId;
  const manifest=makeManifest({...v,font_embedded:v.font_embedded,published_at:status==='published'?nowIso():v.published_at},publicDesign);
  const tx=db.transaction(()=>{
    db.prepare("UPDATE versions SET status=?,manifest_json=?,published_at=COALESCE(published_at,?),updated_at=? WHERE id=?")
      .run(status,JSON.stringify(manifest),nowIso(),nowIso(),v.id);
    db.prepare('DELETE FROM version_devices WHERE version_id=?').run(v.id);
    db.prepare('DELETE FROM version_groups WHERE version_id=?').run(v.id);
    for(const d of devices) db.prepare('INSERT OR IGNORE INTO version_devices(version_id,device_id) VALUES(?,?)').run(v.id,d.id);
    for(const gid of req.body.groupIds||[]) db.prepare('INSERT OR IGNORE INTO version_groups(version_id,group_id) VALUES(?,?)').run(v.id,gid);
    for(const d of devices) {
      const state=status==='published' ? 'assigned' : 'preloading';
      upsertDeviceVersion(d.id,v.id,state,req.body.scheduledAt||null);
    }
  }); tx();
  audit(req.get('x-admin-token').slice(0,8)+'…',status==='published'?'publish-version':'schedule-version','version',v.id,v.event_id,
    {scheduledAt:req.body.scheduledAt||null,deviceCount:devices.length,devices:devices.map(d=>({id:d.id,name:d.name,hall:d.hall})),manifestAssetCount:manifest.assets.length,fontEmbedded:!!v.font_embedded});
  res.status(201).json({ok:true,status,versionId:v.id,warnings:result.warnings,deviceCount:devices.length});
});
app.post('/api/versions/:versionId/cancel',requireAdmin,(req,res)=>{
  const v=db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.versionId); if(!v)return res.status(404).json({error:'版本不存在'});
  if(!['draft','ready','scheduled'].includes(v.status)) return res.status(409).json({error:'已激活发布只能通过回退处理，不能直接取消'});
  const wasScheduled=v.status==='scheduled';
  const manifest=parseJson(v.manifest_json,{});
  db.prepare("UPDATE versions SET status='canceled',updated_at=? WHERE id=?").run(nowIso(),v.id);
  db.prepare("UPDATE device_versions SET state='superseded',updated_at=? WHERE version_id=? AND state IN ('assigned','preloading','ready')").run(nowIso(),v.id);
  for(const row of db.prepare('SELECT device_id FROM version_devices WHERE version_id=?').all(v.id)) {
    for(const asset of manifest.assets||[]) issueDeleteTask(row.device_id,'assets',v.event_id,{assetSha:asset.sha256,versionId:v.id,note:wasScheduled?'撤销定时发布':'撤销未发布版本'});
  }
  audit(req.get('x-admin-token').slice(0,8)+'…','cancel-version','version',v.id,v.event_id,{wasScheduled});
  res.json({ok:true, cleanupIssued:true});
});
app.post('/api/versions/:versionId/rollback',requireAdmin,(req,res)=>{
  const target=db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.versionId); if(!target)return res.status(404).json({error:'版本不存在'});
  const devices=expandTargets(target.event_id,req.body.deviceIds||[],req.body.groupIds||[]).devices;
  if(!devices.length)return res.status(400).json({error:'回退必须明确设备清单'});
  for(const d of devices){
    const has=db.prepare('SELECT * FROM version_devices WHERE version_id=? AND device_id=?').get(target.id,d.id);
    if(!has)return res.status(422).json({error:`设备 ${d.name} 没有完整版本清单，禁止半版回退`});
  }
  for(const d of devices) setActiveVersion(target.id,d.id,req.get('x-admin-token').slice(0,8)+'…');
  res.json({ok:true,rolledBackTo:target.id,deviceCount:devices.length});
});

app.post('/api/device/register', express.json(), (req,res)=>{
  const { name, hall, resolution } = req.body || {};
  const d={id:id('dev'),event_id:null,pending_event_id:null,name:name||`现场屏 ${crypto.randomBytes(2).toString('hex')}`,hall:hall||'未分配会场',resolution:resolution||'1920x1080',device_token:token(),registered_at:nowIso(),last_seen_at:nowIso(),last_ip:req.ip,active:1};
  db.prepare(`INSERT INTO devices(id,event_id,pending_event_id,name,hall,device_token,resolution,registered_at,last_seen_at,last_ip,active)
    VALUES(@id,@event_id,@pending_event_id,@name,@hall,@device_token,@resolution,@registered_at,@last_seen_at,@last_ip,@active)`).run(d);
  audit('device-self','register-device','device',d.id,null,{name:d.name,hall:d.hall});
  res.status(201).json(d);
});
app.get('/api/device/proofs/:proofId/raw', requireAdmin,(req,res)=>{
  const p=db.prepare('SELECT * FROM proofs WHERE id=?').get(req.params.proofId);
  if(!p || p.file_purged)return res.status(404).json({error:'校对截图已按保留策略清理'});
  const file=path.join(UPLOAD_DIR,p.event_id,'proofs',p.sha256);
  if(!fs.existsSync(file))return res.status(404).json({error:'截图文件缺失'});
  res.setHeader('Cache-Control','no-store').type('image/png').sendFile(file);
});
app.post('/api/device/heartbeat',(req,res)=>{
  let device;
  try { device=deviceFromReq(req); } catch(e){return res.status(e.status||400).json({error:e.message});}
  db.prepare('UPDATE devices SET last_seen_at=?,last_ip=?,resolution=? WHERE id=?').run(nowIso(),req.ip,req.body.resolution||device.resolution,device.id);
  res.json({ok:true,serverTime:nowIso(),device:{...device,last_seen_at:nowIso()}});
});
app.get('/api/device/commands',(req,res)=>{
  let device;
  try { device=deviceFromReq(req); } catch(e){return res.status(e.status||400).json({error:e.message});}
  db.prepare('UPDATE devices SET last_seen_at=?,last_ip=? WHERE id=?').run(nowIso(),req.ip,device.id);
  const commands=[];
  const gate=db.prepare("SELECT * FROM delete_tasks WHERE device_id=? AND status='pending' AND scope='event' ORDER BY issued_at LIMIT 1").get(device.id);
  if(device.pending_event_id && device.pending_event_id!==device.event_id && gate) {
    commands.push({type:'wipe', taskId:gate.id, scope:'event', eventId:gate.event_id, reason:gate.note, then:'report'});
    return res.json({serverTime:nowIso(),event:{id:device.event_id,pendingId:device.pending_event_id,hall:device.hall},activeVersionId:null,commands});
  }
  const licenseFallback=fallbackCommandForDevice(device.id);
  if(licenseFallback) commands.push(licenseFallback);
  const now=new Date();
  const due=db.prepare(`SELECT dv.*, v.status,v.manifest_json,v.event_id,v.label FROM device_versions dv
    JOIN versions v ON v.id=dv.version_id WHERE dv.device_id=? AND dv.state IN ('assigned','preloading','ready')
    ORDER BY dv.scheduled_at IS NOT NULL DESC, dv.scheduled_at ASC, dv.created_at ASC`).all(device.id);
  for(const row of due){
    if(row.event_id!==device.event_id) continue;
    if(!manifestLicensesValid(row) && row.state!=='active') {
      db.prepare("UPDATE device_versions SET state='failed',updated_at=? WHERE device_id=? AND version_id=?").run(nowIso(),device.id,row.version_id);
      if(row.status==='scheduled') db.prepare("UPDATE versions SET status='canceled',updated_at=? WHERE id=? AND status='scheduled'").run(nowIso(),row.version_id);
      commands.push({type:'safe-screen',reason:'unactivated release blocked: revoked or expired license'});
      continue;
    }
    if(row.state==='assigned' || (row.scheduled_at && now>=new Date(row.scheduled_at))) {
      commands.push({type:'prepare-and-activate',versionId:row.version_id,eventId:row.event_id,reason:row.state==='assigned'?'immediate-publish':'scheduled-due'});
    } else if(row.scheduled_at && now<new Date(row.scheduled_at)) {
      commands.push({type:'preload',versionId:row.version_id,eventId:row.event_id,scheduledAt:row.scheduled_at});
    }
  }
  for(const t of db.prepare("SELECT * FROM delete_tasks WHERE device_id=? AND status IN ('pending','acked') ORDER BY issued_at").all(device.id)) {
    if(t.scope==='event' && commands.some(c=>c.taskId===t.id)) continue;
    commands.push({type:'wipe',taskId:t.id,scope:t.scope,eventId:t.event_id,assetSha:t.asset_sha,versionId:t.version_id,reason:t.note});
  }
  const active=db.prepare(`SELECT v.* FROM device_versions dv JOIN versions v ON v.id=dv.version_id WHERE dv.device_id=? AND dv.state='active'`).get(device.id);
  res.json({serverTime:nowIso(),event:{id:device.event_id,pendingId:device.pending_event_id,hall:device.hall},activeVersionId:active?.id||null,commands:[...dedupeCommands(commands)]});
});
function dedupeCommands(commands){
  const seen=new Set(); return commands.filter(c=>{const k=JSON.stringify(c);if(seen.has(k))return false;seen.add(k);return true;});
}
app.get('/api/device/manifest/:versionId',(req,res)=>{
  let device; try{device=deviceFromReq(req)}catch(e){return res.status(e.status||400).json({error:e.message})}
  const v=db.prepare('SELECT * FROM versions WHERE id=?').get(req.params.versionId);
  const target=v&&db.prepare('SELECT * FROM version_devices WHERE version_id=? AND device_id=?').get(v.id,device.id);
  if(!v||!target)return res.status(404).json({error:'该设备清单中不存在此版本'});
  if(v.event_id!==device.event_id || (device.pending_event_id && device.pending_event_id!==v.event_id))return res.status(409).json({error:'活动身份不匹配，拒绝跨会场素材'});
  if(!['ready','scheduled','published','superseded'].includes(v.status) && !db.prepare("SELECT * FROM device_versions WHERE device_id=? AND version_id=? AND state IN ('assigned','preloading')").get(device.id,v.id))
    return res.status(409).json({error:'版本尚未就绪'});
  const manifest=parseJson(v.manifest_json,null);
  if(!manifest)return res.status(409).json({error:'清单未生成'});
  res.setHeader('Cache-Control','no-store').json(manifest);
});
app.get('/api/device/asset/:sha256',(req,res)=>{
  let device; try{device=deviceFromReq(req)}catch(e){return res.status(e.status||400).json({error:e.message})}
  const versionId=req.query.version;
  const v=versionId&&db.prepare('SELECT * FROM versions WHERE id=? AND event_id=?').get(versionId,device.event_id);
  if(!v)return res.status(404).json({error:'只能通过已绑定活动的版本获取素材'});
  const manifest=parseJson(v.manifest_json,{});
  const item=(manifest.assets||[]).find(a=>a.sha256===req.params.sha256);
  if(!item)return res.status(403).json({error:'素材不在当前设备版本清单内'});
  const a=db.prepare('SELECT * FROM assets WHERE sha256=? AND event_id=?').get(item.sha256,device.event_id);
  if(!a||a.file_purged)return res.status(404).json({error:'素材文件不可用'});
  if(!activeLicense(a))return res.status(403).json({error:'授权已撤销，终端不得获取'});
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-License-Version',String(a.license_version));
  res.type(a.mime_type).sendFile(path.join(UPLOAD_DIR,a.event_id,a.sha256));
});
app.post('/api/device/version-state',(req,res)=>{
  let device; try{device=deviceFromReq(req)}catch(e){return res.status(e.status||400).json({error:e.message})}
  const {versionId,state,scheduledAt,metrics}=req.body||{};
  const v=db.prepare('SELECT * FROM versions WHERE id=? AND event_id=?').get(versionId,device.event_id);
  const target=v&&db.prepare('SELECT * FROM version_devices WHERE version_id=? AND device_id=?').get(versionId,device.id);
  if(!v||!target)return res.status(404).json({error:'设备清单中无此版本'});
  if(!['preloading','ready','failed','active'].includes(state))return res.status(400).json({error:'状态无效'});
  if(state==='active'){
    const manifest=parseJson(v.manifest_json,{});
    const allDownloaded=Array.isArray(metrics?.downloaded) && manifest.assets?.every(a=>metrics.downloaded.includes(a.sha256));
    const hashOk=metrics?.hashVerified===true;
    const eventLock=metrics?.eventId===v.event_id;
    if(!manifestLicensesValid(v)) return res.status(403).json({error:'授权已撤销或过期，禁止切换到该版本'});
    if(!allDownloaded||!hashOk||!eventLock)return res.status(409).json({error:'拒绝半版切换：资源、哈希或活动身份未齐',allDownloaded,hashOk,eventLock});
    setActiveVersion(versionId,device.id,'device');
    if(v.status==='scheduled') db.prepare("UPDATE versions SET status='published',published_at=?,updated_at=? WHERE id=?").run(nowIso(),nowIso(),versionId);
  } else {
    upsertDeviceVersion(device.id,versionId,state,scheduledAt||null);
  }
  audit('device','report-version-state','version',versionId,v.event_id,{deviceId:device.id,state,metrics:metrics||{}});
  res.json({ok:true,state});
});
app.post('/api/device/proof',(req,res)=>{
  let device; try{device=deviceFromReq(req)}catch(e){return res.status(e.status||400).json({error:e.message})}
  const {versionId,slideIndex,kind='synthetic',dataBase64,metrics={}}=req.body||{};
  const v=db.prepare('SELECT * FROM versions WHERE id=? AND event_id=?').get(versionId,device.event_id);
  if(!v)return res.status(404).json({error:'版本不属于当前活动'});
  const raw=Buffer.from(dataBase64.split(',')[1]||dataBase64,'base64');
  if(!raw.length||raw.length>8*1024*1024)return res.status(400).json({error:'截图无效或过大'});
  const hash=crypto.createHash('sha256').update(raw).digest('hex');
  fs.mkdirSync(path.join(UPLOAD_DIR,v.event_id,'proofs'),{recursive:true});
  fs.writeFileSync(path.join(UPLOAD_DIR,v.event_id,'proofs',hash),raw);
  const p={id:id('proof'),event_id:v.event_id,device_id:device.id,version_id:versionId,slide_index:Number(slideIndex)||0,kind,sha256:hash,size:raw.length,width:metrics.width||1920,height:metrics.height||1080,metrics_json:JSON.stringify(metrics),status:metrics.autoStatus||'pending',created_at:nowIso(),reviewed_at:null,file_purged:0};
  db.prepare(`INSERT INTO proofs(id,event_id,device_id,version_id,slide_index,kind,sha256,size,width,height,metrics_json,status,created_at,reviewed_at,file_purged)
    VALUES(@id,@event_id,@device_id,@version_id,@slide_index,@kind,@sha256,@size,@width,@height,@metrics_json,@status,@created_at,@reviewed_at,@file_purged)`).run(p);
  audit('device','upload-proof','proof',p.id,v.event_id,{deviceId:device.id,slideIndex:p.slide_index,kind,sha:hash,metrics});
  res.status(201).json({proofId:p.id,sha256:hash,status:p.status});
});
app.post('/api/device/wipe-report',(req,res)=>{
  let device; try{device=deviceFromReq(req)}catch(e){return res.status(e.status||400).json({error:e.message})}
  const {taskId,status='deleted',proofSha,deleted=[],notDeleted=[],note}=req.body||{};
  const t=db.prepare('SELECT * FROM delete_tasks WHERE id=? AND device_id=?').get(taskId,device.id);
  if(!t)return res.status(404).json({error:'删除任务不存在或不属于该设备'});
  if(status==='deleted' && !proofSha)return res.status(400).json({error:'已删除必须提交可验证的擦除证明哈希'});
  const safeStatus=status==='deleted'?'deleted':(notDeleted.length?'pending':'acked');
  db.prepare('UPDATE delete_tasks SET status=?,completed_at=?,proof_sha=?,note=? WHERE id=?')
    .run(safeStatus,status==='deleted'?nowIso():null,proofSha||null,JSON.stringify({note,deleted,notDeleted}),t.id);
  audit('device','wipe-report','delete_task',t.id,t.event_id,{status:safeStatus,proofSha,deleted,notDeleted,note});
  let promoted=false;
  if(safeStatus==='deleted' && t.scope==='event' && device.pending_event_id && device.pending_event_id!==device.event_id && t.event_id===device.event_id) {
    db.prepare('UPDATE devices SET event_id=?, pending_event_id=NULL, hall=(SELECT hall FROM events WHERE id=?), updated_at=? WHERE id=?')
      .run(device.pending_event_id, device.pending_event_id, nowIso(), device.id);
    promoted=true;
    audit('device','complete-device-bind','device',device.id,device.pending_event_id,{wipedEventId:device.event_id,proofSha});
  }
  res.json({ok:true,status:safeStatus,promoted,serverAcknowledgedOnly:false});
});

app.get('/api/events/:eventId/proofs',requireAdmin,(req,res)=>{
  const ev=getEvent(req.params.eventId);if(!ev)return res.status(404).json({error:'活动不存在'});
  res.json(db.prepare(`SELECT p.*,d.name device_name,v.label version_label FROM proofs p
    JOIN devices d ON d.id=p.device_id JOIN versions v ON v.id=p.version_id
    WHERE p.event_id=? ORDER BY p.created_at DESC LIMIT 200`).all(ev.id).map(p=>({...p,metrics_json:parseJson(p.metrics_json,{})})));
});
app.post('/api/proofs/:proofId/review',requireAdmin,(req,res)=>{
  const p=db.prepare('SELECT * FROM proofs WHERE id=?').get(req.params.proofId);if(!p)return res.status(404).json({error:'截图不存在'});
  const status=req.body.status==='approved'?'approved':req.body.status==='rejected'?'rejected':'pending';
  db.prepare('UPDATE proofs SET status=?,reviewed_at=? WHERE id=?').run(status,nowIso(),p.id);
  audit(req.get('x-admin-token').slice(0,8)+'…','review-proof','proof',p.id,p.event_id,{status,comment:req.body.comment||''});
  res.json({ok:true,status});
});
app.get('/api/events/:eventId/audits',requireAdmin,(req,res)=>{
  const ev=getEvent(req.params.eventId);if(!ev)return res.status(404).json({error:'活动不存在'});
  res.json(db.prepare('SELECT id,event_id,actor,action,target_type,target_id,detail_json,photo_body_included,created_at FROM audits WHERE event_id=? ORDER BY created_at DESC LIMIT 500').all(ev.id).map(a=>({...a,detail_json:parseJson(a.detail_json,{})})));
});
app.get('/api/events/:eventId/status',requireAdmin,(req,res)=>{
  const ev=getEvent(req.params.eventId);if(!ev)return res.status(404).json({error:'活动不存在'});
  res.json({
    event:ev,
    devices:db.prepare(`SELECT d.*,(SELECT state FROM device_versions dv WHERE dv.device_id=d.id AND dv.version_id IN
      (SELECT id FROM versions WHERE event_id=?) ORDER BY updated_at DESC LIMIT 1) state FROM devices d
      WHERE d.event_id=? OR d.pending_event_id=?`).all(ev.id,ev.id,ev.id),
    deleteTasks:db.prepare('SELECT * FROM delete_tasks WHERE event_id=? ORDER BY issued_at DESC').all(ev.id),
    proofs:db.prepare('SELECT id,device_id,version_id,slide_index,kind,status,sha256,size,metrics_json,created_at FROM proofs WHERE event_id=? ORDER BY created_at DESC LIMIT 50').all(ev.id).map(p=>({...p,metrics_json:parseJson(p.metrics_json,{})}))
  });
});
app.post('/api/events/:eventId/cleanup',requireAdmin,(req,res)=>{
  const ev=getEvent(req.params.eventId);if(!ev)return res.status(404).json({error:'活动不存在'});
  const result=cleanupEvent(ev, req.body.dryRun === false ? false : true);
  res.json(result);
});
function cleanupEvent(ev, dryRun=true) {
  const retentionDays=Number(ev.retention_days||30);
  const ended=ev.ends_at ? new Date(ev.ends_at) : null;
  const releaseAt=ended ? new Date(ended.getTime()+retentionDays*864e5) : null;
  const ready=!!releaseAt && new Date()>=releaseAt;
  const assets=db.prepare('SELECT * FROM assets WHERE event_id=? AND file_purged=0').all(ev.id);
  const proofs=db.prepare('SELECT * FROM proofs WHERE event_id=? AND file_purged=0').all(ev.id);
  const devices=db.prepare('SELECT id,name,event_id FROM devices WHERE event_id=? OR pending_event_id=?').all(ev.id,ev.id);
  if(!dryRun && ready){
    const tx=db.transaction(()=>{
      for(const a of assets){
        const f=path.join(UPLOAD_DIR,ev.id,a.sha256); if(fs.existsSync(f))fs.rmSync(f,{force:true});
        db.prepare('UPDATE assets SET file_purged=1 WHERE id=?').run(a.id);
      }
      const proofDir=path.join(UPLOAD_DIR,ev.id,'proofs');
      for(const p of proofs){const f=path.join(proofDir,p.sha256);fs.rmSync(f,{force:true});db.prepare('UPDATE proofs SET file_purged=1 WHERE id=?').run(p.id);}
      for(const d of devices) issueDeleteTask(d.id,'event',ev.id,{note:'活动结束，按保留策略清理照片缓存'});
      audit('retention-policy','cleanup-event','event',ev.id,ev.id,{purgedAssets:assets.map(a=>({id:a.id,sha256:a.sha256,filename:a.filename})),purgedProofCount:proofs.length,auditAndLicenseRecordsKept:true,photoBodyIncluded:0});
    }); tx();
  }
  return {ready,dryRun,retentionDays,releaseAt:releaseAt?.toISOString()||null,assets:assets.length,proofs:proofs.length,offlineCaches:'delete command retained; management remains unconfirmed until device proof arrives',credentials:'audit log and license metadata retained without photo bytes'};
}
setInterval(()=>{
  for(const ev of db.prepare('SELECT * FROM events WHERE active=1').all()) cleanupEvent(ev,false);
},60*60*1000).unref();

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(err.status||500).json({error:err.message||'服务器错误'});
});
app.listen(PORT,()=>console.log(`Wedding welcome station listening on http://localhost:${PORT}`));
