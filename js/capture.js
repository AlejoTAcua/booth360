// Cámara y grabación. Produce un MP4 "all-intra" (cada cuadro es keyframe)
// para poder leer cualquier cuadro al instante durante la edición (cámara lenta / reverso).
import { Output, Mp4OutputFormat, BufferTarget, VideoSampleSource, VideoSample, getFirstEncodableVideoCodec } from '../vendor/mediabunny.min.mjs';

export const support = {
  webcodecs: typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined',
  audioEncoder: typeof AudioEncoder !== 'undefined',
  share: !!(navigator.share && navigator.canShare),
  rvfc: typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
  getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
};

let currentStream = null;

// Elige el códec de video que el dispositivo puede codificar (H.264 en iPhone; VP9/AV1 como respaldo).
export async function pickVideoCodec({ width, height, bitrate, latencyMode = 'quality' }) {
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height, bitrate, latencyMode });
  if (!codec) throw new Error(`Este dispositivo no puede codificar video de ${width}×${height}.`);
  return codec;
}

export async function openCamera({ fps = 30, res = '720', facing = 'environment' } = {}) {
  closeCamera();
  const long = res === '1080' ? 1920 : 1280;
  const short = res === '1080' ? 1080 : 720;
  const attempts = [
    { facingMode: { ideal: facing }, width: { ideal: long }, height: { ideal: short }, frameRate: { ideal: fps } },
    { facingMode: { ideal: facing }, width: { ideal: short }, height: { ideal: long }, frameRate: { ideal: fps } },
    { facingMode: { ideal: facing }, frameRate: { ideal: fps } },
    { facingMode: { ideal: facing } },
    true,
  ];
  let lastErr = null;
  for (const video of attempts) {
    try {
      currentStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!currentStream) throw lastErr || new Error('No se pudo abrir la cámara');
  const track = currentStream.getVideoTracks()[0];
  // Intento de afinar el frame rate si el primer intento no lo aplicó.
  try {
    const st = track.getSettings();
    if (st.frameRate && Math.round(st.frameRate) < fps) {
      await track.applyConstraints({ frameRate: { ideal: fps } });
    }
  } catch (e) { /* no importa */ }
  return { stream: currentStream, track, settings: track.getSettings() };
}

export function closeCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
}

