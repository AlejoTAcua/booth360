// Texto / imagen superpuesta.
export function overlayFont(overlay, H) {
  const px = Math.round((overlay.size || 100) * H / 1280);
  return `${px}px "${overlay.font || 'system-ui'}", "Great Vibes", cursive`;
}

export async function ensureFontLoaded(overlay, H) {
  if (!document.fonts || !overlay.font || overlay.font === 'system-ui') return;
  try { await document.fonts.load(overlayFont(overlay, H), overlay.text || 'Abc'); } catch (e) { /* ignore */ }
}

/**
 * Dibuja la superposición sobre un canvas W×H.
 * image: ImageBitmap/HTMLImageElement (PNG transparente de pantalla completa) o null.
 */
export function drawOverlay(ctx, W, H, overlay, image) {
  if (!overlay || overlay.mode === 'none') return;
  if (overlay.mode === 'image') {
    if (!image) return;
    // Cubrir todo el cuadro manteniendo proporción (los PNG suelen ser 720x1280).
    const iw = image.width, ih = image.height;
    const s = Math.max(W / iw, H / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return;
  }
  const text = (overlay.text || '').trim();
  const emoji = (overlay.emoji || '').trim();
  if (!text && !emoji) return;
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
  let cy = y - totalH / 2 + (emoji ? px * 0.45 : 0);
  if (emoji) {
    ctx.save();
    ctx.font = `${Math.round(px * 0.75)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
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
}
