export const DEFAULT_SAFE_MARGIN = { x: 0.06, y: 0.08 };
export const FALLBACK_STACK = 'Georgia, "Times New Roman", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif';

export function defaultDesign() {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, safeMarginX: 6, safeMarginY: 8 },
    languages: ['zh-CN', 'en'],
    slides: [
      {
        id: cryptoId(),
        kind: 'welcome',
        photoAssetId: '',
        name: { 'zh-CN': '新人姓名', en: 'Newlyweds Name' },
        hall: { 'zh-CN': '宴会厅', en: 'Banquet Hall' },
        subtitle: { 'zh-CN': '欢迎参加我们的婚礼', en: 'Welcome to our wedding' },
        captionPosition: 'bottom',
        textAlign: 'center',
        maxFontSize: 96,
        darken: 0.34
      }
    ]
  };
}
export function cryptoId() {
  return (crypto?.randomUUID?.() || `s_${Date.now()}_${Math.random()}`);
}
export function familyDeclaration(embedded = true) {
  return embedded ? '"WeddingEmbedded"' : FALLBACK_STACK;
}
export function wrapText(ctx, text, maxWidth) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const tokens = source.match(/[\p{L}\p{N}\p{Pd}’']+|\p{Emoji_Presentation}|\p{Extended_Pictographic}|\s+|./gu) || [];
  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (/^\s+$/.test(token)) { if (line) line += token; continue; }
    const candidate = line + token;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else if (/[\u3400-\u9fff\uf900-\ufaff]/.test(token) && ctx.measureText(token).width > maxWidth) {
      for (const ch of token) {
        const candidateCJK = line + ch;
        if (ctx.measureText(candidateCJK).width > maxWidth && line) { lines.push(line.trimEnd()); line = ch; }
        else line = candidateCJK;
      }
    } else { lines.push(line.trimEnd()); line = token; }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}
function coverRect(srcW, srcH, dstW, dstH, fx = .5, fy = .5) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const w = dstW / scale, h = dstH / scale;
  const x = Math.max(0, Math.min(srcW - w, fx * srcW - w / 2));
  const y = Math.max(0, Math.min(srcH - h, fy * srcH - h / 2));
  return { sx: x, sy: y, sw: w, sh: h, dx: 0, dy: 0, dw: dstW, dh: dstH };
}
export function focalCrop(srcW, srcH, dstW, dstH, fx = .5, fy = .5) {
  return coverRect(srcW, srcH, dstW, dstH, fx, fy);
}
export function localized(value, language, fallbackLanguage = 'zh-CN') {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return value[language] || value[fallbackLanguage] || Object.values(value)[0] || '';
}
function buildBlocks(slide, language, fallbackLanguage) {
  const name = localized(slide.name, language, fallbackLanguage);
  const hall = localized(slide.hall, language, fallbackLanguage);
  const subtitle = localized(slide.subtitle, language, fallbackLanguage);
  return [
    { key: 'name', text: name, weight: 700, ratio: .072, lineRatio: 1.12, maxLines: 2 },
    { key: 'subtitle', text: subtitle, weight: 500, ratio: .031, lineRatio: 1.35, maxLines: 2 },
    { key: 'hall', text: hall, weight: 500, ratio: .025, lineRatio: 1.35, maxLines: 1 }
  ].filter(b => b.text);
}
export function renderSlide(ctx, slide, image, fonts, options = {}) {
  const width = options.width || 1920, height = options.height || 1080;
  const marginXP = options.safeMarginX ?? 6, marginYP = options.safeMarginY ?? 8;
  const marginX = width * marginXP / 100, marginY = height * marginYP / 100;
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle = '#120f11'; ctx.fillRect(0,0,width,height);
  if (image) {
    const r = focalCrop(image.naturalWidth || image.width, image.naturalHeight || image.height, width, height, slide.focalX ?? .5, slide.focalY ?? .5);
    ctx.drawImage(image, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
  }
  ctx.fillStyle = `rgba(0,0,0,${Number(slide.darken ?? .34)})`;
  ctx.fillRect(0,0,width,height);
  const language = options.language || 'zh-CN';
  const fallbackLanguage = options.fallbackLanguage || 'zh-CN';
  const blocks = buildBlocks(slide, language, fallbackLanguage);
  const contentW = width - marginX * 2;
  const scales={name:1,subtitle:.48,hall:.38};
  const lineRatios={name:1.12,subtitle:1.28,hall:1.28};
  const maxLines={name:2,subtitle:2,hall:1};
  let nameSize=Number(slide.maxFontSize || width*.05);
  let totalH=Infinity;
  while(nameSize>14){
    laid=blocks.map(b=>{
      const size=nameSize*scales[b.key];
      ctx.font=`${b.weight} ${size}px ${familyDeclaration(options.embedded!==false)}`;
      return {...b,size,lines:wrapText(ctx,b.text,contentW)};
    });
    totalH=laid.reduce((sum,b)=>sum+b.lines.length*b.size*lineRatios[b.key],0)+(laid.length-1)*nameSize*.22;
    if(laid.every(b=>b.lines.length<=maxLines[b.key]) && totalH<=height-marginY*2) break;
    nameSize-=2;
  }
  let y;
  if(slide.captionPosition==='top') y=marginY+nameSize;
  else if(slide.captionPosition==='middle') y=(height-totalH)/2+nameSize;
  else y=height-marginY-totalH+nameSize;
  const topY=y;
  const align=slide.textAlign==='left'?'left':slide.textAlign==='right'?'right':'center';
  ctx.textAlign=align; ctx.textBaseline='alphabetic';
  let x=width/2;
  if(align==='left')x=marginX;
  if(align==='right')x=width-marginX;
  for(const b of laid){
    ctx.font=`${b.weight} ${b.size}px ${familyDeclaration(options.embedded!==false)}`;
    ctx.fillStyle='#fff';
    ctx.shadowColor='rgba(0,0,0,.65)';ctx.shadowBlur=nameSize*.08;ctx.shadowOffsetY=nameSize*.04;
    for(const line of b.lines){ctx.fillText(line,x,y);y+=b.size*lineRatios[b.key]}
    y+=nameSize*.18;
    ctx.shadowColor='transparent';
  }
  const bottomY=y-nameSize*.18;

  if (options.showSafeArea) {
    ctx.strokeStyle = options.safeAreaColor || 'rgba(0,229,255,.75)';
    ctx.setLineDash([18, 12]); ctx.lineWidth = 3;
    ctx.strokeRect(marginX, marginY, width - marginX*2, height - marginY*2);
    ctx.setLineDash([]);
  }
  return { width, height, marginX, marginY, blocks: laid, fontSize, totalTextHeight: totalH,
           withinSafeArea: topY >= marginY && bottomY <= height-marginY };
}

export function structuralValidation(design, assets = []) {
  const errors = [], warnings = [];
  if (!design || typeof design !== 'object') return { errors: ['设计内容无效'], warnings };
  if (!Array.isArray(design.slides) || design.slides.length === 0) errors.push('至少需要一屏幻灯片');
  const ids = new Set(assets.map(a => a.id));
  for (const [i,s] of (design.slides || []).entries()) {
    if (!s.name || !Object.values(s.name).some(Boolean)) errors.push(`第 ${i+1} 屏缺少新人姓名`);
    if (!s.hall || !Object.values(s.hall).some(Boolean)) errors.push(`第 ${i+1} 屏缺少宴会厅`);
    if (!s.photoAssetId) errors.push(`第 ${i+1} 屏未绑定照片`);
    else if (!ids.has(s.photoAssetId)) errors.push(`第 ${i+1} 屏照片素材不存在`);
    const fx = Number(s.focalX ?? .5), fy = Number(s.focalY ?? .5);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) errors.push(`第 ${i+1} 屏焦点必须在 0–1 之间`);
    const d = Number(s.darken ?? 0);
    if (d < 0 || d > .9) warnings.push(`第 ${i+1} 屏暗化层不在常见范围 0–0.9`);
    if (!['top','middle','bottom'].includes(s.captionPosition)) errors.push(`第 ${i+1} 屏字幕位置无效`);
  }
  return { errors, warnings };
}
