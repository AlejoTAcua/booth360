// Lo que va arriba del video: un marco (PNG transparente de pantalla completa), adornos (una corona, un emoji o una
// imagen propia, cada uno donde se quiera) y el texto. Las tres cosas se pueden usar juntas.
export function overlayFont(overlay, H) {
  const px = Math.round((overlay.size || 100) * H / 1280);
  return `${px}px "${overlay.font || 'system-ui'}", "Great Vibes", cursive`;
}

export async function ensureFontLoaded(overlay, H) {
  if (!document.fonts || !overlay.font || overlay.font === 'system-ui') return;
  try { await document.fonts.load(overlayFont(overlay, H), overlay.text || 'Abc'); } catch (e) { /* ignore */ }
}

// Qué partes están prendidas. (Las configuraciones viejas solo tenían "mode": text / image / none.)
export function overlayParts(overlay) {
  if (!overlay || overlay.mode === 'none') return { text: false, image: false, stickers: [] };
  return {
    text: overlay.textOn ?? overlay.mode === 'text',
    image: overlay.imageOn ?? overlay.mode === 'image',
    stickers: Array.isArray(overlay.stickers) ? overlay.stickers : [],
  };
}
export function hasOverlay(overlay) {
  const p = overlayParts(overlay);
  return p.text || p.image || p.stickers.length > 0;
}

/**
 * Dibuja la superposición sobre un canvas W×H.
 * assets: { image: marco de pantalla completa o null, stickers: Map(assetId → imagen) }. (También acepta solo el marco.)
 * Devuelve dónde quedó cada cosa ([{ type: 'text' | 'sticker', id, x, y, w, h }]) para poder tocarlas y arrastrarlas.
 */
export function drawOverlay(ctx, W, H, overlay, assets) {
  const boxes = [];
  const parts = overlayParts(overlay);
  const a = assets && (('image' in assets) || ('stickers' in assets)) ? assets : { image: assets || null };
  if (parts.image && a.image) {
    // Cubrir todo el cuadro manteniendo proporción (los PNG suelen ser 720x1280).
    const iw = a.image.width, ih = a.image.height;
    const s = Math.max(W / iw, H / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(a.image, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  for (const st of parts.stickers) {
    const w = Math.max(0.04, Math.min(1.2, +st.size || 0.25)) * W;
    const x = (st.x ?? 0.5) * W, y = (st.y ?? 0.3) * H;
    if (st.emoji) {
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(w * 0.86)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.fillStyle = '#000'; // (un pincel transparente dejaría el emoji transparente)
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = w * 0.08;
      ctx.fillText(st.emoji, x, y + w * 0.04);
      ctx.restore();
      boxes.push({ type: 'sticker', id: st.id, x: x - w / 2, y: y - w / 2, w, h: w });
    } else {
      const img = a.stickers && a.stickers.get(st.assetId);
      if (!img) continue;
      const h = w * img.height / img.width;
      ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
      boxes.push({ type: 'sticker', id: st.id, x: x - w / 2, y: y - h / 2, w, h });
    }
  }
  const text = parts.text ? (overlay.text || '').trim() : '';
  const emoji = parts.text ? (overlay.emoji || '').trim() : '';
  if (!text && !emoji) return boxes;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const px = Math.round((overlay.size || 100) * H / 1280);
  ctx.font = overlayFont(overlay, H);
  const x = (overlay.x ?? 0.5) * W;
  let y = (overlay.y ?? 0.85) * H;
  const lines = text.split('\n');
  const lineH = px * 1.1;
  const totalH = lines.length * lineH + (emoji ? px * 0.9 : 0);
  // Zona segura: el bloque entero queda entre el 5 % de arriba y el 91 % (abajo, WhatsApp, Reels y TikTok tapan).
  y = Math.min(Math.max(y, H * 0.05 + totalH / 2), H * 0.91 - totalH / 2);
  let maxW = px;
  for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
  boxes.push({ type: 'text', id: 'text', x: x - maxW / 2, y: y - totalH / 2, w: maxW, h: totalH });
  let cy = y - totalH / 2 + (emoji ? px * 0.45 : 0);
  if (emoji) {
    ctx.save();
    ctx.font = `${Math.round(px * 0.75)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.fillStyle = '#000';
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = px * 0.1;
    ctx.fillText(emoji, x, cy);
    ctx.restore();
    cy += px * 0.9;
  }
  cy += lineH / 2;
  for (const line of lines) {
    if (overlay.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = px * 0.12;
      ctx.shadowOffsetY = px * 0.03;
    }
    if (overlay.stroke) {
      ctx.lineWidth = Math.max(2, px * 0.06);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, x, cy);
    }
    ctx.fillStyle = overlay.color || '#ffffff';
    ctx.fillText(line, x, cy);
    cy += lineH;
  }
  ctx.restore();
  return boxes;
}
