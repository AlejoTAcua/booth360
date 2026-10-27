// Música: decodificación, recorte, fundidos y codificación AAC para el MP4 final.
import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink, EncodedPacket, EncodedAudioPacketSource } from '../vendor/mediabunny.min.mjs';

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

let ctx = null;
export function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

export async function decodeAudio(blob) {
  const ab = await blob.arrayBuffer();
  const ac = audioContext();
  return new Promise((resolve, reject) => {
    // Forma con callbacks: compatible con Safari viejo.
    const p = ac.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

// Picos para dibujar la forma de onda.
export function waveformPeaks(buffer, n = 300) {
  const ch = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / n));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const s = i * step, e = Math.min(ch.length, s + step);
    for (let j = s; j < e; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

// Devuelve un AudioBuffer estéreo de exactamente `duration` segundos a `sampleRate`.
export async function buildMusicBuffer(decoded, { start = 0, duration, fadeIn = true, fadeOut = true, sampleRate = 48000 }) {
  const frames = Math.max(1, Math.round(duration * sampleRate));
  const oc = new OfflineAudioContext(2, frames, sampleRate);
  const src = oc.createBufferSource();
  src.buffer = decoded;
  const gain = oc.createGain();
  gain.gain.setValueAtTime(fadeIn ? 0 : 1, 0);
  if (fadeIn) gain.gain.linearRampToValueAtTime(1, Math.min(0.4, duration / 4));
  if (fadeOut) {
    const fo = Math.min(1.5, duration / 3);
    gain.gain.setValueAtTime(1, Math.max(0, duration - fo));
    gain.gain.linearRampToValueAtTime(0, duration);
  }
  src.connect(gain).connect(oc.destination);
  const off = Math.max(0, Math.min(start, Math.max(0, decoded.duration - 0.05)));
  src.start(0, off, duration);
  const out = await oc.startRendering();
  normalizeLoudness(out);
  return out;
}

// Lleva el tramo a un volumen parejo (≈ -14 LUFS, el de Instagram/TikTok/WhatsApp), sin pasarse de -2 dBFS de pico.
// Mide como la norma de loudness (filtro K: realce de agudos + corte de graves, bloques de 400 ms con compuertas),
// así una canción bajita y una fuerte salen parecidas. Sube como mucho 12 dB y baja como mucho 12 dB.
export function normalizeLoudness(buf, { target = -14, maxGainDb = 12, peakDb = -2 } = {}) {
  const lufs = measureLufs(buf);
  if (!Number.isFinite(lufs)) return { lufs, gainDb: 0 };
  let gainDb = Math.max(-maxGainDb, Math.min(maxGainDb, target - lufs));
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak > 0) gainDb = Math.min(gainDb, peakDb - 20 * Math.log10(peak));
  const g = Math.pow(10, gainDb / 20);
  if (Math.abs(gainDb) > 0.05) for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  return { lufs, gainDb };
}

// Loudness integrado (ITU-R BS.1770) de un AudioBuffer. Devuelve -Infinity si es silencio.
export function measureLufs(buf) {
  const sr = buf.sampleRate;
  // Filtro K en dos etapas (biquads de la norma, recalculados para la frecuencia de muestreo).
  const shelf = biquad('highshelf', sr, 1681.97, 3.99984, 0.7071752);
  const hp = biquad('highpass', sr, 38.13547, 0, 0.5003270);
  const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
  const n = buf.length;
  if (n < block) return -Infinity;
  const ms = []; // potencia por bloque (suma de canales)
  const sq = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    const y = new Float32Array(n);
    runBiquad(shelf, x, y);
    runBiquad(hp, y, y);
    const s2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) s2[i + 1] = s2[i] + y[i] * y[i];
    sq.push(s2);
  }
  for (let i = 0; i + block <= n; i += hop) {
    let z = 0;
    for (const s2 of sq) z += (s2[i + block] - s2[i]) / block;
    ms.push(z);
  }
  const L = (z) => -0.691 + 10 * Math.log10(z);
  const abs = ms.filter((z) => z > 0 && L(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => L(z) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}
function biquad(type, sr, f0, gainDb, q) {
  const A = Math.pow(10, gainDb / 40), w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highshelf') {
    const s = 2 * Math.sqrt(A) * al;
    b0 = A * ((A + 1) + (A - 1) * cs + s); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s);
    a0 = (A + 1) - (A - 1) * cs + s; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s;
  } else {
    b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function runBiquad(k, x, y) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = k.b0 * xi + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
}

function buildAsc(sampleRate, channels) {
  const fi = AAC_RATES.indexOf(sampleRate);
  const b0 = (2 << 3) | (fi >> 1);
  const b1 = ((fi & 1) << 7) | (channels << 3);
  return new Uint8Array([b0, b1]);
}

function ascLooksValid(desc, sampleRate, channels) {
  if (!desc) return false;
  const u = desc instanceof Uint8Array ? desc : new Uint8Array(desc.buffer ? desc.buffer : desc);
  if (u.length < 2 || u.length > 7) return false;
  const objectType = u[0] >> 3;
  const fi = ((u[0] & 7) << 1) | (u[1] >> 7);
  const ch = (u[1] >> 3) & 15;
  return objectType === 2 && AAC_RATES[fi] === sampleRate && ch === channels;
}

export function canEncodeAac() {
  return typeof AudioEncoder !== 'undefined';
}

// Comprueba en tiempo de ejecución si el navegador realmente puede codificar AAC.
export async function aacSupported(sampleRate = 48000, numberOfChannels = 2) {
  if (!canEncodeAac()) return false;
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 128000 });
    return !!(r && r.supported);
  } catch (e) { return false; }
}

