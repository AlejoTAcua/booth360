// Motor de edición: lee el clip grabado (all-intra), aplica línea de tiempo (velocidades / reverso),
// efectos, superposición y música, y produce el MP4 final con WebCodecs.
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, Output, Mp4OutputFormat, BufferTarget,
  CanvasSource, Conversion, EncodedAudioPacketSource, EncodedPacketSink,
} from '../vendor/mediabunny.min.mjs';
import { expandTimeline, outputSize } from './settings.js';
import { Effect } from './effects.js';
import { drawOverlay, ensureFontLoaded } from './overlay.js';
import { pickVideoCodec } from './capture.js';
import { buildMusicBuffer, decodeAudio, encodeAacInto, preparePassthrough, aacSupported } from './audio.js';
import { detectBeats } from './beats.js';

class FrameSource {
  constructor(input, track, sink, fps, duration) {
    this.input = input; this.track = track; this.sink = sink; this.fps = fps; this.duration = duration;
    this.count = Math.max(1, Math.round(duration * fps));
    this.cache = new Map();
  }
  static async open(blob, fpsHint) {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('El clip no tiene video.');
    const duration = await track.computeDuration();
    let fps = fpsHint;
    if (!fps) {
      const stats = await track.computePacketStats(200);
      fps = Math.round(stats.averagePacketRate) || 30;
    }
    const sink = new VideoSampleSink(track);
    return new FrameSource(input, track, sink, fps, duration);
  }
  async frame(i) {
    i = Math.max(0, Math.min(this.count - 1, i));
    if (this.cache.has(i)) return this.cache.get(i);
    const ts = (i + 0.5) / this.fps;
    const sample = await this.sink.getSample(Math.min(ts, Math.max(0, this.duration - 0.0005)));
    if (!sample) return null;
    const vf = sample.toVideoFrame();
    sample.close();
    this.cache.set(i, vf);
    // Cache muy chico: alcanza para el suavizado (cuadro i e i+1).
    if (this.cache.size > 3) {
      const first = this.cache.keys().next().value;
      const old = this.cache.get(first); this.cache.delete(first); old && old.close();
    }
    return vf;
  }
  close() { for (const f of this.cache.values()) f.close(); this.cache.clear(); }

  // Lector para un render. Usa un solo VideoDecoder para todo el video (antes se creaba uno por cuadro: muy lento
  // en el iPhone). Como cada cuadro del clip grabado es keyframe, cualquiera se decodifica sin leer los anteriores.
  // Decodifica de a un cuadro y guarda solo los últimos `keep`: si se retienen muchos cuadros decodificados (o se
  // lee de más), el codificador del video final se traba. Si algo falla, usa el método de antes para ese cuadro.
  reader(keep) {
    const self = this;
    let dec = null, packets = null, failed = null, want = null, ready = null;
    const win = new Map();
    const start = () => (ready ??= (async () => {
      try {
        if (typeof VideoDecoder === 'undefined') throw new Error('sin VideoDecoder');
        const cfg = await self.track.getDecoderConfig();
        const sup = cfg && await VideoDecoder.isConfigSupported(cfg);
        if (!sup || !sup.supported) throw new Error('configuración no soportada');
        packets = new EncodedPacketSink(self.track);
        dec = new VideoDecoder({
          output: (f) => { if (want) { const w = want; want = null; w(f); } else f.close(); },
          error: (e) => { failed = e; if (want) { const w = want; want = null; w(null); } },
        });
        dec.configure({ ...cfg, optimizeForLatency: true });
      } catch (e) { failed = e; console.warn('Lector de cuadros: se usa el método lento', e); }
    })());
    const decodeOne = async (i) => {
      await start();
      const t = Math.min((i + 0.5) / self.fps, Math.max(0, self.duration - 0.0005));
      if (!failed && dec && dec.state === 'configured') {
        const pk = await packets.getPacket(t);
        if (pk && pk.type === 'key') {
          const got = new Promise((r) => { want = r; });
          dec.decode(pk.toEncodedVideoChunk());
          dec.flush().catch((e) => { failed = e; if (want) { const w = want; want = null; w(null); } });
          const f = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 4000))]);
          if (f) return f;
          want = null; // (si llega tarde, se cierra)
        }
      }
      const sample = await self.sink.getSample(t);
      if (!sample) return null;
      try { return sample.toVideoFrame(); } finally { sample.close(); }
    };
    return {
      async get(i) {
        i = Math.max(0, Math.min(self.count - 1, i));
        if (win.has(i)) return win.get(i);
        const vf = await decodeOne(i);
        win.set(i, vf);
        while (win.size > keep) { const first = win.keys().next().value; const old = win.get(first); win.delete(first); old && old.close(); }
        return vf;
      },
      close() {
        for (const f of win.values()) f && f.close();
        win.clear();
        try { if (dec && dec.state !== 'closed') dec.close(); } catch (e) { /* */ }
      },
    };
  }
}

