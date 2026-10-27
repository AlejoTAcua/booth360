// Configuración persistente (localStorage).
const KEY = 'booth360.settings.v1';

export const SPEEDS = [0.25, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const PRESETS = [
  { id: 'normal',   name: 'Normal',                 segments: [{ speed: 1, dir: 'fwd', from: 0, to: 100 }], reverse: false },
  { id: 'rapidolento', name: 'Rápido → lento',      segments: [{ speed: 1.75, dir: 'fwd', from: 0, to: 100 }, { speed: 0.5, dir: 'fwd', from: 0, to: 100 }], reverse: false },
  { id: 'boomerang', name: 'Boomerang',             segments: [{ speed: 1, dir: 'fwd', from: 0, to: 100 }], reverse: true },
  { id: 'lento',    name: 'Cámara lenta',           segments: [{ speed: 0.5, dir: 'fwd', from: 0, to: 100 }], reverse: false },
  { id: 'epico',    name: 'Épico (rápido, lento, reverso)', segments: [{ speed: 2, dir: 'fwd', from: 0, to: 100 }, { speed: 0.5, dir: 'fwd', from: 0, to: 100 }, { speed: 2, dir: 'rev', from: 0, to: 100 }], reverse: false },
  { id: 'pausa', name: 'Rápido, pausa y lento', segments: [{ speed: 2, dir: 'fwd', from: 0, to: 60, hold: 1 }, { speed: 0.5, dir: 'fwd', from: 60, to: 100 }], reverse: false },
  { id: 'lentomedio', name: 'Normal → lento al final', segments: [{ speed: 1.5, dir: 'fwd', from: 0, to: 100 }, { speed: 0.4, dir: 'fwd', from: 50, to: 100 }], reverse: true },
];

// Filtros de color (solo sobre la imagen de la cámara; el texto y los efectos quedan con sus colores).
export const LOOKS = [
  { id: 'none', name: 'Natural' },
  { id: 'bn', name: 'Blanco y negro' },
  { id: 'glam', name: 'Glam (B y N con contraste)' },
  { id: 'calido', name: 'Cálido' },
  { id: 'frio', name: 'Frío' },
  { id: 'vintage', name: 'Vintage' },
  { id: 'vivo', name: 'Vivo' },
];

export const FONTS = [
  { id: 'Great Vibes', label: 'Great Vibes (cursiva elegante)' },
  { id: 'Dancing Script', label: 'Dancing Script (cursiva)' },
  { id: 'Pacifico', label: 'Pacifico' },
  { id: 'Playfair Display', label: 'Playfair Display (serif)' },
  { id: 'Bebas Neue', label: 'Bebas Neue (bloque)' },
  { id: 'Montserrat', label: 'Montserrat' },
  { id: 'system-ui', label: 'Sistema' },
];

export const DEFAULTS = {
  eventName: 'Mi evento 360',
  capture: { seconds: 15, fps: 30, res: '720', countdown: 5, readyText: '¡Preparate!', facing: 'environment', motionStart: false, motionSensitivity: 'media' },
  timeline: { preset: 'rapidolento', segments: PRESETS[1].segments.map(s => ({ ...s })), reverse: false, smooth: true },
  effects: { type: 'sparkles', intensity: 2, color: '#ff6fb5' },
  look: 'none', // filtro de color de la imagen
  overlay: {
    mode: 'text', text: 'Mi evento', emoji: '👑', font: 'Great Vibes', size: 110, color: '#d9a3ff',
    x: 0.5, y: 0.8, shadow: true, stroke: false, imageId: null,
  },
  music: { mode: 'random', fadeOut: true, fadeIn: true, beatSync: true }, // beatSync: cambios de velocidad sobre los golpes de la canción
  output: { res: '720', mbps: 5, fps: 30, saveToGallery: true, saveOriginal: false, originalMbps: 3, autoShare: false },
  endCard: { enabled: false, imageId: null, seconds: 2 }, // placa final con el logo o la marca (imagen)
};

function merge(base, extra) {
  if (Array.isArray(base)) return Array.isArray(extra) ? extra : base;
  if (typeof base === 'object' && base) {
    const out = { ...base };
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        out[k] = k in base ? merge(base[k], extra[k]) : extra[k];
      }
    }
    return out;
  }
  return extra === undefined ? base : extra;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return merge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (e) {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

// Expande la línea de tiempo a una lista de pasadas sobre el clip.
// Cada pasada: { speed, dir, from, to } con from/to como fracción 0..1 del clip.
export function expandTimeline(timeline) {
  const base = timeline.segments.map(s => ({
    speed: +s.speed || 1, dir: s.dir === 'rev' ? 'rev' : 'fwd',
    from: Math.min(+s.from || 0, +s.to || 100) / 100, to: Math.max(+s.from || 0, +s.to || 100) / 100,
    hold: Math.max(0, Math.min(3, +s.hold || 0)), // segundos con la imagen congelada al final del tramo
  })).filter(s => s.to > s.from);
  if (!base.length) base.push({ speed: 1, dir: 'fwd', from: 0, to: 1 });
  if (!timeline.reverse) return base;
  const mirrored = base.slice().reverse().map(s => ({ ...s, dir: s.dir === 'fwd' ? 'rev' : 'fwd', hold: 0 }));
  return base.concat(mirrored);
}

export function finalDuration(timeline, clipSeconds) {
  return expandTimeline(timeline).reduce((acc, p) => acc + clipSeconds * (p.to - p.from) / p.speed + (p.hold || 0), 0);
}

export function outputSize(res) {
  return res === '1080' ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
}
