/* Shared rendering and typography logic used by browser preview and field display. */
(function initRenderCore(global) {
  const FONT_WEIGHTS = {
    names: { size: 72, min: 24, weight: 700, line: 1.12, maxLines: 3 },
    hall: { size: 34, min: 16, weight: 600, line: 1.2, maxLines: 2 },
    message: { size: 30, min: 15, weight: 400, line: 1.35, maxLines: 5 }
  };

  function canonicalJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }

  async function sha256Text(text) {
    if (globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }

  async function loadFonts(payload, assets = []) {
    if (typeof document === 'undefined' || !('FontFace' in window) || payload.fontMode !== 'embedded') return [];
    const loaded = [];
    for (const asset of assets) {
      if (asset.kind !== 'font' || (!asset.url && !asset.buffer)) continue;
      const buffer = asset.buffer || await (await fetch(asset.url)).arrayBuffer();
      const face = new FontFace(payload.fontFamily, buffer);
      await face.load();
      document.fonts.add(face);
      loaded.push(asset.id || asset.filename);
    }
    if (loaded.length && payload.fontFamily) {
      await Promise.all([400, 600, 700].map((weight) =>
        document.fonts.load(`${weight} 24px ${payload.fontFamily}`).catch(() => [])
      ));
    }
    await document.fonts.ready;
    return loaded;
  }

  function fontFamilyFor(payload, mode = payload.fontMode) {
    if (mode === 'fallback') return payload.fallbackFamily || 'system-ui, sans-serif';
    return `${payload.fontFamily}, ${payload.fallbackFamily || 'system-ui, sans-serif'}`;
  }

  function isSpace(ch) {
    return /\s/u.test(ch);
  }

  function isCjk(ch) {
    const cp = ch.codePointAt(0);
    return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xff00 && cp <= 0xffef);
  }

  function tokenize(text) {
    const tokens = [];
    let word = '';
    for (const ch of text) {
      if (isSpace(ch)) {
        if (word) { tokens.push({ text: word, breakable: false }); word = ''; }
        tokens.push({ text: ch, breakable: true, space: true });
      } else if (isCjk(ch) || /[\p{P}]/u.test(ch)) {
        if (word) { tokens.push({ text: word, breakable: false }); word = ''; }
        tokens.push({ text: ch, breakable: true });
      } else {
        word += ch;
      }
    }
    if (word) tokens.push({ text: word, breakable: false });
    return tokens;
  }

  function measureText(ctx, text, font) {
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  function wrapText(ctx, text, maxWidth, cssFont, maxLines = 4) {
    const tokens = tokenize(text);
    const lines = [];
    let line = '';
    const overflowParts = [];

    for (const token of tokens) {
      let candidate = line + token.text;
      if (measureText(ctx, candidate, cssFont) <= maxWidth || !line) {
        if (lines.length >= maxLines) overflowParts.push(token.text);
        else line = candidate;
      } else if (lines.length < maxLines) {
        lines.push(line.replace(/\s+$/u, ''));
        line = token.space ? '' : token.text;
      } else {
        overflowParts.push(token.text);
      }
      if (!token.breakable && !token.space) {
        // A single Latin word larger than the line is split deterministically.
        let guard = 0;
        while (lines.length < maxLines && measureText(ctx, line, cssFont) > maxWidth && line.length > 1 && guard++ < 100) {
          lines.push(line.slice(0, -1));
          line = line.slice(-1);
        }
      }
    }
    if (line && lines.length < maxLines) lines.push(line.trimEnd());
    else if (line) overflowParts.push(line);
    return {
      lines,
      overflowText: overflowParts.join('').trim(),
      overflow: Boolean(overflowParts.join('').trim()),
      widths: lines.map((item) => measureText(ctx, item, cssFont))
    };
  }

  function fitBlock(ctx, text, maxWidth, maxHeight, modeSpec, family) {
    let size = modeSpec.size;
    while (size >= modeSpec.min) {
      const wrapped = wrapText(ctx, text, maxWidth, `${modeSpec.weight} ${size}px ${family}`, modeSpec.maxLines);
      const blockHeight = wrapped.lines.length * size * modeSpec.line;
      if (!wrapped.overflow && blockHeight <= maxHeight) {
        return { ok: true, size, lines: wrapped.lines, lineWidths: wrapped.widths, blockHeight, overflow: false };
      }
      size -= 1;
    }
    const wrapped = wrapText(ctx, text, maxWidth, `${modeSpec.weight} ${modeSpec.min}px ${family}`, modeSpec.maxLines);
    return {
      ok: false, size: modeSpec.min, lines: wrapped.lines, lineWidths: wrapped.widths,
      blockHeight: wrapped.lines.length * modeSpec.min * modeSpec.line,
      overflow: wrapped.overflow || wrapped.lines.length * modeSpec.min * modeSpec.line > maxHeight,
      overflowText: wrapped.overflowText
    };
  }

  function unsupportedGlyphs(ctx, text, family, weight) {
    ctx.font = `${weight} 24px ${family}`;
    const missing = new Set();
    for (const ch of text) {
      if (isSpace(ch)) continue;
      const width = ctx.measureText(ch).width;
      if (!width) missing.add(ch);
    }
    return [...missing];
  }

  function analyzeSlide(ctx, slide, payload, mode, width, height) {
    const family = fontFamilyFor(payload, mode);
    const margin = Number(payload.safeMargin || 0);
    const maxTextWidth = width - margin * 2 - 80;
    const names = fitBlock(ctx, slide.names, maxTextWidth, height * 0.24, FONT_WEIGHTS.names, family);
    const hall = fitBlock(ctx, slide.hallName, maxTextWidth, height * 0.12, FONT_WEIGHTS.hall, family);
    const message = fitBlock(ctx, slide.message, maxTextWidth, height * 0.24, FONT_WEIGHTS.message, family);
    const missingGlyphs = [...new Set([
      ...unsupportedGlyphs(ctx, slide.names, family, FONT_WEIGHTS.names.weight),
      ...unsupportedGlyphs(ctx, slide.hallName, family, FONT_WEIGHTS.hall.weight),
      ...unsupportedGlyphs(ctx, slide.message, family, FONT_WEIGHTS.message.weight)
    ])];
    const captionX = width * Number(payload.photo.captionX) / 100;
    const captionY = height * Number(payload.photo.captionY) / 100;
    const widest = Math.max(...names.lineWidths, ...hall.lineWidths, ...message.lineWidths, 0);
    const left = captionX - widest / 2;
    const right = captionX + widest / 2;
    const top = captionY - names.blockHeight - 24;
    const bottom = captionY + hall.blockHeight + message.blockHeight + 44;
    const safeAreaViolation = left < margin || right > width - margin || top < margin || bottom > height - margin;
    return {
      locale: slide.locale,
      family,
      names, hall, message,
      missingGlyphs,
      missingGlyphCount: missingGlyphs.length,
      overflow: !names.ok || !hall.ok || !message.ok,
      safeAreaViolation,
      bounds: { left, right, top, bottom, widest }
    };
  }

  async function compareTypography(payload, assets, width = 1920, height = 1080) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const loadedFonts = await loadFonts(payload, assets);
    const embedded = { width, height, loadedFonts, slides: payload.slides.map((slide) => analyzeSlide(ctx, slide, payload, 'embedded', width, height)) };
    const fallback = { width, height, slides: payload.slides.map((slide) => analyzeSlide(ctx, slide, payload, 'fallback', width, height)) };
    const differences = [];
    embedded.slides.forEach((a, index) => {
      const b = fallback.slides[index];
      const signature = (result) => JSON.stringify({
        names: [result.names.size, result.names.lines, result.names.ok],
        hall: [result.hall.size, result.hall.lines, result.hall.ok],
        message: [result.message.size, result.message.lines, result.message.ok],
        missing: result.missingGlyphs, safe: !result.safeAreaViolation
      });
      if (signature(a) !== signature(b)) {
        differences.push({
          locale: a.locale,
          embedded: { nameSize: a.names.size, nameLines: a.names.lines.length, overflow: a.overflow, safeAreaViolation: a.safeAreaViolation, missing: a.missingGlyphs },
          fallback: { nameSize: b.names.size, nameLines: b.names.lines.length, overflow: b.overflow, safeAreaViolation: b.safeAreaViolation, missing: b.missingGlyphs }
        });
      }
    });
    return {
      width, height,
      payloadChecksum: await checksumPayload(payload),
      generatedAt: new Date().toISOString(),
      embeddedFontLoaded: payload.fontMode !== 'embedded' || (payload.fontAssetIds.length === 0 ? true : loadedFonts.length > 0),
      embedded, fallback, differences,
      acknowledgedFallback: false
    };
  }

  async function checksumPayload(payload) {
    const canonical = canonicalJson(payload);
    if (globalThis.crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    return null;
  }

  function drawCoverPhoto(ctx, image, width, height, photo) {
    if (!image) return false;
    const scale = Math.max(width / image.width, height / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const fx = Number(photo.focusX || 50) / 100;
    const fy = Number(photo.focusY || 50) / 100;
    const x = width * fx - drawW * fx;
    const y = height * fy - drawH * fy;
    ctx.drawImage(image, x, y, drawW, drawH);
    return true;
  }

  function drawWrapped(ctx, lines, x, y, size, lineHeight, align = 'center') {
    lines.forEach((line, index) => {
      ctx.fillText(line, x, y + index * size * lineHeight);
    });
  }

  function renderPayload(ctx, width, height, payload, slideIndex = 0, images = {}, options = {}) {
    const slide = payload.slides[slideIndex] || payload.slides[0];
    ctx.save();
    ctx.fillStyle = payload.backgroundColor || '#101318';
    ctx.fillRect(0, 0, width, height);
    if (payload.photo.assetId && images[payload.photo.assetId]) {
      drawCoverPhoto(ctx, images[payload.photo.assetId], width, height, payload.photo);
      ctx.fillStyle = `rgba(0,0,0,${Number(payload.photo.dim || 0) / 100})`;
      ctx.fillRect(0, 0, width, height);
    }
    const family = fontFamilyFor(payload, options.fontMode);
    const margin = Number(payload.safeMargin || 0);
    const maxWidth = width - margin * 2 - 80;
    const namesFit = fitBlock(ctx, slide.names, maxWidth, height * 0.24, FONT_WEIGHTS.names, family);
    const hallFit = fitBlock(ctx, slide.hallName, maxWidth, height * 0.12, FONT_WEIGHTS.hall, family);
    const messageFit = fitBlock(ctx, slide.message, maxWidth, height * 0.24, FONT_WEIGHTS.message, family);
    const x = width * Number(payload.photo.captionX) / 100;
    let y = height * Number(payload.photo.captionY) / 100;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = payload.textColor;
    ctx.font = `${FONT_WEIGHTS.names.weight} ${namesFit.size}px ${family}`;
    drawWrapped(ctx, namesFit.lines, x, y, namesFit.size, FONT_WEIGHTS.names.line);
    y += namesFit.blockHeight + 22;
    ctx.font = `${FONT_WEIGHTS.hall.weight} ${hallFit.size}px ${family}`;
    ctx.fillStyle = payload.accentColor;
    drawWrapped(ctx, hallFit.lines, x, y, hallFit.size, FONT_WEIGHTS.hall.line);
    y += hallFit.blockHeight + 28;
    ctx.font = `${FONT_WEIGHTS.message.weight} ${messageFit.size}px ${family}`;
    ctx.fillStyle = payload.textColor;
    drawWrapped(ctx, messageFit.lines, x, y, messageFit.size, FONT_WEIGHTS.message.line);
    ctx.restore();
    if (options.showSafeArea) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,60,60,.85)';
      ctx.setLineDash([12, 10]);
      ctx.lineWidth = 3;
      ctx.strokeRect(margin, margin, width - margin * 2, height - margin * 2);
      ctx.restore();
    }
  }

  global.VowRender = {
    canonicalJson, sha256Text, loadFonts, fontFamilyFor, tokenize, wrapText, fitBlock,
    analyzeSlide, compareTypography, renderPayload, drawCoverPhoto, FONT_WEIGHTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