function drawCover(ctx, img, iw, ih, W, H) {
  const s = Math.max(W / iw, H / ih);
  const sw = W / s, sh = H / s;
  const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
}

/**
 * Plan de cuadros: para cada cuadro de salida, índice de cuadro fuente (fraccionario).
 */
// Cuadros de movimiento de cada pasada (sin la pausa), según su velocidad.
function passFrames(passes, clipSec, outFps) {
  return passes.map((p) => Math.max(1, Math.round(clipSec * (p.to - p.from) / p.speed * outFps)));
}

// counts: cuadros de movimiento de cada pasada (si se ajustaron al ritmo); si no, salen de la velocidad.
// Devuelve el plan y dónde termina cada pasada (en cuadros de salida).
function buildPlan(timeline, clipFps, clipFrames, outFps, counts = null) {
  const passes = expandTimeline(timeline);
  const clipSec = clipFrames / clipFps;
  const moves = counts || passFrames(passes, clipSec, outFps);
  const plan = [];
  const ends = [];
  passes.forEach((p, i) => {
    const outN = moves[i];
    let last = 0;
    for (let k = 0; k < outN; k++) {
      const u = k / outN; // 0..1 dentro de la pasada (la siguiente arranca en su propio comienzo: sin cuadros repetidos)
      const frac = p.dir === 'fwd' ? p.from + u * (p.to - p.from) : p.to - u * (p.to - p.from);
      last = frac * (clipFrames - 1);
      plan.push(last);
    }
    // Pausa: la imagen queda congelada en el último cuadro del tramo.
    for (let k = 0, n = Math.round((p.hold || 0) * outFps); k < n; k++) plan.push(Math.round(last));
    ends.push(plan.length);
  });
  if (!plan.length) plan.push(0);
  return { plan, ends };
}

// Ajusta el largo de cada pasada para que los cambios de velocidad (y el final) caigan sobre un golpe de la canción.
// Solo corre cada borde hasta un 30 % del largo de su pasada (máx. 0,45 s): la edición se sigue viendo igual.
function snapToBeats(timeline, clipFps, clipFrames, outFps, beats) {
  const passes = expandTimeline(timeline);
  const moves = passFrames(passes, clipFrames / clipFps, outFps);
  const holds = passes.map((p) => Math.round((p.hold || 0) * outFps));
  const beatFrames = beats.map((b) => Math.round(b * outFps));
  let t = 0;
  let snapped = 0;
  const out = moves.slice();
  for (let i = 0; i < passes.length; i++) {
    const end = t + moves[i] + holds[i];
    const tol = Math.min(Math.round(0.45 * outFps), Math.round(0.3 * moves[i]));
    let bestB = null;
    for (const b of beatFrames) if (Math.abs(b - end) <= tol && (bestB === null || Math.abs(b - end) < Math.abs(bestB - end))) bestB = b;
    if (bestB !== null && bestB - t - holds[i] >= 2) { out[i] = bestB - t - holds[i]; snapped++; }
    t += out[i] + holds[i];
  }
  return { counts: out, snapped };
}

