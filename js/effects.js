// Efectos animados (partículas) dibujados sobre el video. Deterministas por semilla.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function heartPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.bezierCurveTo(x, y, x - s * 0.5, y - s * 0.4, x - s * 0.5, y + s * 0.0);
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.35, x, y + s * 0.6, x, y + s * 0.9);
  ctx.bezierCurveTo(x, y + s * 0.6, x + s * 0.5, y + s * 0.35, x + s * 0.5, y + s * 0.0);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.4, x, y, x, y + s * 0.3);
  ctx.closePath();
}

function starPath(ctx, x, y, r, points = 5, inner = 0.45) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + i * Math.PI / points;
    const rr = i % 2 === 0 ? r : r * inner;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function sparklePath(ctx, x, y, r) {
  // Estrella de 4 puntas, fina.
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.closePath();
}

// Sprites pre-dibujados (con brillo incluido): mucho más rápido que shadowBlur en cada cuadro.
const spriteCache = new Map();
function getSprite(kind, color) {
  const key = kind + '|' + color;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const S = 128, c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d'); const m = S / 2;
  ctx.fillStyle = color;
  switch (kind) {
    case 'sparkles':
      ctx.shadowColor = color; ctx.shadowBlur = 18;
      sparklePath(ctx, m, m, S * 0.42); ctx.fill(); ctx.fill();
      ctx.shadowBlur = 0; ctx.beginPath(); ctx.arc(m, m, S * 0.07, 0, Math.PI * 2); ctx.fill();
      break;
    case 'stars':
      ctx.shadowColor = '#fff2b3'; ctx.shadowBlur = 16;
      starPath(ctx, m, m, S * 0.42); ctx.fill(); ctx.fill();
      break;
    case 'hearts':
      ctx.shadowColor = color; ctx.shadowBlur = 16;
      heartPath(ctx, m, m - S * 0.2, S * 0.75); ctx.fill(); ctx.fill();
      break;
    case 'bokeh': {
      const g = ctx.createRadialGradient(m, m, 0, m, m, m);
      g.addColorStop(0, color); g.addColorStop(0.6, color); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(m, m, m, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
  spriteCache.set(key, c);
  return c;
}

export const EFFECTS = [
  { id: 'none', name: 'Sin efecto' },
  { id: 'sparkles', name: 'Brillos' },
  { id: 'stars', name: 'Estrellas que caen' },
  { id: 'hearts', name: 'Corazones' },
  { id: 'bokeh', name: 'Bokeh (luces suaves)' },
  { id: 'confetti', name: 'Confeti' },
  { id: 'mix', name: 'Brillos + corazones' },
];

export class Effect {
  constructor(type, { intensity = 2, color = '#ff6fb5', seed = 7 } = {}) {
    this.type = type;
    this.intensity = Math.max(1, Math.min(3, +intensity || 2));
    this.color = color;
    this.rand = rng(seed);
    this.particles = [];
    this.t = 0;
    this.spawnAcc = 0;
  }

  // Cuántas partículas vivas y ritmo de aparición, según tipo e intensidad.
  config(W, H) {
    const k = this.intensity;
    switch (this.type) {
      case 'sparkles': return { max: 45 * k, rate: 18 * k, life: [0.5, 1.4] };
      case 'stars': return { max: 40 * k, rate: 6 * k, life: [2.5, 4.5] };
      case 'hearts': return { max: 20 * k, rate: 2 * k, life: [3, 5] };
      case 'bokeh': return { max: 14 * k, rate: 3 * k, life: [4, 7] };
      case 'confetti': return { max: 110 * k, rate: 22 * k, life: [2.5, 4] };
      case 'mix': return { max: 40 * k, rate: 14 * k, life: [0.6, 3.5] };
      default: return { max: 0, rate: 0, life: [1, 1] };
    }
  }

  spawn(W, H, cfg) {
    const r = this.rand;
    // (los corazones viven más que los brillos: con 1 de cada 12 la mezcla queda pareja)
    const kind = this.type === 'mix' ? (r() < 0.92 ? 'sparkles' : 'hearts') : this.type;
    const life = cfg.life[0] + r() * (cfg.life[1] - cfg.life[0]);
    const base = { kind, age: 0, life, x: r() * W, y: r() * H, rot: r() * Math.PI * 2, vr: (r() - 0.5) * 2, phase: r() * Math.PI * 2 };
    const u = Math.min(W, H) / 720;
    // Los que viajan (estrellas y confeti caen, corazones suben) viven lo que tardan en cruzar la pantalla
    // (antes morían por edad a mitad de camino y nunca llegaban abajo o arriba).
    const cross = (vy) => (H + 200 * u) / Math.max(1, Math.abs(vy));
    switch (kind) {
      case 'sparkles': return { ...base, s: (6 + r() * 14) * u, vx: 0, vy: 0, hue: r() < 0.5 ? '#ffffff' : '#ffe9a3' };
      case 'stars': { const vy = (90 + r() * 120) * u; return { ...base, travel: true, life: cross(vy), y: -40 * u, s: (8 + r() * 16) * u, vx: (r() - 0.5) * 40 * u, vy, hue: r() < 0.6 ? '#fff4c2' : '#ffffff' }; }
      case 'hearts': { const vy = -(110 + r() * 130) * u; return { ...base, travel: true, life: cross(vy), y: H + 40 * u, s: (16 + r() * 26) * u, vx: (r() - 0.5) * 30 * u, vy, hue: this.color }; }
      case 'bokeh': return { ...base, s: (30 + r() * 80) * u, vx: (r() - 0.5) * 20 * u, vy: -(10 + r() * 25) * u, hue: ['#ffd1e8', '#fff2b3', '#d7c3ff', '#ffffff'][Math.floor(r() * 4)] };
      case 'confetti': return { ...base, travel: true, life: cross((120 + 160) * u), flip: 3 + r() * 5, y: -30 * u, s: (11 + r() * 12) * u, vx: (r() - 0.5) * 80 * u, vy: (120 + r() * 160) * u, hue: ['#ff5c8a', '#ffd166', '#06d6a0', '#4cc9f0', '#f8f1ff', '#c77dff'][Math.floor(r() * 6)] };
    }
    return base;
  }

  // Hace correr la animación `seconds` segundos sin mostrarla: así el video no empieza vacío.
  warmup(W, H, seconds, dt) {
    if (this.type === 'none') return;
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const x = c.getContext('2d');
    for (let t = 0; t < seconds; t += dt) this.render(x, W, H, dt);
  }

  // Avanza un paso de tiempo y dibuja. dt en segundos (fijo para que sea determinista).
  render(ctx, W, H, dt) {
    if (this.type === 'none') return;
    const cfg = this.config(W, H);
    this.t += dt;
    this.spawnAcc += cfg.rate * dt;
    while (this.spawnAcc >= 1 && this.particles.length < cfg.max) {
      this.particles.push(this.spawn(W, H, cfg));
      this.spawnAcc -= 1;
    }
    if (this.spawnAcc > 5) this.spawnAcc = 5;
    const u = Math.min(W, H) / 720;
    ctx.save();
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life || p.y < -120 * u || p.y > H + 120 * u) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const k = p.age / p.life;
      // Los que viajan aparecen en 0,3 s y se van por el borde; los demás nacen y se apagan en el lugar.
      let alpha = p.travel ? Math.min(1, p.age / 0.3, (p.life - p.age) / 0.6) : k < 0.15 ? k / 0.15 : k > 0.75 ? (1 - k) / 0.25 : 1;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = p.hue;
      switch (p.kind) {
        case 'sparkles': {
          const tw = 0.6 + 0.4 * Math.sin(this.t * 9 + p.phase);
          const d = p.s * tw * 2.6;
          ctx.drawImage(getSprite('sparkles', p.hue), p.x - d / 2, p.y - d / 2, d, d);
          break;
        }
        case 'stars': {
          const d = p.s * 2.6;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.drawImage(getSprite('stars', p.hue), -d / 2, -d / 2, d, d);
          ctx.restore();
          break;
        }
        case 'hearts': {
          const sway = Math.sin(this.t * 2 + p.phase) * 18 * u;
          const d = p.s * 1.6;
          ctx.save(); ctx.translate(p.x + sway, p.y); ctx.rotate(Math.sin(this.t + p.phase) * 0.25);
          ctx.drawImage(getSprite('hearts', p.hue), -d / 2, -d / 2, d, d);
          ctx.restore();
          break;
        }
        case 'bokeh': {
          ctx.globalAlpha *= 0.35;
          ctx.drawImage(getSprite('bokeh', p.hue), p.x - p.s, p.y - p.s, p.s * 2, p.s * 2);
          break;
        }
        case 'confetti': {
          // Papelito que da vueltas: se achica y se oscurece cuando queda de canto.
          const turn = Math.cos(this.t * (p.flip || 4) + p.phase);
          ctx.save(); ctx.translate(p.x + Math.sin(this.t * 3 + p.phase) * 20 * u, p.y); ctx.rotate(p.rot * 3);
          ctx.scale(1, Math.max(0.12, Math.abs(turn)));
          ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
          ctx.globalAlpha *= (1 - Math.abs(turn)) * 0.45;
          ctx.fillStyle = '#000';
          ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
          ctx.restore();
          break;
        }
      }
    }
    ctx.restore();
  }
}