/**
 * Codifica un AudioBuffer a AAC y empuja los paquetes a `source` (EncodedAudioPacketSource('aac')).
 * Se llama después de output.start().
 */
export async function encodeAacInto(source, buffer) {
  const sampleRate = buffer.sampleRate, numberOfChannels = buffer.numberOfChannels;
  const cfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 128000 };
  const sup = await AudioEncoder.isConfigSupported(cfg);
  if (!sup || !sup.supported) throw new Error('AAC no soportado por AudioEncoder');
  let meta = null;
  const packets = [];
  let firstErr = null;
  const enc = new AudioEncoder({
    output: (chunk, m) => {
      if (!meta && m && m.decoderConfig) {
        const dc = { ...m.decoderConfig };
        const data0 = new Uint8Array(chunk.byteLength); chunk.copyTo(data0);
        const isAdts = data0.length > 1 && data0[0] === 0xff && (data0[1] & 0xf6) === 0xf0;
        if (isAdts) delete dc.description; // mediabunny lo deduce del encabezado ADTS
        else if (!ascLooksValid(dc.description, sampleRate, numberOfChannels)) dc.description = buildAsc(sampleRate, numberOfChannels);
        meta = { decoderConfig: dc };
      }
      const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
      packets.push(new EncodedPacket(data, chunk.type, chunk.timestamp / 1e6, (chunk.duration || 0) / 1e6));
    },
    error: (e) => { firstErr = e; },
  });
  enc.configure(cfg);
  try {
  const CH = 1024;
  const planes = [];
  for (let c = 0; c < numberOfChannels; c++) planes.push(buffer.getChannelData(c));
  for (let pos = 0; pos < buffer.length; pos += CH) {
    const n = Math.min(CH, buffer.length - pos);
    const data = new Float32Array(n * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) data.set(planes[c].subarray(pos, pos + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels, timestamp: Math.round(pos / sampleRate * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (firstErr) throw firstErr;
  }
  await enc.flush();
  } finally {
    try { if (enc.state !== 'closed') enc.close(); } catch (e) { /* */ }
  }
  if (firstErr) throw firstErr;
  if (!meta) meta = { decoderConfig: { codec: 'mp4a.40.2', sampleRate, numberOfChannels, description: buildAsc(sampleRate, numberOfChannels) } };
  for (const p of packets) await source.add(p, meta);
}

/**
 * Alternativa sin AudioEncoder: copia los paquetes AAC/MP3 del archivo original (sin fundidos).
 * Devuelve { codec, run } o null si no se puede. `run(source)` se llama después de output.start().
 */
export async function preparePassthrough(blob, { start = 0, duration }) {
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const codec = await track.getCodec();
    if (codec !== 'aac' && codec !== 'mp3') return null;
    const decoderConfig = await track.getDecoderConfig();
    return {
      codec,
      async run(source) {
        const sink = new EncodedPacketSink(track);
        let p = await sink.getKeyPacket(start) || await sink.getFirstPacket();
        const t0 = p ? p.timestamp : 0;
        while (p && p.timestamp - t0 < duration) {
          await source.add(new EncodedPacket(p.data, 'key', p.timestamp - t0, p.duration, p.sequenceNumber), { decoderConfig });
          p = await sink.getNextPacket(p);
        }
      },
    };
  } catch (e) {
    console.warn('passthrough', e);
    return null;
  }
}

export { EncodedAudioPacketSource };