// Filtros de color sobre la imagen de la cámara, con mezclas del canvas (rápidas en el iPhone).
function applyLook(ctx, W, H, look, canvas) {
  if (!look || look === 'none') return;
  ctx.save();
  const fill = (op, color, alpha = 1) => { ctx.globalCompositeOperation = op; ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); };
  const self = (op, alpha) => { ctx.globalCompositeOperation = op; ctx.globalAlpha = alpha; ctx.drawImage(canvas, 0, 0); };
  switch (look) {
    case 'bn': fill('saturation', '#808080'); break;
    case 'glam': fill('saturation', '#808080'); self('soft-light', 0.9); break;
    case 'calido': fill('multiply', '#fff0d6', 1); fill('soft-light', '#ff9b3d', 0.35); break;
    case 'frio': fill('multiply', '#dae8ff', 1); fill('soft-light', '#3f8cff', 0.3); break;
    case 'vintage': fill('saturation', '#808080', 0.35); fill('multiply', '#f2d6aa', 0.55); fill('screen', '#3a2614', 0.35); break;
    case 'vivo': self('soft-light', 0.55); break;
  }
  ctx.restore();
}

/**
 * Renderiza. opts: { clip:{blob,fps}, settings, overlayImage, music:{blob,start}|null, canvas, onProgress, signal }
 * Devuelve { blob, duration, width, height }
 */
