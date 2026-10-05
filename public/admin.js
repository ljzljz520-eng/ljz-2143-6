import { defaultDesign, renderSlide, structuralValidation, wrapText, FALLBACK_STACK, localized } from './layout-core.js?v=1';
const $=s=>document.querySelector(s);
const apiBase='';
let token=localStorage.getItem('adminToken')||'dev-admin-token'; $('#adminToken').value=token;
let state={event:null,events:[],assets:[],devices:[],groups:[],versions:[],proofs:[],status:null,design:defaultDesign(),selectedPhotoId:'',fontFont:null,fontBuffer:null};
$('#login').onclick=()=>{token=$('#adminToken').value.trim();localStorage.setItem('adminToken',token);loadAll()};
async function api(path,opts={}){const r=await fetch(apiBase+path,{...opts,headers:{'X-Admin-Token':token,'Content-Type':'application/json',...(opts.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`HTTP ${r.status} ${JSON.stringify(j.errors||[])}`);return j}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmt(s){return s?new Date(s).toLocaleString():'-'}
function slide(){return state.design.slides[0]}
async function loadAll(){try{$('#editorError').textContent='';state.events=await api('/api/events');renderEvents();if(state.event)await loadEvent()}catch(e){$('#editorError').textContent=e.message}}
async function loadEvent(){const id=state.event.id;[state.assets,state.devices,state.groups,state.versions,state.status,state.proofs]=await Promise.all([
  api(`/api/events/${id}/assets`),api('/api/devices'),api(`/api/events/${id}/groups`),api(`/api/events/${id}/versions`),api(`/api/events/${id}/status`),api(`/api/events/${id}/proofs`)]);
const draft=state.versions.find(v=>v.status==='draft');if(draft){state.design=draft.design_json}else{syncDesignFromEvent()}
state.selectedPhotoId=slide().photoAssetId;renderAll();loadEmbeddedFont();renderPreview()}
$('#eventSelect').onchange=e=>{state.event=state.events.find(x=>x.id===e.target.value);loadEvent()};
$('#createEvent').onclick=async()=>{const e=await api('/api/events',{method:'POST',body:JSON.stringify({couple_name:$('#couple').value,hall:$('#hall').value,starts_at:toIso($('#starts').value),ends_at:toIso($('#ends').value),retention_days:Number($('#retention').value)||30})});state.event=e;await loadAll()};
function toIso(v){return v?new Date(v).toISOString():null}
function renderEvents(){$('#eventSelect').innerHTML=state.events.map(e=>`<option value="${e.id}" ${state.event?.id===e.id?'selected':''}>${esc(e.couple_name)} · ${esc(e.hall)} · ${e.code}</option>`).join('');if(state.event){$('#couple').value=state.event.couple_name;$('#hall').value=state.event.hall}}
function renderAll(){renderAssets();renderDevices();renderGroups();renderTargets();renderVersions();renderStatus();renderProofs();renderAudits()}
function renderStatus(){if(!state.status)return;const tasks=state.status.deleteTasks||[];$('#cleanup').innerHTML=`<div>${state.status.devices.map(d=>`<div class="device">${esc(d.name)} <span class="pill">${esc(d.state||'idle')}</span></div>`).join('')}</div><h3>擦除任务（离线不虚报）</h3>${tasks.map(t=>`<div class="device">${esc(t.scope)} <span class="${t.status==='deleted'?'ok':'warn'}">${t.status}</span><div class="muted">${fmt(t.issued_at)} ${t.proof_sha?'证明 '+esc(t.proof_sha.slice(0,12)):'尚无证明'}</div></div>`).join('')||'<p class="muted">无待确认任务</p>'}`}
function renderAssets(){const font=state.assets.find(a=>a.type==='font'&&!a.file_purged);$('#assets').innerHTML=state.assets.map(a=>`<div class="asset">${a.type==='photo'?`<img src="/api/admin/assets/${a.id}/download?adminToken=${encodeURIComponent(token)}">`:'<b style="width:72px;text-align:center">字体</b>'}<div class="grow"><b>${esc(a.filename)}</b><br><span class="pill">${a.type}</span> ${a.revoked?'<span class="bad">已撤销</span>':'<span class="ok">授权有效</span>'}<div class="muted">${esc(a.license_holder||'未填授权方')} · v${a.license_version} · ${a.licensed_until?esc(a.licensed_until.slice(0,10)):'长期'}</div></div>${a.type==='photo'?`<button onclick="selectPhoto('${a.id}')">${state.selectedPhotoId===a.id?'已用':'使用'}</button>`:''}<button class="danger" onclick="revokeAsset('${a.id}')">撤销</button></div>`).join('')}
window.selectPhoto=id=>{state.selectedPhotoId=id;slide().photoAssetId=id;renderAssets();renderPreview()};
window.revokeAsset=async id=>{if(!confirm('撤销后将向相关现场屏下发擦除命令；已发布版本不得继续显示。'))return;await api(`/api/assets/${id}/revoke`,{method:'POST',body:JSON.stringify({reason:'管理页人工撤销'})});await loadEvent()};
$('#uploadAsset').onclick=async()=>{if(!state.event)return;const f=$('#assetFile').files[0];if(!f)return;const dataBase64=await fileToBase64(f);const a=await api(`/api/events/${state.event.id}/assets`,{method:'POST',body:JSON.stringify({type:f.type.startsWith('image')?'photo':'font',filename:f.name,mimeType:f.type||(f.name.match(/\.(ttf|otf|woff2?)$/)?'font/ttf':''),dataBase64,licenseHolder:$('#licenseHolder').value,licenseScope:$('#licenseScope').value,licensedFrom:$('#licenseFrom').value,licensedUntil:$('#licenseUntil').value})});if(a.type==='photo'&&!state.selectedPhotoId)window.selectPhoto(a.id);await loadEvent()};
function fileToBase64(f){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(',')[1]);r.onerror=rej;r.readAsDataURL(f)})}
function renderDevices(){const linked=state.devices.filter(d=>d.event_id===state.event?.id||d.pending_event_id===state.event?.id);const unlinked=state.devices.filter(d=>!linked.includes(d));$('#devices').innerHTML=linked.map(d=>`<div class="device"><label><input class="devicePick" type="checkbox" value="${d.id}"> <b>${esc(d.name)}</b></label> <span class="pill">${esc(d.hall)}</span> ${d.pending_event_id&&d.pending_event_id!==d.event_id?'<span class="warn">等待擦除确认</span>':`<span class="ok">身份已绑定</span>`}<br><span class="muted">${esc(d.device_token.slice(0,10))}… · 在线 ${fmt(d.last_seen_at)}</span></div>`).join('')+unlinked.map(d=>`<div class="device"><b>${esc(d.name)}</b> <span class="pill">${esc(d.hall)}</span> <span class="warn">未绑定</span><div class="row"><button onclick="bindExisting('${d.id}')">绑定当前活动</button></div><span class="muted">${esc(d.device_token.slice(0,10))}…</span></div>`).join('')||'<p class="muted">还没有设备</p>'}
$('#createDevice').onclick=async()=>{const name=prompt('设备名称','主厅主屏');if(!name)return;const hall=state.event?.hall||prompt('会场名称')||'未分配';const d=await api('/api/devices',{method:'POST',body:JSON.stringify({name,hall})});await bindDevice(d.id);await loadEvent()};
async function bindDevice(id){const j=await api(`/api/devices/${id}/bind-event`,{method:'POST',body:JSON.stringify({eventId:state.event.id})});if(j.wipeRequired)alert('该设备曾绑定另一个活动：必须先由现场端擦除并回传证明，才能接收本次素材。')}
window.bindExisting=async id=>{await bindDevice(id);await loadEvent()};
function renderGroups(){}
function renderTargets(){const groupOptions=state.groups.map(g=>`<label><input class="groupPick" type="checkbox" value="${g.id}"> ${esc(g.name)} (${g.devices.length})</label>`).join('');$('#targets').innerHTML=`${groupOptions}<div class="muted">上方设备区勾选具体设备；组仅展开当前活动设备。发布时服务端再次校验活动身份。</div>`}
$('#createGroup').onclick=async()=>{const deviceIds=checkedDevices();if(!deviceIds.length)return alert('先勾选设备');await api(`/api/events/${state.event.id}/groups`,{method:'POST',body:JSON.stringify({name:$('#groupName').value||'屏幕组',deviceIds})});await loadEvent()};
function checkedDevices(){return [...document.querySelectorAll('.devicePick:checked')].map(x=>x.value)}
function checkedGroups(){return [...document.querySelectorAll('.groupPick:checked')].map(x=>x.value)}
function syncDesignFromEvent(){if(!state.event)return;const d=defaultDesign();d.languages=['zh-CN','en'];const s=d.slides[0];s.photoAssetId=state.selectedPhotoId||'';s.name={'zh-CN':$('#nameZh').value||state.event.couple_name,en:$('#nameEn').value||state.event.couple_name};s.hall={'zh-CN':$('#hallZh').value||state.event.hall,en:$('#hallEn').value||state.event.hall};s.subtitle={'zh-CN':$('#subtitleZh').value||'欢迎参加我们的婚礼',en:$('#subtitleEn').value||'Welcome to our wedding'};s.darken=Number($('#darken').value);s.focalX=Number($('#fx').value);s.focalY=Number($('#fy').value);state.design=d}
['nameZh','nameEn','hallZh','hallEn','subtitleZh','subtitleEn'].forEach(id=>$('#'+id).addEventListener('input',()=>{const s=slide();s.name={'zh-CN':$('#nameZh').value,en:$('#nameEn').value};s.hall={'zh-CN':$('#hallZh').value,en:$('#hallEn').value};s.subtitle={'zh-CN':$('#subtitleZh').value,en:$('#subtitleEn').value};renderPreview()}));
['darken','fx','fy'].forEach(id=>$('#'+id).addEventListener('input',()=>{Object.assign(slide(),{darken:+$('#darken').value,focalX:+$('#fx').value,focalY:+$('#fy').value});renderPreview()}));
document.querySelectorAll('[data-pos]').forEach(b=>b.onclick=()=>{slide().captionPosition=b.dataset.pos;renderPreview()});
$('#fontEmbedded').onchange=()=>renderPreview();
function hydrateEditor(){const s=slide();$('#nameZh').value=localized(s.name,'zh-CN');$('#nameEn').value=localized(s.name,'en','zh-CN');$('#hallZh').value=localized(s.hall,'zh-CN');$('#hallEn').value=localized(s.hall,'en','zh-CN');$('#subtitleZh').value=localized(s.subtitle,'zh-CN');$('#subtitleEn').value=localized(s.subtitle,'en','zh-CN');$('#darken').value=s.darken;$('#fx').value=s.focalX;$('#fy').value=s.fy}
async function loadEmbeddedFont(){if(state.fontFace)return;const f=state.assets.find(a=>a.type==='font'&&!a.revoked);if(!f)return;try{const res=await fetch(`/api/admin/assets/${f.id}/download?adminToken=${encodeURIComponent(token)}`);state.fontBuffer=await res.arrayBuffer();state.fontFace=new FontFace('WeddingEmbedded',state.fontBuffer);await state.fontFace.load();document.fonts.add(state.fontFace)}catch(e){}}
async function renderPreview(){const c=$('#preview'),ctx=c.getContext('2d');const s=slide();let img=null;const a=state.assets.find(x=>x.id===s.photoAssetId);if(a){img=await new Promise(res=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>res(null);im.src=`/api/admin/assets/${a.id}/download?adminToken=${encodeURIComponent(token)}`})}renderSlide(ctx,s,img,{},{width:c.width,height:c.height,language:'zh-CN',fallbackLanguage:'zh-CN',embedded:$('#fontEmbedded').checked,safeMarginX:6,safeMarginY:8,showSafeArea:true});hydrateEditor()}
$('#stressLong').onclick=()=>{$('#nameZh').value='欧阳娜仁图雅·亚历山大·克里斯蒂安诺夫斯基';$('#nameEn').value='Alexandria-Evangeline Christophoropoulos-Winterbottom III';$('#nameZh').dispatchEvent(new Event('input'))};
$('#stressMixed').onclick=()=>{$('#subtitleZh').value='欢迎 Welcome ようこそ 오신 것을 환영합니다 ♥';$('#subtitleEn').value='Multilingual: 中文 English 日本語 한국어 Αγάπη';$('#subtitleZh').dispatchEvent(new Event('input'))};
async function save(){syncDesignFromEvent();const fontEmbedded=$('#fontEmbedded').checked;const draft=state.versions.find(v=>v.status==='draft');const payload={label:`版本 ${new Date().toLocaleString()}`,design:state.design,fontEmbedded};if(draft)return api(`/api/versions/${draft.id}`,{method:'PATCH',body:JSON.stringify(payload)});return api(`/api/events/${state.event.id}/versions/draft`,{method:'POST',body:JSON.stringify(payload)})}
$('#saveDraft').onclick=async()=>{try{await save();await loadEvent();alert('草稿已保存')}catch(e){$('#editorError').textContent=e.message}};
async function publish(scheduledAt){try{$('#editorError').textContent='';const v=await save();const deviceIds=checkedDevices(),groupIds=checkedGroups();const j=await api(`/api/versions/${v.id||v.versionId}/publish`,{method:'POST',body:JSON.stringify({deviceIds,groupIds,scheduledAt})});await loadEvent();alert(`${j.status==='scheduled'?'已排期':'已发布'}。资源数校验通过，设备数 ${j.deviceCount}。`)}catch(e){$('#editorError').textContent=e.message;await loadEvent()}}
$('#publishNow').onclick=()=>publish(null);$('#schedule').onclick=()=>publish(toIso($('#scheduledAt').value));
function renderVersions(){$('#versions').innerHTML=state.versions.map(v=>`<div class="device"><b>${esc(v.label)}</b> <span class="pill">${v.status}</span> ${v.font_embedded?'<span class="ok">嵌入字体</span>':'<span class="warn">现场回退</span>'}<br><span class="muted">${fmt(v.published_at||v.created_at)} · ${v.devices.length}台 · ${v.manifest_json.assets?.length||0}资源</span><div class="row"><button onclick="rollback('${v.id}')">回退到此版本</button><button class="danger" onclick="cancelVersion('${v.id}')">撤销</button></div></div>`).join('')}
window.rollback=async id=>{if(!confirm('仅对勾选设备回退；目标设备必须仍持有该完整清单。'))return;await api(`/api/versions/${id}/rollback`,{method:'POST',body:JSON.stringify({deviceIds:checkedDevices(),groupIds:checkedGroups()})});await loadEvent()};
window.cancelVersion=async id=>{if(!confirm('撤销草稿或定时版本；已激活发布请使用回退。终端将删除未激活缓存。'))return;await api(`/api/versions/${id}/cancel`,{method:'POST'});await loadEvent()};
function renderProofs(){$('#proofs').innerHTML=state.proofs.map(p=>`<div class="device"><b>${esc(p.version_label)}</b> #${p.slide_index+1} <span class="pill">${p.kind}</span> <span class="${p.status==='approved'?'ok':p.status==='rejected'?'bad':'warn'}">${p.status}</span><br><a target="_blank" href="/api/device/proofs/${p.id}/raw?adminToken=${encodeURIComponent(token)}"><img style="max-width:100%;border-radius:8px" src="/api/device/proofs/${p.id}/raw?adminToken=${encodeURIComponent(token)}"></a><div class="muted">${esc(p.device_name)} ${fmt(p.created_at)} · 行数 ${p.metrics_json.blocks?.length||0}</div><div class="row"><button onclick="reviewProof('${p.id}','approved')">通过</button><button class="danger" onclick="reviewProof('${p.id}','rejected')">退回</button></div></div>`).join('')||'<p class="muted">终端完成完整版本后会自动上传合成截图；也可在 C 窗口上传现场屏幕截图。</p>'}
window.reviewProof=async(id,status)=>{await api(`/api/proofs/${id}/review`,{method:'POST',body:JSON.stringify({status})});await loadEvent()};
$('#runCleanup').onclick=async()=>{const j=await api(`/api/events/${state.event.id}/cleanup`,{method:'POST',body:JSON.stringify({dryRun:true})});$('#cleanup').insertAdjacentHTML('beforeend',`<pre>${esc(JSON.stringify(j,null,2))}</pre>`);renderAudits()};
async function renderAudits(){try{const rows=await api(`/api/events/${state.event.id}/audits`);$('#audits').textContent=rows.map(a=>`${fmt(a.created_at)} ${a.action} ${a.target_type}:${a.target_id} ${esc(JSON.stringify(a.detail_json))}`).join('\n')}catch(e){$('#audits').textContent=e.message}}
async function fontCoverage(text){
  if(!state.fontBuffer) return {unavailable:true,missing:new Set(text)};
  const opentype=await import('/vendor/opentype.js');
  const font=opentype.parse(state.fontBuffer);
  const missing=new Set();
  for(const ch of text){const cp=ch.codePointAt(0);if(!/\s/.test(ch)&&!font.charToGlyph(cp)?.unicode)missing.add(ch)}
  return {unavailable:false,missing};
}
$('#compareFont').onclick=async()=>{try{await compareFonts()}catch(e){$('#fontReport').innerHTML=`<span class="bad">${esc(e.message)}</span>`}};
async function compareFonts(){
  const s=slide(), width=$('#preview').width-115, ctx=$('#preview').getContext('2d');
  const allText=state.design.languages.flatMap(lang=>['name','subtitle','hall'].map(f=>localized(s[f],lang))).join('');
  const coverage=await fontCoverage(allText);
  let issues=0; const rows=[];
  const img=await (async()=>{const a=state.assets.find(x=>x.id===s.photoAssetId);if(!a)return null;return await new Promise(res=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>res(null);im.src=`/api/admin/assets/${a.id}/download?adminToken=${encodeURIComponent(token)}`})})();
  const marginEmbedded=renderSlide(ctx,s,img,{},{width:960,height:540,embedded:true,showSafeArea:true,safeMarginX:6,safeMarginY:8});
  const marginFallback=renderSlide(ctx,s,img,{},{width:960,height:540,embedded:false,showSafeArea:true,safeMarginX:6,safeMarginY:8});
  if(!marginEmbedded.withinSafeArea || !marginFallback.withinSafeArea){issues++;rows.push('<div class="bad">字幕超出安全边距；必须缩小字号或调整字幕位置。</div>')}
  renderPreview();
  for(const lang of state.design.languages) for(const field of ['name','subtitle','hall']) {
    const text=localized(s[field],lang);
    ctx.font=`700 72px "WeddingEmbedded"`;
    const embedded={w:ctx.measureText(text).width,lines:wrapText(ctx,text,width)};
    ctx.font=`700 72px ${FALLBACK_STACK}`;
    const fallback={w:ctx.measureText(text).width,lines:wrapText(ctx,text,width)};
    const delta=Math.abs(embedded.w-fallback.w)/Math.max(1,embedded.w);
    const lineDiff=embedded.lines.length!==fallback.lines.length;
    const missing=[...coverage.missing].filter(ch=>text.includes(ch));
    if(delta>.04 || lineDiff || missing.length || coverage.unavailable) {
      issues++;
      rows.push(`<div class="bad">${lang}.${field} 宽度差 ${(delta*100).toFixed(1)}%，嵌入 ${embedded.lines.length} 行 / 回退 ${fallback.lines.length} 行${missing.length?`，缺字 ${esc(missing.slice(0,8).join(''))}`:''}${coverage.unavailable?'，未上传嵌入字体，只能按现场回退检测':''}</div>`);
    }
  }
  const structural=structuralValidation(state.design,state.assets);
  const marginRows=structural.errors.map(x=>`<div class="bad">${esc(x)}</div>`).join('');
  $('#fontReport').innerHTML=(issues?rows.join(''):`<span class="ok">未检测到显著换行/字形差异。</span><div class="muted">仍需检查 C 现场窗口实际截图中的安全边距；蓝色虚线为安全边距。</div>`)+marginRows;
}
loadAll();setInterval(()=>state.event&&loadEvent(),15000);