export function cameraSettings() {
  const t = currentStream && currentStream.getVideoTracks()[0];
  return t ? t.getSettings() : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Graba `seconds` segundos del <video> en vivo y devuelve { blob, fps, seconds, width, height, frames }.
 * onProgress(0..1), onFrame(count)
 */
// shouldStop(): si devuelve true, la grabación termina antes (control Bluetooth); se guarda lo grabado (mínimo 1 s).
export async function recordClip(video, { seconds = 15, fps = 30, onProgress, onStatus, shouldStop } = {}) {
  if (!support.webcodecs) throw new Error('Este navegador no soporta WebCodecs (necesario para grabar). Usá Safari 17+ / iOS 17+.');
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('La cámara todavía no entregó imagen.');
  // Dimensiones pares (requisito H.264)
  const width = vw & ~1, height = vh & ~1;
  const bitrate = Math.min(90e6, Math.round(fps * width * height * 0.6));

  const codec = await pickVideoCodec({ width, height, bitrate, latencyMode: 'realtime' });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let encodeError = null;
  const source = new VideoSampleSource({
    codec, bitrate, latencyMode: 'realtime', keyFrameInterval: 0,
    hardwareAcceleration: 'no-preference',
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();

  // Canvas de respaldo si el navegador no permite VideoFrame directo desde <video>.
  // En el iPhone el cuadro de la cámara viene "acostado" (como lo lee el sensor) con una marca de giro que el
  // codificador no aplica: grabado así, al editar el video salía girado. Si el cuadro viene girado, o la cámara
  // cambia de tamaño en medio de la grabación (el teléfono pasó a horizontal), se dibuja en el canvas tal como se ve.
  let useCanvas = false;
  let cv = null, cctx = null;
  const makeSample = (ts) => {
    if (!useCanvas) {
      let vf = null;
      try {
        vf = new VideoFrame(video, { timestamp: Math.round(ts * 1e6), duration: Math.round(1e6 / fps) });
      } catch (e) {
        useCanvas = true;
      }
      if (vf) {
        const straight = !(vf.rotation || 0) && !vf.flip && Math.abs(vf.codedWidth - width) <= 2 && Math.abs(vf.codedHeight - height) <= 2;
        if (straight) return new VideoSample(vf, { timestamp: ts, duration: 1 / fps });
        vf.close();
        useCanvas = true;
      }
    }
    if (!cv) {
      cv = document.createElement('canvas'); cv.width = width; cv.height = height;
      cctx = cv.getContext('2d', { alpha: false });
    }
    // Cubre el cuadro sin estirar (si la cámara pasó a horizontal, se recorta el centro).
    const iw = video.videoWidth || width, ih = video.videoHeight || height;
    const s = Math.max(width / iw, height / ih);
    const sw = width / s, sh = height / s;
    cctx.drawImage(video, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, width, height);
    return new VideoSample(cv, { timestamp: ts, duration: 1 / fps });
  };

  let frames = 0;
  let stopped = false;
  let pending = Promise.resolve();
  let lastIdx = -1;
  const t0 = performance.now();
  const frameDur = 1 / fps;
  onStatus && onStatus('rec');

  let mt0 = null; // reloj de la cámara (más parejo que el del procesador: menos cuadros dobles)
  let inflight = 0;
  const pushFrame = (meta) => {
    let elapsed = (performance.now() - t0) / 1000;
    if (meta && typeof meta.mediaTime === 'number') { if (mt0 === null) mt0 = meta.mediaTime - elapsed; elapsed = Math.max(elapsed - 0.05, Math.min(elapsed + 0.05, meta.mediaTime - mt0)); }
    if (elapsed >= seconds || (elapsed >= 1 && shouldStop && shouldStop())) { stopped = true; return; }
    // Índice de cuadro por tiempo real: evita derivas y duplica si la cámara se atrasa.
    const idx = Math.floor(elapsed * fps + 0.25);
    if (idx <= lastIdx) return;
    // Si el codificador se atrasa (por ejemplo 1080p a 60 fps), no se acumulan cuadros sin fin: se saltea uno
    // (el siguiente rellena el hueco repitiendo) en vez de llenar la memoria.
    if (inflight > 8) return;
    // Si la cámara entrega menos cuadros que `fps`, se rellenan los huecos repitiendo el cuadro actual
    // (como máximo 4 por vez) para que el clip mantenga el tiempo real.
    const first = Math.max(lastIdx + 1, idx - 3);
    for (let i = first; i <= idx; i++) {
      let sample;
      try { sample = makeSample(i * frameDur); } catch (e) { return; }
      frames++;
      inflight++;
      pending = pending.then(() => source.add(sample, { keyFrame: true })).finally(() => { inflight--; }).catch(e => { if (!encodeError) { encodeError = e; console.error('encode', e); stopped = true; } }).finally(() => sample.close());
    }
    lastIdx = idx;
    onProgress && onProgress(Math.min(1, elapsed / seconds));
  };

  await new Promise((resolve) => {
    if (support.rvfc) {
      const loop = (_now, meta) => {
        if (stopped) return resolve();
        pushFrame(meta);
        if (stopped) return resolve();
        video.requestVideoFrameCallback(loop);
      };
      video.requestVideoFrameCallback(loop);
      // Seguro por si el callback deja de dispararse (pantalla apagada, etc.)
      const guard = setInterval(() => { const el = (performance.now() - t0) / 1000; if (el >= seconds || (el >= 1 && shouldStop && shouldStop())) { stopped = true; clearInterval(guard); resolve(); } }, 200);
    } else {
      const iv = setInterval(() => {
        pushFrame();
        if (stopped) { clearInterval(iv); resolve(); }
      }, 1000 / fps / 2);
    }
  });

  onStatus && onStatus('finalizing');
  await pending;
  if (encodeError) { try { await output.cancel(); } catch (e) { /* */ } throw new Error('Error al codificar la grabación: ' + (encodeError.message || encodeError)); }
  await output.finalize();
  const buf = output.target.buffer;
  if (!buf) throw new Error('No se generó el archivo de la grabación.');
  const blob = new Blob([buf], { type: 'video/mp4' });
  await sleep(0);
  return { blob, fps, seconds: (lastIdx + 1) / fps, width, height, frames, codec };
}