export async function renderVideo(opts) {
  const { clip, settings, overlayImage, music, canvas, onProgress, signal, endCard } = opts;
  const { width: W, height: H } = outputSize(settings.output.res);
  const outFps = +settings.output.fps || 30;
  const src = await FrameSource.open(clip.blob, clip.fps);
  // Al ritmo de la música: se decodifica la canción antes, se buscan los golpes y se ajustan los cambios de velocidad.
  let decodedMusic = null;
  let beatInfo = null;
  let counts = null;
  if (music && music.blob && settings.music && settings.music.beatSync !== false) {
    try {
      decodedMusic = await decodeAudio(music.blob);
      const nominal = buildPlan(settings.timeline, src.fps, src.count, outFps).plan.length / outFps;
      const found = detectBeats(decodedMusic, music.start || 0, nominal + 3);
      if (found && found.beats.length >= 2) {
        const r = snapToBeats(settings.timeline, src.fps, src.count, outFps, found.beats);
        if (r.snapped) { counts = r.counts; beatInfo = { bpm: found.bpm, snapped: r.snapped, beats: found.beats }; }
      }
    } catch (e) { console.warn('Ritmo de la canción:', e); }
  }
  const { plan, ends } = buildPlan(settings.timeline, src.fps, src.count, outFps, counts);
  // Placa final (logo o marca): aparece con un fundido sobre el último cuadro.
  const endImg = endCard && endCard.image;
  const endFrames = endImg ? Math.round(Math.max(0.5, +endCard.seconds || 2) * outFps) : 0;
  const duration = (plan.length + endFrames) / outFps;

  canvas.width = W; canvas.height = H;
  // (sin "desynchronized": con ese modo el codificador a veces tomaba el cuadro anterior y el video tenía saltitos)
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  await ensureFontLoaded(settings.overlay, H);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const bitrate = Math.round((+settings.output.mbps || 6) * 1e6);
  const codec = await pickVideoCodec({ width: W, height: H, bitrate, latencyMode: 'quality' });
  const vsrc = new CanvasSource(canvas, {
    codec, bitrate, keyFrameInterval: 2,
    latencyMode: 'quality', hardwareAcceleration: 'no-preference',
  });
  output.addVideoTrack(vsrc, { frameRate: outFps });

  // Audio
  let audioJob = null;
  if (music && music.blob) {
    try {
      // AAC a 48 kHz; si el iPhone no lo permite, a 44,1 kHz (antes se perdían los fundidos en ese caso).
      const rate = (await aacSupported(48000, 2)) ? 48000 : (await aacSupported(44100, 2)) ? 44100 : 0;
      if (rate) {
        const decoded = decodedMusic || await decodeAudio(music.blob);
        const buf = await buildMusicBuffer(decoded, { start: music.start || 0, duration, fadeIn: settings.music.fadeIn, fadeOut: settings.music.fadeOut, sampleRate: rate });
        const asrc = new EncodedAudioPacketSource('aac');
        output.addAudioTrack(asrc);
        audioJob = () => encodeAacInto(asrc, buf);
      } else {
        const pt = await preparePassthrough(music.blob, { start: music.start || 0, duration });
        if (pt) {
          const asrc = new EncodedAudioPacketSource(pt.codec);
          output.addAudioTrack(asrc);
          audioJob = () => pt.run(asrc);
        }
      }
    } catch (e) {
      console.warn('Audio no disponible, se renderiza sin música:', e);
      audioJob = null;
    }
  }

  await output.start();
  if (audioJob) {
    try { await audioJob(); } catch (e) { console.warn('Falló el audio:', e); }
  }

  const effect = new Effect(settings.effects.type, { intensity: settings.effects.intensity, color: settings.effects.color, seed: 1234 });
  effect.warmup(W, H, 6, 1 / outFps); // las partículas ya están en pantalla desde el primer cuadro
  const smooth = !!settings.timeline.smooth;
  const dt = 1 / outFps;
  // La superposición (texto o PNG) no cambia en todo el video: se dibuja una vez y se pega en cada cuadro.
  let ovCanvas = null;
  if (settings.overlay && settings.overlay.mode !== 'none') {
    ovCanvas = document.createElement('canvas');
    ovCanvas.width = W; ovCanvas.height = H;
    drawOverlay(ovCanvas.getContext('2d'), W, H, settings.overlay, overlayImage);
  }
  // Qué cuadros fuente usa cada cuadro de salida (con el suavizado, dos) y en qué orden se leen.
  const KEEP = 3; // cuadros decodificados que se guardan (con más, el codificador se puede trabar)
  // En los tramos lentos el punto de lectura se corre medio paso: a 0,5x cada cuadro sale 75/25 (antes alternaba uno
  // nítido y uno con doble imagen al 50 %, y la cámara lenta "latía"). A 0,25x: 12/88, 38/62… siempre parejo.
  const needs = plan.map((f0, k) => {
    const step = k + 1 < plan.length ? Math.abs(plan[k + 1] - f0) : k > 0 ? Math.abs(f0 - plan[k - 1]) : 1;
    const slow = smooth && step < 0.95;
    const f = slow ? Math.min(src.count - 1, f0 + step / 2) : f0;
    const i0 = Math.max(0, Math.min(src.count - 1, Math.floor(f)));
    const frac = f - Math.floor(f);
    return slow && frac > 0.02 && i0 + 1 < src.count ? [i0, i0 + 1, frac] : [i0, null, 0];
  });
  const reader = src.reader(KEEP);
  const missing = []; // cuadros fuente que no se pudieron leer
  let lastOk = false;
  let finished = false;
  try {
    for (let k = 0; k < plan.length; k++) {
      if (signal && signal.aborted) throw new DOMException('Cancelado', 'AbortError');
      const [j0, j1, frac] = needs[k];
      const a = await reader.get(j0);
      if (a) {
        drawCover(ctx, a, a.displayWidth || a.codedWidth, a.displayHeight || a.codedHeight, W, H);
        if (j1 != null) {
          const b = await reader.get(j1);
          if (b) {
            ctx.save(); ctx.globalAlpha = frac;
            drawCover(ctx, b, b.displayWidth || b.codedWidth, b.displayHeight || b.codedHeight, W, H);
            ctx.restore();
          }
        }
        applyLook(ctx, W, H, settings.look, canvas);
        lastOk = true;
      } else {
        missing.push(j0);
        if (!lastOk) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
      }
      effect.render(ctx, W, H, dt);
      if (ovCanvas) ctx.drawImage(ovCanvas, 0, 0);
      await vsrc.add(k / outFps, dt);
      if (onProgress && (k % 3 === 0)) onProgress(k / (plan.length + endFrames), k / outFps);
      if (k % 10 === 0) await new Promise(r => setTimeout(r, 0)); // deja respirar a la interfaz
    }
    if (endFrames) {
      // Placa final: el último cuadro queda de fondo y la imagen aparece con un fundido de 0,4 s.
      const snap = document.createElement('canvas');
      snap.width = W; snap.height = H;
      snap.getContext('2d').drawImage(canvas, 0, 0);
      const fadeN = Math.max(1, Math.round(0.4 * outFps));
      const iw = endImg.width, ih = endImg.height;
      for (let e = 0; e < endFrames; e++) {
        if (signal && signal.aborted) throw new DOMException('Cancelado', 'AbortError');
        ctx.globalAlpha = 1;
        ctx.drawImage(snap, 0, 0);
        ctx.globalAlpha = Math.min(1, (e + 1) / fadeN);
        drawCover(ctx, endImg, iw, ih, W, H);
        ctx.globalAlpha = 1;
        effect.render(ctx, W, H, dt);
        await vsrc.add((plan.length + e) / outFps, dt);
        if (onProgress && (e % 3 === 0)) onProgress((plan.length + e) / (plan.length + endFrames), (plan.length + e) / outFps);
      }
    }
    onProgress && onProgress(1, duration);
    await output.finalize();
    finished = true;
  } finally {
    // Siempre se libera todo (cuadros, decodificador y codificador), también si falla o se cancela.
    reader.close();
    src.close();
    if (!finished) { try { await output.cancel(); } catch (e) { /* */ } }
  }
  const buf = output.target.buffer;
  return { blob: new Blob([buf], { type: 'video/mp4' }), duration, width: W, height: H, missing: missing.length, beats: beatInfo, cuts: ends.slice(0, -1).map((f) => f / outFps), end: plan.length / outFps };
}

