// Pulso de la canción: tempo (BPM) y en qué momentos caen los golpes, para que los cambios de velocidad del video
// caigan justo sobre la música. Todo en el teléfono, sin internet.
//
// Cómo: se arma una curva de "golpes" (subidas bruscas de energía, sobre todo en los graves: bombo, palmas), se busca
// cada cuánto se repite (autocorrelación entre 70 y 180 BPM, con preferencia por ~120) y en qué fase cae la grilla.
// Devuelve una grilla regular (más firme que tomar cada pico suelto) o null si la canción no tiene un pulso claro.

const HOP = 0.01; // 10 ms por paso
const STRENGTH_MIN = 1.0; // fuerza mínima de los golpes (sostenido sin pulso ≈ 0,35; canción con batería ≈ 6; bombo marcado ≈ 20)

export function detectBeats(buffer, start = 0, length = buffer.duration - start) {
  const sr = buffer.sampleRate;
  const i0 = Math.max(0, Math.floor(start * sr));
  const i1 = Math.min(buffer.length, Math.floor((start + length) * sr));
  const n = i1 - i0;
  if (n < sr * 4) return null; // con menos de 4 s no se puede saber el tempo
  const hop = Math.round(HOP * sr);
  const steps = Math.floor(n / hop);
  // Mono, y dos bandas: graves (filtro de 1 polo a ~180 Hz) y todo el espectro.
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const a = 1 - Math.exp((-2 * Math.PI * 180) / sr);
  let low = 0;
  const eLow = new Float32Array(steps), eAll = new Float32Array(steps);
  for (let s = 0; s < steps; s++) {
    let sl = 0, sa = 0;
    const base = i0 + s * hop;
    for (let k = 0; k < hop; k++) {
      let x = 0;
      for (const ch of chans) x += ch[base + k];
      x /= chans.length;
      low += a * (x - low);
      sl += low * low; sa += x * x;
    }
    eLow[s] = Math.log(1e-9 + sl); eAll[s] = Math.log(1e-9 + sa);
  }
  // Curva de golpes: cuánto sube la energía de un paso al siguiente (solo subidas).
  const onset = new Float32Array(steps);
  for (let s = 1; s < steps; s++) onset[s] = Math.max(0, eLow[s] - eLow[s - 1]) * 1.4 + Math.max(0, eAll[s] - eAll[s - 1]);
  // ¿Hay golpes de verdad? Un bombo o un aplauso sube la energía varias veces de golpe; un sonido sostenido
  // (pads, una voz larga) solo tiene ondulaciones chiquitas, que no alcanzan para buscarle un pulso.
  const sorted = Array.from(onset).sort((x, y) => y - x);
  const top = sorted.slice(0, Math.max(5, Math.round(steps * 0.02)));
  const strength = top.reduce((x, y) => x + y, 0) / top.length;
  if (strength < STRENGTH_MIN) return null;
  // Sacar la parte lenta (promedio local de 1 s) para que cuente lo que "golpea".
  const w = 50;
  const flux = new Float32Array(steps);
  let acc = 0;
  for (let s = 0; s < steps; s++) {
    acc += onset[s];
    if (s >= 2 * w) acc -= onset[s - 2 * w];
    const m = acc / Math.min(s + 1, 2 * w);
    flux[s] = Math.max(0, onset[s] - m);
  }
  // Tempo: autocorrelación en el rango de 70 a 180 BPM, con preferencia suave por ~120 BPM.
  const lagMin = Math.round(60 / 180 / HOP), lagMax = Math.round(60 / 70 / HOP);
  let e0 = 0;
  for (let s = 0; s < steps; s++) e0 += flux[s] * flux[s];
  if (e0 <= 0) return null;
  let best = -1, bestScore = -Infinity, bestAc = 0;
  for (let L = lagMin; L <= lagMax; L++) {
    let ac = 0;
    for (let s = L; s < steps; s++) ac += flux[s] * flux[s - L];
    const bpm = 60 / (L * HOP);
    const pref = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = ac * pref;
    if (score > bestScore) { bestScore = score; best = L; bestAc = ac; }
  }
  const confidence = bestAc / e0;
  // (una canción con pulso marcado da 0,5 o más; sin pulso claro, menos de 0,3: ahí no se toca nada)
  if (best < 0 || confidence < 0.3) return null;
  // Período fino (fracciones de paso) y fase: la grilla que más golpes junta.
  const comb = (P, phase) => {
    let sc = 0;
    for (let t = phase; t < steps - 1; t += P) {
      const k = Math.round(t);
      sc += Math.max(flux[k] || 0, flux[k - 1] || 0, flux[k + 1] || 0);
    }
    return sc;
  };
  let bestP = best, bestPhase = 0, bestComb = -Infinity;
  for (let P = best - 1; P <= best + 1.0001; P += 0.05) {
    for (let ph = 0; ph < P; ph += 0.5) {
      const sc = comb(P, ph);
      if (sc > bestComb) { bestComb = sc; bestP = P; bestPhase = ph; }
    }
  }
  const beats = [];
  for (let t = bestPhase; t * HOP < length; t += bestP) beats.push(+(t * HOP).toFixed(4));
  return { bpm: +(60 / (bestP * HOP)).toFixed(1), beats, confidence: +confidence.toFixed(3), strength: +strength.toFixed(2) };
}