function checkConversion(conv) {
  if (conv.isValid) return;
  const reasons = (conv.discardedTracks || []).map(d => `${d.track && d.track.type}: ${d.reason}`).join('; ');
  throw new Error('Este video no se puede leer en este dispositivo (' + (reasons || 'códec no soportado') + ').');
}

/**
 * Recomprime un clip (por ejemplo el original all-intra) a un MP4 liviano.
 */
export async function compressClip(blob, { mbps = 3, res = '720', onProgress } = {}) {
  const { width, height } = outputSize(res);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const bitrate = Math.round(mbps * 1e6);
  const codec = await pickVideoCodec({ width, height, bitrate });
  const conv = await Conversion.init({
    input, output,
    video: { codec, bitrate, keyFrameInterval: 2, width, height, fit: 'cover', forceTranscode: true },
    audio: { discard: true },
  });
  checkConversion(conv);
  if (onProgress) conv.onProgress = (p) => onProgress(p);
  await conv.execute();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

/**
 * Convierte un video cualquiera (de Archivos) en un clip all-intra utilizable como video de prueba.
 */
export async function normalizeClip(blob, { fps = 30, res = '720', maxSeconds = 20, onProgress } = {}) {
  const { width, height } = outputSize(res);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const bitrate = Math.min(90e6, Math.round(fps * width * height * 0.6));
  const codec = await pickVideoCodec({ width, height, bitrate });
  const conv = await Conversion.init({
    input, output,
    trim: { start: 0, end: maxSeconds },
    video: { codec, bitrate, keyFrameInterval: 0, width, height, fit: 'cover', frameRate: fps, forceTranscode: true },
    audio: { discard: true },
  });
  checkConversion(conv);
  if (onProgress) conv.onProgress = (p) => onProgress(p);
  await conv.execute();
  const out = new Blob([output.target.buffer], { type: 'video/mp4' });
  const fs = await FrameSource.open(out, fps);
  const info = { blob: out, fps, seconds: fs.duration, width, height, frames: fs.count };
  fs.close();
  return info;
}
