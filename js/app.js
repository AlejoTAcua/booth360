import { db } from './db.js';
import { loadSettings, saveSettings, PRESETS, SPEEDS, FONTS, LOOKS, expandTimeline, finalDuration, outputSize } from './settings.js';
import { support, openCamera, closeCamera, cameraSettings, recordClip } from './capture.js';
import { renderVideo, compressClip, normalizeClip, FrameSource, applyLook } from './render.js';
import { EFFECTS, Effect } from './effects.js';
import { drawOverlay, ensureFontLoaded, overlayParts } from './overlay.js';
import { decodeAudio, waveformPeaks, audioContext } from './audio.js';

const $ = (id) => document.getElementById(id);
const state = {
  settings: loadSettings(),
  lastClip: null,       // última grabación { blob, fps, seconds, width, height }
  lastResult: null,     // último render { blob, duration }
  resultFrom: 'record', // 'record' | 'preview'
  overlayImage: null,   // ImageBitmap
  tracks: [],           // música (assets)
  decodedCache: new Map(),
  previewPlayer: null,
  musicSeq: +(localStorage.getItem('booth360.musicSeq') || 0),
  abort: null,
};

// ---------- utilidades UI ----------
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(text, progress = null, cancellable = false) {
  const b = $('busy');
  if (text === false) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  $('busyText').textContent = text;
  $('busyFill').style.width = progress == null ? '0%' : `${Math.round(progress * 100)}%`;
  $('btnBusyCancel').classList.toggle('hidden', !cancellable);
}
function fmtSec(s) { return `${(Math.round(s * 10) / 10).toFixed(1)} s`; }
function fmtBytes(b) { return b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`; }
function save() { saveSettings(state.settings); renderSummary(); }
function clipSeconds() { return state.lastClip ? state.lastClip.seconds : state.settings.capture.seconds; }

// ---------- inicio ----------
function renderSummary() {
  const s = state.settings;
  const fx = EFFECTS.find(e => e.id === s.effects.type);
  const dur = finalDuration(s.timeline, s.capture.seconds);
  const passes = expandTimeline(s.timeline).map(p => `${p.speed}x${p.dir === 'rev' ? '↩' : ''}${p.hold ? ` ⏸${p.hold}s` : ''}`).join(' · ');
  const look = LOOKS.find((l) => l.id === (s.look || 'none'));
  const musicOn = state.tracks.filter(t => t.enabled !== false).length;
  const parts = overlayParts(s.overlay);
  const ovList = [];
  if (parts.text && (s.overlay.text || '').trim()) ovList.push(`“${escapeHtml((s.overlay.text || '').split('\n')[0])}”`);
  if (parts.stickers.length) ovList.push(parts.stickers.length === 1 ? '1 adorno' : `${parts.stickers.length} adornos`);
  if (parts.image && s.overlay.imageId) ovList.push('marco');
  const ov = ovList.join(' + ') || 'nada';
  const preset = PRESETS.find((p) => p.id === s.timeline.preset);
  $('summary').innerHTML = `
    <div><b>Graba</b> ${s.capture.seconds} s · <b>video</b> de ~${fmtSec(dur)}${dur > 30 ? ' <span class="warnText">· largo: tarda más en editarse (ideal 15–25 s)</span>' : ''}</div>
    <div><b>Velocidades:</b> ${passes}${s.timeline.smooth ? ' · suavizado' : ''}</div>
    <div><b>Efecto:</b> ${fx ? fx.name : '-'} · <b>Filtro:</b> ${look ? look.name : 'Natural'}</div>
    <div><b>Encima:</b> ${ov}</div>
    <div><b>Música:</b> ${musicOn ? `${musicOn} canción(es), ${s.music.mode === 'random' ? 'al azar' : 'en orden'}${s.music.beatSync !== false ? ', al ritmo' : ''}` : '<span class="warnText">sin música: agregá canciones</span>'}</div>`;
  $('tOverlay').textContent = ov === 'nada' ? 'sin nada' : ov.replace(/&\w+;/g, '');
  $('tMusic').textContent = musicOn ? (musicOn === 1 ? '1 canción' : `${musicOn} canciones`) : 'sin música';
  $('tSpeed').textContent = preset ? preset.name : 'Personalizado';
  $('tFx').textContent = `${fx ? fx.name : '-'}${look && look.id !== 'none' ? ' · ' + look.name : ''}`;
  $('tGallery').textContent = 'tus videos';
  if ($('screen-home').classList.contains('active')) drawHomePreview();
}

function checkSupport() {
  const w = $('supportWarn');
  const problems = [];
  if (!support.getUserMedia) problems.push('Este navegador no permite usar la cámara.');
  if (!support.webcodecs) problems.push('Falta WebCodecs: hace falta iOS 17 o superior (Safari) o Chrome/Edge actualizado.');
  if (!support.audioEncoder) problems.push('Sin codificador de audio: la música se copiará sin fundidos (solo MP3/M4A).');
  if (!window.isSecureContext) problems.push('La app debe abrirse por HTTPS para poder usar la cámara.');
  if (problems.length) { w.innerHTML = problems.map(p => `• ${p}`).join('<br>'); w.classList.remove('hidden'); } else w.classList.add('hidden');
  $('deviceInfo').innerHTML = `
    <div>WebCodecs video: ${support.webcodecs ? '✅' : '❌'}</div>
    <div>Codificador de audio AAC: ${support.audioEncoder ? '✅' : '⚠️ no (se copia el audio original)'}</div>
    <div>Compartir archivos: ${support.share ? '✅' : '❌ (se descarga el archivo)'}</div>
    <div>requestVideoFrameCallback: ${support.rvfc ? '✅' : '⚠️ no (captura por temporizador)'}</div>
    <div>Contexto seguro (HTTPS): ${window.isSecureContext ? '✅' : '❌'}</div>
    <div id="storageLine"></div>`;
  db.usage().then(u => { if (u) $('storageLine').textContent = `Almacenamiento de la app: ${fmtBytes(u.usage || 0)} usados de ${fmtBytes(u.quota || 0)} disponibles.`; });
}

// ---------- grabación ----------
let recording = false; // cuenta regresiva o grabación en curso
let capturing = false; // grabando de verdad (después de la cuenta regresiva)
let stopRequested = false; // el control Bluetooth pidió cortar antes

// ---------- empezar al girar la plataforma (opcional: Configuración → 6) ----------
// Usa el giroscopio del iPhone: si gira más rápido que el umbral durante 0,4 s, arranca la grabación (con su cuenta
// regresiva). Se vuelve a habilitar cuando la plataforma queda quieta 2 s. Se apaga con el botón 🔄 de la pantalla de
// grabar o en Configuración, por si el sensor anda mal; el botón rojo funciona siempre.
const THRESHOLDS = { baja: 45, media: 25, alta: 12 }; // grados por segundo
let motionListening = false;
let motionArmed = true;
let fastSince = 0;
let stillSince = 0;
async function askMotionPermission() {
  if (typeof DeviceMotionEvent === 'undefined') throw new Error('Este dispositivo no tiene sensor de movimiento.');
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const r = await DeviceMotionEvent.requestPermission(); // (iOS: tiene que salir de un toque)
    if (r !== 'granted') throw new Error('Sin permiso para usar los sensores de movimiento.');
  }
  if (!motionListening) {
    window.addEventListener('devicemotion', onMotion);
    motionListening = true;
  }
}
function recordReady() {
  return $('screen-record').classList.contains('active') && camOpen && !recording && !$('btnShutter').disabled;
}
function onMotion(e) {
  if (!state.settings.capture.motionStart) return;
  const r = e.rotationRate;
  if (!r) return;
  const speed = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
  const limit = THRESHOLDS[state.settings.capture.motionSensitivity] || 25;
  const now = performance.now();
  if (speed > limit) {
    stillSince = 0;
    fastSince ||= now;
    if (motionArmed && recordReady() && now - fastSince > 400) {
      motionArmed = false;
      updateMotionUi();
      startCountdownAndRecord();
    }
  } else {
    fastSince = 0;
    if (speed < limit / 2) {
      stillSince ||= now;
      if (!motionArmed && !recording && now - stillSince > 2000) {
        motionArmed = true;
        updateMotionUi();
      }
    }
  }
}
function updateMotionUi() {
  const on = !!state.settings.capture.motionStart;
  const b = $('btnMotion');
  b.hidden = false;
  b.classList.toggle('on', on);
  b.classList.toggle('waiting', on && !motionArmed);
  b.textContent = !on ? '🔄 Giro: apagado' : motionArmed ? '🔄 Arranca al girar' : '⏸ Esperando que se detenga';
}
// Prender el sensor (desde un toque: en iOS el permiso solo se puede pedir así). Si no hay permiso, queda el botón.
async function enableMotion(on) {
  const c = state.settings.capture;
  if (!on) {
    c.motionStart = false;
    save();
    updateMotionUi();
    if ($('capMotion')) $('capMotion').checked = false;
    return;
  }
  try {
    await askMotionPermission();
    c.motionStart = true;
    motionArmed = true;
  } catch (e) {
    c.motionStart = false;
    toast(`${e.message} Se graba con el botón.`, 5000);
  }
  save();
  updateMotionUi();
  if ($('capMotion')) $('capMotion').checked = c.motionStart;
}

let camOpen = false;
let camOpening = false; // (mientras se abre, otro pedido no abre una segunda cámara)
let camStream = null;
async function goRecord() {
  // El permiso del sensor tiene que pedirse antes de cualquier espera (iOS solo lo da dentro del toque).
  if (state.settings.capture.motionStart) askMotionPermission().catch((e) => { state.settings.capture.motionStart = false; save(); updateMotionUi(); toast(`${e.message} Se graba con el botón.`, 5000); });
  motionArmed = true;
  show('screen-record');
  updateMotionUi();
  $('renderCanvas').classList.add('hidden');
  $('cam').classList.remove('hidden');
  drawCamOverlay();
  $('recCenter').textContent = ''; $('recStatus').textContent = ''; $('recBar').classList.remove('on');
  $('btnShutter').disabled = true;
  if (camOpening) return;
  camOpening = true;
  try {
    const c = state.settings.capture;
    const { stream, settings } = await openCamera({ fps: c.fps, res: c.res, facing: c.facing });
    camStream = stream;
    const cam = $('cam');
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    camOpen = true;
    const st = cameraSettings() || settings;
    $('camInfo').textContent = `${st.width || '?'}×${st.height || '?'} · ${st.frameRate ? Math.round(st.frameRate) : '?'} fps`;
    $('btnShutter').disabled = false;
  } catch (e) {
    console.error(e);
    toast('No se pudo abrir la cámara: ' + (e.message || e), 5000);
  } finally {
    camOpening = false;
  }
}
function stopCamera() { closeCamera(); camStream = null; camOpen = false; $('cam').srcObject = null; }

async function startCountdownAndRecord() {
  if (recording) return;
  try { const ac = audioContext(); if (ac.state === 'suspended') ac.resume(); } catch (e) { /* */ }
  recording = true;
  stopRequested = false;
  try {
    await countdownAndRecord();
  } finally {
    recording = false;
    capturing = false;
    stopRequested = false;
  }
}
async function countdownAndRecord() {
  const s = state.settings;
  $('btnShutter').disabled = true;
  const center = $('recCenter');
  center.classList.add('text');
  center.textContent = s.capture.readyText || '';
  await wait(s.capture.countdown > 0 ? 900 : 300);
  center.classList.remove('text');
  for (let n = s.capture.countdown; n > 0; n--) {
    center.textContent = String(n);
    beep(n === 1 ? 880 : 660, 0.12);
    await wait(1000);
  }
  center.textContent = '';
  $('recBar').classList.add('on');
  $('recStatus').textContent = 'GRABANDO';
  beep(1046, 0.25);
  let clip;
  stopRequested = false; // (lo que se apretó durante la cuenta regresiva no corta la grabación)
  capturing = true;
  try {
    clip = await recordClip($('cam'), {
      seconds: s.capture.seconds, fps: s.capture.fps,
      shouldStop: () => stopRequested,
      onProgress: (p) => { $('recBarFill').style.width = `${p * 100}%`; },
      onStatus: (st) => { if (st === 'finalizing') $('recStatus').textContent = 'Guardando…'; },
    });
  } catch (e) {
    console.error(e);
    toast('Error al grabar: ' + (e.message || e), 5000);
    $('recBar').classList.remove('on'); $('recStatus').textContent = ''; $('btnShutter').disabled = false;
    return;
  }
  capturing = false;
  $('recBar').classList.remove('on');
  $('recStatus').textContent = '';
  state.lastClip = clip;
  await processClip(clip, 'record');
}

async function processClip(clip, from) {
  state.resultFrom = from;
  const s = state.settings;
  // Mostrar el canvas de render en lugar de la cámara mientras se procesa.
  const canvas = $('renderCanvas');
  canvas.classList.remove('hidden');
  $('cam').classList.add('hidden');
  $('btnShutter').disabled = true;
  show('screen-record');
  const music = await pickMusic();
  const ctrl = new AbortController(); state.abort = ctrl;
  busy('Editando el video… 0%', 0, true);
  try {
    const res = await renderVideo({
      clip, settings: s, overlayImage: await getOverlayAssets(), endCard: await getEndCard(), music, canvas, signal: ctrl.signal,
      onProgress: (p) => busy(`Editando el video… ${Math.round(p * 100)}%`, p, true),
    });
    state.lastResult = res;
    busy(false);
    if (from === 'record' && s.output.saveToGallery) {
      try {
        await db.put('videos', { id: db.uid(), created: Date.now(), kind: 'edited', name: videoName('360'), blob: res.blob, size: res.blob.size, duration: res.duration });
      } catch (e) {
        console.warn(e);
        toast('No entra en la galería (poco espacio): el video igual se puede compartir. Borrá videos viejos en Galería.', 6000);
      }
    }
    if (from === 'record' && s.output.saveOriginal) {
      busy('Comprimiendo el original…', 0);
      try {
        const orig = await compressClip(clip.blob, { mbps: s.output.originalMbps, res: s.output.res, onProgress: (p) => busy('Comprimiendo el original…', p) });
        await db.put('videos', { id: db.uid(), created: Date.now(), kind: 'original', name: videoName('original'), blob: orig, size: orig.size, duration: clip.seconds });
      } catch (e) { console.warn(e); toast('No se pudo comprimir el original'); }
      busy(false);
    }
    showResult(res, music);
    if (from === 'record' && s.output.autoShare) shareBlob(res.blob, videoName('360') + '.mp4', { auto: true });
  } catch (e) {
    busy(false);
    if (e && e.name === 'AbortError') toast('Edición cancelada');
    else { console.error(e); toast('Error al editar: ' + (e.message || e), 6000); }
    if (from === 'record') { canvas.classList.add('hidden'); $('cam').classList.remove('hidden'); $('btnShutter').disabled = false; }
    else show('screen-settings');
  } finally { state.abort = null; }
}

function videoName(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ev = (state.settings.eventName || 'evento').replace(/[^\w\-áéíóúñ ]/gi, '').trim().replace(/\s+/g, '_').slice(0, 30);
  return `${prefix}_${ev}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function showResult(res, music) {
  if (!state.originalReady || state.originalReady.clip !== state.lastClip) { state.originalReady = null; $('btnSaveOriginal').textContent = 'Guardar original (comprimido)'; }
  state.viewing = { blob: res.blob, name: res.name || videoName('360'), id: null };
  $('btnResultDelete').classList.toggle('hidden', state.resultFrom !== 'gallery');
  const v = $('resultVideo');
  if (v.src) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(res.blob);
  v.play().catch(() => {});
  $('resultInfo').textContent = `${fmtSec(res.duration)} · ${res.width}×${res.height} · ${fmtBytes(res.blob.size)}${music ? ` · 🎵 ${music.name}` : ' · sin música'}${res.beats ? ` · al ritmo (${Math.round(res.beats.bpm)} BPM)` : ''}`;
  $('btnSaveOriginal').classList.toggle('hidden', !state.lastClip || state.resultFrom !== 'record');
  $('btnAgain').textContent = state.resultFrom === 'record' ? 'Grabar otro' : 'Volver a configuración';
  show('screen-result');
}

// auto: se llama sola (sin toque). Si el iPhone no deja compartir sin un toque, se resalta el botón en vez de descargar.
async function shareBlob(blob, name, { auto = false, button = 'btnShare' } = {}) {
  const file = new File([blob], name, { type: 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; } catch (e) {
      if (e.name === 'AbortError') return false;
      if (e.name === 'NotAllowedError') {
        const b = $(button);
        if (b) { b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
        toast('Listo: tocá el botón para compartir o guardar el video', 4000);
        return false;
      }
      console.warn(e);
    }
  }
  if (auto) return false;
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  toast('Se descargó el archivo (en iPhone: Archivos → Descargas → compartir → Guardar video).', 5000);
  return true;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function beep(freq, dur) {
  try {
    const ac = audioContext(); if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = freq; g.gain.value = 0.15; o.connect(g).connect(ac.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur); o.stop(ac.currentTime + dur);
  } catch (e) { /* sin sonido */ }
}

// ---------- música ----------
async function loadTracks() {
  state.tracks = (await db.byKind('music')).sort((a, b) => (a.created || 0) - (b.created || 0));
}
async function pickMusic() {
  const on = state.tracks.filter(t => t.enabled !== false);
  if (!on.length) return null;
  let t;
  if (state.settings.music.mode === 'random') t = on[Math.floor(Math.random() * on.length)];
  else { t = on[state.musicSeq % on.length]; state.musicSeq++; localStorage.setItem('booth360.musicSeq', String(state.musicSeq)); }
  return { blob: t.blob, start: t.start || 0, name: t.name };
}

async function addMusicFiles(files) {
  for (const f of files) {
    busy(`Analizando ${f.name}…`);
    let duration = 0;
    try { const d = await decodeAudio(f); duration = d.duration; } catch (e) { busy(false); toast(`No se pudo leer ${f.name}`); continue; }
    await db.put('assets', { id: db.uid(), kind: 'music', name: f.name.replace(/\.[^.]+$/, ''), blob: f, start: 0, enabled: true, duration, created: Date.now() });
  }
  busy(false);
  await loadTracks();
  renderMusicList();
  save();
}

function windowLength() { return Math.max(1, finalDuration(state.settings.timeline, state.settings.capture.seconds)); }

function renderMusicList() {
  const list = $('musicList');
  list.innerHTML = '';
  if (!state.tracks.length) { list.innerHTML = '<p class="muted small">Todavía no hay canciones: tocá “Agregar canción” y elegí un MP3 o M4A guardado en Archivos.</p>'; return; }
  for (const t of state.tracks) {
    const el = document.createElement('div'); el.className = 'track';
    el.innerHTML = `
      <div class="hdr"><input type="checkbox" class="en" ${t.enabled !== false ? 'checked' : ''}><div class="name">${escapeHtml(t.name)}</div>
        <button class="btn small play">▶</button><button class="btn small danger del">🗑</button></div>
      <canvas class="wave" width="600" height="56"></canvas>
      <div class="foot"><span class="pos"></span><input type="range" class="start" min="0" max="${Math.max(0, (t.duration || 0) - windowLength()).toFixed(1)}" step="0.1" value="${t.start || 0}"></div>`;
    list.appendChild(el);
    const wave = el.querySelector('.wave'), startIn = el.querySelector('.start'), pos = el.querySelector('.pos');
    const draw = async () => {
      const peaks = await getPeaks(t);
      const ctx = wave.getContext('2d'); const W = wave.width, H = wave.height;
      ctx.clearRect(0, 0, W, H);
      const winLen = windowLength(); const dur = t.duration || 1;
      const x0 = (t.start || 0) / dur * W, x1 = Math.min(W, ((t.start || 0) + winLen) / dur * W);
      ctx.fillStyle = '#ff3d7f33'; ctx.fillRect(x0, 0, x1 - x0, H);
      for (let i = 0; i < peaks.length; i++) {
        const x = i / peaks.length * W; const h = Math.max(1, peaks[i] * (H - 4));
        ctx.fillStyle = x >= x0 && x <= x1 ? '#ff3d7f' : '#5c5c70';
        ctx.fillRect(x, (H - h) / 2, Math.max(1, W / peaks.length - 0.5), h);
      }
      pos.textContent = `Desde ${fmtSec(t.start || 0)} · tramo de ${fmtSec(winLen)} · canción ${fmtSec(dur)}`;
    };
    draw();
    let saveT = null;
    const setStart = (v) => { t.start = Math.max(0, Math.min(v, Math.max(0, (t.duration || 0) - 1))); startIn.value = t.start; draw(); clearTimeout(saveT); saveT = setTimeout(() => db.put('assets', t).catch(() => {}), 600); };
    startIn.addEventListener('input', () => setStart(+startIn.value));
    // Tocar/arrastrar sobre la onda para ubicar el inicio.
    const fromPointer = (ev) => { const r = wave.getBoundingClientRect(); const x = (ev.clientX - r.left) / r.width; setStart(Math.max(0, x * (t.duration || 0) - windowLength() / 2)); };
    let dragging = false;
    wave.addEventListener('pointerdown', (ev) => { dragging = true; wave.setPointerCapture(ev.pointerId); fromPointer(ev); });
    wave.addEventListener('pointermove', (ev) => { if (dragging) fromPointer(ev); });
    wave.addEventListener('pointerup', () => { dragging = false; });
    el.querySelector('.en').addEventListener('change', async (ev) => { t.enabled = ev.target.checked; await db.put('assets', t); save(); });
    el.querySelector('.del').addEventListener('click', async () => { if (!confirm(`¿Borrar “${t.name}”?`)) return; await db.del('assets', t.id); await loadTracks(); renderMusicList(); save(); });
    el.querySelector('.play').addEventListener('click', (ev) => previewTrack(t, ev.target));
  }
}
// Solo se guarda la forma de onda (antes quedaba cada canción entera decodificada en memoria: ~80 MB por canción,
// y el iPhone cerraba la app). Se guarda la promesa: dos dibujos a la vez no decodifican dos veces.
async function getPeaks(t) {
  if (!state.decodedCache.has(t.id)) {
    const job = decodeAudio(t.blob).then((d) => waveformPeaks(d, 240));
    state.decodedCache.set(t.id, job);
    job.catch(() => state.decodedCache.delete(t.id));
  }
  return state.decodedCache.get(t.id);
}
async function previewTrack(t, btn) {
  const ac = audioContext(); if (ac.state === 'suspended') await ac.resume();
  if (state.previewPlayer) { try { state.previewPlayer.src.stop(); } catch (e) { /* */ } state.previewPlayer.btn.textContent = '▶'; const same = state.previewPlayer.id === t.id; state.previewPlayer = null; if (same) return; }
  const decoded = await decodeAudio(t.blob); // (se decodifica para escuchar y se libera al terminar)
  const src = ac.createBufferSource(); src.buffer = decoded; src.connect(ac.destination);
  src.start(0, t.start || 0, windowLength());
  btn.textContent = '■';
  state.previewPlayer = { src, btn, id: t.id };
  src.onended = () => { if (state.previewPlayer && state.previewPlayer.src === src) { btn.textContent = '▶'; state.previewPlayer = null; } };
}

// ---------- placa final ----------
async function getEndCard() {
  const e = state.settings.endCard;
  if (!e || !e.enabled || !e.imageId) return null;
  if (!state.endCardImage || state.endCardImage.id !== e.imageId) {
    const a = await db.get('assets', e.imageId);
    if (!a) return null;
    const bmp = await createImageBitmap(a.blob);
    if (state.endCardImage) { try { state.endCardImage.bmp.close(); } catch (err) { /* */ } }
    state.endCardImage = { id: e.imageId, bmp };
  }
  return { image: state.endCardImage.bmp, seconds: +e.seconds || 2 };
}

// ---------- perfiles del evento ----------
// Toda la configuración (texto, imagen, placa final, música, velocidades, efectos, salida) guardada con un nombre,
// para preparar los eventos antes y cambiar de uno a otro con un toque. Las canciones son las mismas para todos.
const PKEY = 'booth360.profiles.v1';
function loadProfiles() { try { return JSON.parse(localStorage.getItem(PKEY) || '{}') || {}; } catch (e) { return {}; } }
function assetInProfiles(id) {
  if (!id) return false;
  return Object.values(loadProfiles()).some((p) => (p.overlay && (p.overlay.imageId === id || (p.overlay.stickers || []).some((st) => st.assetId === id))) || (p.endCard && p.endCard.imageId === id));
}
function renderProfiles() {
  const p = loadProfiles();
  const sel = $('profileSel');
  const names = Object.keys(p).sort((a, b) => a.localeCompare(b, 'es'));
  sel.innerHTML = `<option value="">${names.length ? '— Elegí un perfil guardado —' : '(todavía no hay perfiles)'}</option>` + names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  sel.value = state.settings.profileName && p[state.settings.profileName] ? state.settings.profileName : '';
  $('btnProfileDel').disabled = !sel.value;
}
function bindProfiles() {
  renderProfiles();
  $('profileSel').onchange = () => {
    const name = $('profileSel').value;
    $('btnProfileDel').disabled = !name;
    const snap = name && loadProfiles()[name];
    if (!snap) return;
    saveSettings({ ...structuredClone(snap), profileName: name });
    location.reload(); // (vuelve a armar toda la configuración con el perfil)
  };
  $('btnProfileSave').onclick = () => {
    const sug = state.settings.profileName || state.settings.eventName || '';
    const name = (prompt('Nombre del perfil (por ejemplo "15 de Dana" o "Casamientos")', sug) || '').trim();
    if (!name) return;
    const p = loadProfiles();
    if (p[name] && name !== state.settings.profileName && !confirm(`Ya existe "${name}". ¿Reemplazarlo?`)) return;
    const snap = structuredClone(state.settings);
    delete snap.profileName;
    p[name] = snap;
    localStorage.setItem(PKEY, JSON.stringify(p));
    state.settings.profileName = name;
    save();
    renderProfiles();
    toast(`Perfil “${name}” guardado`);
  };
  $('btnProfileDel').onclick = () => {
    const name = $('profileSel').value;
    if (!name || !confirm(`¿Borrar el perfil “${name}”? (los videos no se borran)`)) return;
    const p = loadProfiles();
    delete p[name];
    localStorage.setItem(PKEY, JSON.stringify(p));
    if (state.settings.profileName === name) { delete state.settings.profileName; save(); }
    renderProfiles();
  };
}

// ---------- superposición (marco + adornos + texto) ----------
const STICKERS = ['👑', '💍', '❤️', '⭐', '✨', '🎉', '🥂', '🎂', '🎓', '🌸', '🦋', '🎈'];
const TEXT_COLORS = ['#ffffff', '#f5c542', '#d9a3ff', '#ff3d7f', '#7fe3ff', '#b7f5c5', '#000000'];
// Imágenes ya abiertas (marco y adornos), por id. Se cierran las que ya no se usan.
async function getOverlayAssets() {
  const o = state.settings.overlay;
  const parts = overlayParts(o);
  const want = new Set();
  if (parts.image && o.imageId) want.add(o.imageId);
  for (const st of parts.stickers) if (st.assetId) want.add(st.assetId);
  state.bmps ||= new Map();
  for (const [id, bmp] of state.bmps) if (!want.has(id)) { try { bmp.close(); } catch (e) { /* */ } state.bmps.delete(id); }
  for (const id of want) {
    if (state.bmps.has(id)) continue;
    try { const a = await db.get('assets', id); if (a) state.bmps.set(id, await createImageBitmap(a.blob)); } catch (e) { console.warn(e); }
  }
  return { image: (parts.image && state.bmps.get(o.imageId)) || null, stickers: state.bmps };
}
// Para que el modo viejo ("text" / "image" / "none") siga diciendo lo mismo que los interruptores nuevos.
function syncOverlayMode() {
  const o = state.settings.overlay;
  o.mode = o.textOn ? 'text' : o.imageOn ? 'image' : (o.stickers || []).length ? 'stickers' : 'none';
}
// Un cuadro del último video (o del video de prueba) para ver el texto y los adornos sobre una imagen real.
let pvFrame = null; // { key, job }
function previewFrame() {
  const pick = async () => state.lastClip || (await db.get('assets', 'testclip').catch(() => null));
  return pick().then((clip) => {
    if (!clip || !clip.blob) return null;
    const key = `${clip.blob.size}:${clip.seconds}:${clip.fps}`;
    if (pvFrame && pvFrame.key === key) return pvFrame.job;
    const job = (async () => {
      const src = await FrameSource.open(clip.blob, clip.fps);
      const r = src.reader(1);
      try { const f = await r.get(Math.floor(src.count / 2)); return f ? await createImageBitmap(f) : null; } finally { r.close(); src.close(); }
    })().catch((e) => { console.warn('vista previa', e); return null; });
    pvFrame = { key, job };
    return job;
  });
}
// Dibuja "así va a quedar": imagen de fondo con el filtro, el efecto y todo lo superpuesto. Devuelve dónde quedó cada cosa.
async function drawScene(c) {
  const s = state.settings;
  const W = c.width, H = c.height;
  const [bmp, assets] = await Promise.all([previewFrame(), getOverlayAssets()]);
  await ensureFontLoaded(s.overlay, H);
  const ctx = c.getContext('2d');
  if (bmp) {
    const k = Math.max(W / bmp.width, H / bmp.height);
    ctx.drawImage(bmp, (W - bmp.width * k) / 2, (H - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    try { applyLook(ctx, W, H, s.look, c); } catch (e) { /* */ }
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#3b1d4f'); g.addColorStop(1, '#141428');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    ctx.beginPath(); ctx.arc(W / 2, H * 0.36, W * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(W / 2, H * 0.66, W * 0.2, H * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  }
  try {
    const fx = new Effect(s.effects.type, { intensity: s.effects.intensity, color: s.effects.color, seed: 3 });
    for (let i = 0; i < 20; i++) fx.render(ctx, W, H, 1 / 30);
  } catch (e) { /* */ }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowColor = 'transparent'; // (los efectos dejan el pincel en modo "luz")
  return drawOverlay(ctx, W, H, s.overlay, assets);
}
let ovSel = null; // lo elegido en la vista previa: 'text', el id de un adorno o null
let ovBoxes = [];
let ovDrawing = null, ovAgain = false;
// (si llegan muchos pedidos juntos, por ejemplo al arrastrar, se dibuja el último y no se pisan entre sí)
function drawOverlayPreview() {
  if (ovDrawing) { ovAgain = true; return ovDrawing; }
  ovDrawing = (async () => {
    do {
      ovAgain = false;
      const c = $('ovPreview');
      ovBoxes = await drawScene(c);
      const b = ovBoxes.find((x) => x.id === ovSel);
      if (b) {
        const ctx = c.getContext('2d');
        ctx.save(); ctx.setLineDash([8, 6]); ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff3d7f';
        ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12); ctx.restore();
      }
    } while (ovAgain);
    ovDrawing = null;
  })();
  return ovDrawing;
}
function drawHomePreview() { drawScene($('homePreview')).catch(() => {}); }
function drawCamOverlay() {
  const c = $('camOverlay'); const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const o = state.settings.overlay;
  Promise.all([getOverlayAssets(), ensureFontLoaded(o, c.height)]).then(([assets]) => { ctx.clearRect(0, 0, c.width, c.height); drawOverlay(ctx, c.width, c.height, o, assets); }).catch(() => {});
}
function stickerById(id) { return (state.settings.overlay.stickers || []).find((st) => st.id === id) || null; }
function selectOverlayItem(id) {
  ovSel = id;
  const st = id && id !== 'text' ? stickerById(id) : null;
  $('ovSel').classList.toggle('hidden', !st);
  if (st) {
    $('ovSelName').textContent = st.emoji ? `Adorno elegido: ${st.emoji}` : 'Adorno elegido: tu imagen';
    $('ovSelSize').value = Math.round((st.size || 0.25) * 100);
  }
}
async function removeSticker(id) {
  const o = state.settings.overlay;
  const st = stickerById(id);
  if (!st) return;
  o.stickers = o.stickers.filter((x) => x.id !== id);
  if (st.assetId && !assetInProfiles(st.assetId) && !o.stickers.some((x) => x.assetId === st.assetId)) { try { await db.del('assets', st.assetId); } catch (e) { /* */ } }
  syncOverlayMode(); selectOverlayItem(null); save(); drawOverlayPreview();
}
function addSticker(st) {
  const o = state.settings.overlay;
  o.stickers = [...(o.stickers || []), { id: db.uid(), x: 0.5, y: 0.3, size: 0.25, ...st }];
  syncOverlayMode(); save();
  selectOverlayItem(o.stickers[o.stickers.length - 1].id);
  drawOverlayPreview();
}
function bindOverlayDrag() {
  const c = $('ovPreview');
  const pts = new Map();
  let drag = null, pinch = null;
  const pos = (ev) => { const r = c.getBoundingClientRect(); return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height }; };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, (a.y - b.y) * 16 / 9) || 0.001; };
  const item = (id) => (id === 'text' ? state.settings.overlay : stickerById(id));
  c.addEventListener('pointerdown', (ev) => {
    try { c.setPointerCapture(ev.pointerId); } catch (e) { /* */ }
    const p = pos(ev); pts.set(ev.pointerId, p);
    if (pts.size === 2 && ovSel && item(ovSel)) { drag = null; pinch = { d0: dist(), s0: ovSel === 'text' ? state.settings.overlay.size : item(ovSel).size || 0.25 }; return; }
    const W = c.width, H = c.height, pad = 14;
    const hit = [...ovBoxes].reverse().find((b) => p.x * W >= b.x - pad && p.x * W <= b.x + b.w + pad && p.y * H >= b.y - pad && p.y * H <= b.y + b.h + pad);
    selectOverlayItem(hit ? hit.id : null);
    const it = hit && item(hit.id);
    drag = it ? { id: hit.id, dx: (it.x ?? 0.5) - p.x, dy: (it.y ?? 0.5) - p.y } : null;
    drawOverlayPreview();
  });
  c.addEventListener('pointermove', (ev) => {
    if (!pts.has(ev.pointerId)) return;
    const p = pos(ev); pts.set(ev.pointerId, p);
    if (pinch && pts.size === 2) {
      const k = dist() / pinch.d0;
      if (ovSel === 'text') { state.settings.overlay.size = Math.round(Math.max(40, Math.min(260, pinch.s0 * k))); $('ovSize').value = state.settings.overlay.size; }
      else { const st = item(ovSel); if (st) { st.size = Math.max(0.05, Math.min(1, pinch.s0 * k)); $('ovSelSize').value = Math.round(st.size * 100); } }
      drawOverlayPreview();
    } else if (drag) {
      const it = item(drag.id); if (!it) return;
      it.x = Math.max(0, Math.min(1, p.x + drag.dx)); it.y = Math.max(0, Math.min(1, p.y + drag.dy));
      drawOverlayPreview();
    }
  });
  const end = (ev) => { pts.delete(ev.pointerId); pinch = null; if (!pts.size) { if (drag) save(); drag = null; } };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
}

// ---------- línea de tiempo ----------
function renderPresets() {
  const box = $('presetChips'); box.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button'); b.className = 'chip' + (state.settings.timeline.preset === p.id ? ' on' : ''); b.textContent = p.name;
    b.onclick = () => { state.settings.timeline.preset = p.id; state.settings.timeline.segments = p.segments.map(s => ({ ...s })); state.settings.timeline.reverse = p.reverse; save(); renderPresets(); renderSegments(); };
    box.appendChild(b);
  }
  const custom = document.createElement('button'); custom.className = 'chip' + (state.settings.timeline.preset === 'custom' ? ' on' : ''); custom.textContent = 'Personalizado'; custom.disabled = true; box.appendChild(custom);
  $('tlReverse').checked = !!state.settings.timeline.reverse;
  $('tlSmooth').checked = !!state.settings.timeline.smooth;
}
function markCustom() { state.settings.timeline.preset = 'custom'; renderPresets(); }
function renderSegments() {
  const box = $('segments'); box.innerHTML = '';
  const segs = state.settings.timeline.segments;
  segs.forEach((seg, i) => {
    const el = document.createElement('div'); el.className = 'segment';
    el.innerHTML = `<div class="hdr"><b>Tramo ${i + 1}</b><div><button class="btn small up">↑</button> <button class="btn small danger del">🗑</button></div></div>
      <div class="chips speeds"></div>
      <div class="chips dirs"><button class="chip fwd">Adelante ▶</button><button class="chip rev">◀ Atrás (reverso)</button></div>
      <div class="holdrow"><span class="small muted">Congelar la imagen al final:</span><div class="chips holds"></div></div>
      <div class="range">Parte del clip: <span class="lbl"></span></div>
      <div class="range"><span>De</span><input type="range" class="from" min="0" max="100" step="5" value="${seg.from}"><span>a</span><input type="range" class="to" min="0" max="100" step="5" value="${seg.to}"></div>`;
    box.appendChild(el);
    const sp = el.querySelector('.speeds');
    for (const v of SPEEDS) { const b = document.createElement('button'); b.className = 'chip' + (+seg.speed === v ? ' on' : ''); b.textContent = `${v}x`; b.onclick = () => { seg.speed = v; markCustom(); save(); renderSegments(); }; sp.appendChild(b); }
    const hb = el.querySelector('.holds');
    for (const [v, name] of [[0, 'No'], [0.5, '½ s'], [1, '1 s'], [2, '2 s']]) { const b = document.createElement('button'); b.className = 'chip' + ((+seg.hold || 0) === v ? ' on' : ''); b.textContent = name; b.onclick = () => { seg.hold = v; markCustom(); save(); renderSegments(); }; hb.appendChild(b); }
    el.querySelector('.fwd').classList.toggle('on', seg.dir !== 'rev'); el.querySelector('.rev').classList.toggle('on', seg.dir === 'rev');
    el.querySelector('.fwd').onclick = () => { seg.dir = 'fwd'; markCustom(); save(); renderSegments(); };
    el.querySelector('.rev').onclick = () => { seg.dir = 'rev'; markCustom(); save(); renderSegments(); };
    const lbl = el.querySelector('.lbl'); const upd = () => { lbl.textContent = `${seg.from}% → ${seg.to}%`; };
    upd();
    el.querySelector('.from').oninput = (e) => { seg.from = +e.target.value; if (seg.from >= seg.to) seg.from = Math.max(0, seg.to - 5); e.target.value = seg.from; upd(); markCustom(); save(); updateTlInfo(); };
    el.querySelector('.to').oninput = (e) => { seg.to = +e.target.value; if (seg.to <= seg.from) seg.to = Math.min(100, seg.from + 5); e.target.value = seg.to; upd(); markCustom(); save(); updateTlInfo(); };
    el.querySelector('.del').onclick = () => { if (segs.length <= 1) return toast('Tiene que quedar al menos un tramo'); segs.splice(i, 1); markCustom(); save(); renderSegments(); };
    el.querySelector('.up').onclick = () => { if (i === 0) return; [segs[i - 1], segs[i]] = [segs[i], segs[i - 1]]; markCustom(); save(); renderSegments(); };
  });
  updateTlInfo();
}
function updateTlInfo() {
  const s = state.settings; const d = finalDuration(s.timeline, s.capture.seconds);
  $('tlInfo').textContent = `Grabación de ${s.capture.seconds}s → video final de ~${fmtSec(d)}${s.timeline.reverse ? ' (incluye el reverso)' : ''}.`;
  renderMusicList();
}

// ---------- configuración (resto) ----------
function bindSettings() {
  const s = state.settings;
  $('tlReverse').onchange = (e) => { s.timeline.reverse = e.target.checked; markCustom(); save(); updateTlInfo(); };
  $('tlSmooth').onchange = (e) => { s.timeline.smooth = e.target.checked; save(); };
  $('btnAddSegment').onclick = () => { s.timeline.segments.push({ speed: 1, dir: 'fwd', from: 0, to: 100 }); markCustom(); save(); renderSegments(); };

  // efectos
  const fxBox = $('effectChips');
  const renderFx = () => { fxBox.innerHTML = ''; for (const e of EFFECTS) { const b = document.createElement('button'); b.className = 'chip' + (s.effects.type === e.id ? ' on' : ''); b.textContent = e.name; b.onclick = () => { s.effects.type = e.id; save(); renderFx(); drawOverlayPreview(); }; fxBox.appendChild(b); } };
  renderFx();
  const lookBox = $('lookChips');
  const renderLooks = () => { lookBox.innerHTML = ''; for (const l of LOOKS) { const b = document.createElement('button'); b.className = 'chip' + ((s.look || 'none') === l.id ? ' on' : ''); b.textContent = l.name; b.onclick = () => { s.look = l.id; save(); renderLooks(); drawOverlayPreview(); }; lookBox.appendChild(b); } };
  renderLooks();
  $('fxIntensity').value = s.effects.intensity; $('fxIntensity').oninput = (e) => { s.effects.intensity = +e.target.value; save(); drawOverlayPreview(); };
  $('fxColor').value = s.effects.color; $('fxColor').oninput = (e) => { s.effects.color = e.target.value; save(); drawOverlayPreview(); };

  // superposición: texto, adornos y marco (todo junto)
  const o = s.overlay;
  const parts0 = overlayParts(o);
  o.textOn = parts0.text; o.imageOn = parts0.image; o.stickers = parts0.stickers;
  const showParts = () => { $('overlayText').classList.toggle('hidden', !o.textOn); $('ovTextOn').checked = !!o.textOn; $('ovImageOn').checked = !!o.imageOn; };
  const changed = () => { syncOverlayMode(); save(); showParts(); drawOverlayPreview(); };
  showParts();
  $('ovTextOn').onchange = (e) => { o.textOn = e.target.checked; changed(); };
  $('ovImageOn').onchange = (e) => { o.imageOn = e.target.checked; if (o.imageOn && !o.imageId) toast('Elegí el PNG del marco'); changed(); };
  $('ovText').value = o.text; $('ovText').oninput = (e) => { o.text = e.target.value; if (!o.textOn && o.text.trim()) o.textOn = true; changed(); };
  const fsel = $('ovFont'); fsel.innerHTML = FONTS.map(f => `<option value="${f.id}">${f.label}</option>`).join(''); fsel.value = o.font;
  const fontBox = $('ovFontChips');
  const renderFonts = () => { fontBox.innerHTML = ''; for (const f of FONTS) { const b = document.createElement('button'); b.className = 'chip' + (o.font === f.id ? ' on' : ''); b.textContent = f.id === 'system-ui' ? 'Simple' : f.id; b.style.fontFamily = `"${f.id}", system-ui`; b.onclick = () => { o.font = f.id; fsel.value = f.id; renderFonts(); changed(); }; fontBox.appendChild(b); } };
  renderFonts();
  fsel.onchange = (e) => { o.font = e.target.value; renderFonts(); changed(); };
  $('ovSize').value = o.size; $('ovSize').oninput = (e) => { o.size = +e.target.value; changed(); };
  const colorBox = $('ovColorChips');
  const renderColors = () => { colorBox.innerHTML = ''; for (const col of TEXT_COLORS) { const b = document.createElement('button'); b.className = 'chip' + ((o.color || '').toLowerCase() === col ? ' on' : ''); b.style.background = col; b.title = col; b.onclick = () => { o.color = col; $('ovColor').value = col; renderColors(); changed(); }; colorBox.appendChild(b); } };
  renderColors();
  $('ovColor').value = o.color; $('ovColor').oninput = (e) => { o.color = e.target.value; renderColors(); changed(); };
  $('ovShadow').checked = o.shadow; $('ovShadow').onchange = (e) => { o.shadow = e.target.checked; changed(); };
  $('ovStroke').checked = o.stroke; $('ovStroke').onchange = (e) => { o.stroke = e.target.checked; changed(); };
  // adornos
  const stBox = $('stickerChips');
  for (const em of STICKERS) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = em; b.onclick = () => addSticker({ emoji: em }); stBox.appendChild(b); }
  $('stickerFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const id = db.uid(); await db.put('assets', { id, kind: 'image', name: f.name, blob: f, created: Date.now() });
      addSticker({ assetId: id, size: 0.4 });
    } catch (err) { console.error(err); toast('No se pudo agregar esa imagen'); }
  };
  $('ovSelSize').oninput = (e) => { const st = stickerById(ovSel); if (st) { st.size = +e.target.value / 100; save(); drawOverlayPreview(); } };
  $('ovSelDel').onclick = () => removeSticker(ovSel);
  // marco de pantalla completa
  $('ovImageFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (o.imageId && !assetInProfiles(o.imageId)) { try { await db.del('assets', o.imageId); } catch (err) { /* */ } }
    const id = db.uid(); await db.put('assets', { id, kind: 'image', name: f.name, blob: f, created: Date.now() });
    o.imageId = id; o.imageOn = true; e.target.value = ''; updateImageInfo(); changed();
  };
  const updateImageInfo = async () => { const a = o.imageId ? await db.get('assets', o.imageId) : null; $('ovImageInfo').textContent = a ? `Marco: ${a.name} (${fmtBytes(a.blob.size)})` : 'Todavía no elegiste un marco.'; };
  updateImageInfo();
  bindOverlayDrag();

  // música
  $('musicFile').onchange = (e) => { addMusicFiles([...e.target.files]); e.target.value = ''; };
  const mm = $('musicModeChips');
  const renderMm = () => { mm.innerHTML = ''; for (const [id, name] of [['random', 'Al azar'], ['sequence', 'En orden']]) { const b = document.createElement('button'); b.className = 'chip' + (s.music.mode === id ? ' on' : ''); b.textContent = name; b.onclick = () => { s.music.mode = id; save(); renderMm(); }; mm.appendChild(b); } };
  renderMm();
  $('musicBeat').checked = s.music.beatSync !== false; $('musicBeat').onchange = (e) => { s.music.beatSync = e.target.checked; save(); };
  $('musicFadeIn').checked = s.music.fadeIn; $('musicFadeIn').onchange = (e) => { s.music.fadeIn = e.target.checked; save(); };
  $('musicFadeOut').checked = s.music.fadeOut; $('musicFadeOut').onchange = (e) => { s.music.fadeOut = e.target.checked; save(); };

  // grabación y salida
  const bindRange = (id, obj, key, after) => { const el = $(id); el.value = obj[key]; const lbl = document.createElement('span'); lbl.className = 'small muted'; lbl.textContent = ` ${obj[key]}`; el.parentElement.querySelector('span').appendChild(lbl); el.oninput = (e) => { obj[key] = +e.target.value; lbl.textContent = ` ${obj[key]}`; save(); after && after(); }; };
  bindRange('capSeconds', s.capture, 'seconds', updateTlInfo);
  bindRange('capCountdown', s.capture, 'countdown');
  bindRange('outMbps', s.output, 'mbps');
  bindRange('outOrigMbps', s.output, 'originalMbps');
  // placa final
  const updateEc = async () => { const a = s.endCard.imageId ? await db.get('assets', s.endCard.imageId) : null; $('ecInfo').textContent = a ? `Placa final: ${a.name}` : 'Todavía no elegiste la imagen de la placa final.'; $('ecOn').checked = !!s.endCard.enabled; };
  $('ecOn').checked = !!s.endCard.enabled; $('ecOn').onchange = (e) => { s.endCard.enabled = e.target.checked; save(); };
  bindRange('ecSeconds', s.endCard, 'seconds');
  $('ecFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (s.endCard.imageId && !assetInProfiles(s.endCard.imageId)) { try { await db.del('assets', s.endCard.imageId); } catch (err) { /* */ } }
    const id = db.uid(); await db.put('assets', { id, kind: 'image', name: f.name, blob: f, created: Date.now() });
    s.endCard.imageId = id; s.endCard.enabled = true; state.endCardImage = null; save(); updateEc(); e.target.value = '';
  };
  updateEc();
  $('capReady').value = s.capture.readyText; $('capReady').oninput = (e) => { s.capture.readyText = e.target.value; save(); };
  $('capMotion').checked = !!s.capture.motionStart; $('capMotion').onchange = (e) => enableMotion(e.target.checked);
  $('capMotionSens').value = s.capture.motionSensitivity || 'media'; $('capMotionSens').onchange = (e) => { s.capture.motionSensitivity = e.target.value; save(); };
  $('capFps').value = String(s.capture.fps); $('capFps').onchange = (e) => { s.capture.fps = +e.target.value; save(); };
  $('capRes').value = s.capture.res; $('capRes').onchange = (e) => { s.capture.res = e.target.value; save(); };
  $('outRes').value = s.output.res; $('outRes').onchange = (e) => { s.output.res = e.target.value; save(); };
  $('outSaveGallery').checked = s.output.saveToGallery; $('outSaveGallery').onchange = (e) => { s.output.saveToGallery = e.target.checked; save(); };
  $('outSaveOriginal').checked = s.output.saveOriginal; $('outSaveOriginal').onchange = (e) => { s.output.saveOriginal = e.target.checked; save(); };
  $('outAutoShare').checked = s.output.autoShare; $('outAutoShare').onchange = (e) => { s.output.autoShare = e.target.checked; save(); };

  // video de prueba
  $('testVideoFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    busy('Preparando el video de prueba…', 0);
    try {
      const info = await normalizeClip(f, { fps: s.capture.fps, res: s.capture.res, maxSeconds: 20, onProgress: (p) => busy('Preparando el video de prueba…', p) });
      await db.put('assets', { id: 'testclip', kind: 'testclip', name: f.name, created: Date.now(), ...info });
      updateTestInfo();
      toast('Video de prueba listo');
    } catch (err) { console.error(err); toast('No se pudo usar ese video: ' + (err.message || err), 5000); }
    busy(false); e.target.value = '';
  };
  const updateTestInfo = async () => { const a = await db.get('assets', 'testclip'); $('testVideoInfo').textContent = a ? `Video de prueba: ${a.name} (${fmtSec(a.seconds)})` : state.lastClip ? 'Se usará la última grabación.' : 'No hay video de prueba ni grabación todavía.'; };
  updateTestInfo();
  $('btnPreview').onclick = preview;
  $('btnPreviewHome').onclick = preview;
}

async function preview() {
  let clip = state.lastClip;
  if (!clip) { const a = await db.get('assets', 'testclip'); if (a) clip = a; }
  if (!clip) return toast('Primero grabá un video o elegí un video de prueba en Configuración → 2.', 4000);
  await processClip(clip, 'preview');
}

// ---------- galería ----------
let galleryUrls = [];
function releaseGallery() { for (const u of galleryUrls) URL.revokeObjectURL(u); galleryUrls = []; }
async function renderGallery() {
  releaseGallery();
  const list = $('galleryList'); list.innerHTML = '';
  const vids = (await db.all('videos')).sort((a, b) => b.created - a.created);
  const u = await db.usage();
  $('storageInfo').textContent = `${vids.length} video(s) · ${fmtBytes(vids.reduce((a, v) => a + (v.size || 0), 0))}${u ? ` · espacio usado por la app ${fmtBytes(u.usage || 0)}` : ''}${vids.length ? ' · tocá un video para verlo, compartirlo o borrarlo' : ''}`;
  if (!vids.length) { list.innerHTML = '<p class="muted">Todavía no hay videos guardados. Los que grabes aparecen acá.</p>'; return; }
  for (const v of vids) {
    const el = document.createElement('button'); el.className = 'gitem';
    const d = new Date(v.created); const p2 = (n) => String(n).padStart(2, '0');
    el.innerHTML = `<video muted playsinline preload="metadata"></video>${v.kind === 'original' ? '<span class="tag">original</span>' : ''}<span class="meta">${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())} · ${fmtSec(v.duration || 0)}</span>`;
    el.title = v.name;
    list.appendChild(el);
    const url = URL.createObjectURL(v.blob); galleryUrls.push(url);
    el.querySelector('video').src = url + '#t=0.1'; // (el iPhone muestra la primera imagen solo si se le pide un momento del video)
    el.onclick = () => {
      state.resultFrom = 'gallery';
      showResult({ blob: v.blob, duration: v.duration || 0, width: '', height: '', name: v.name }, null);
      state.viewing.id = v.id;
      $('resultInfo').textContent = `${v.name} · ${d.toLocaleString()} · ${fmtBytes(v.size || 0)}`;
      $('btnAgain').textContent = 'Volver a la galería';
    };
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- arranque ----------
async function init() {
  if ('serviceWorker' in navigator && window.isSecureContext) { navigator.serviceWorker.register('./sw.js').catch(() => {}); }
  db.persist();
  await loadTracks();
  const s = state.settings;
  if (s.overlay.emoji && s.overlay.emoji.trim() && overlayParts(s.overlay).text) {
    const o = s.overlay;
    const lines = Math.max(1, (o.text || '').trim().split('\n').length);
    const up = ((o.size || 100) * (lines * 1.1 + 0.9)) / 2 / 1280;
    o.stickers = [...(o.stickers || []), { id: db.uid(), emoji: o.emoji.trim(), x: o.x ?? 0.5, y: Math.max(0.06, (o.y ?? 0.8) - up - 0.01), size: Math.max(0.1, ((o.size || 100) * 0.8) / 720) }];
    o.emoji = '';
    saveSettings(s);
  }
  $('eventName').value = s.eventName; $('eventName').oninput = (e) => { s.eventName = e.target.value; save(); };
  $('btnGoRecord').onclick = goRecord;
  const openSettings = (sec) => {
    show('screen-settings');
    if (sec) {
      document.querySelectorAll('#screen-settings details.card').forEach((d) => { d.open = d.id === sec; });
      const el = $(sec); if (el) setTimeout(() => el.scrollIntoView({ block: 'start' }), 30);
    }
    drawOverlayPreview();
  };
  $('btnSettings').onclick = () => openSettings(null);
  document.querySelectorAll('.tile[data-sec]').forEach((t) => { t.onclick = () => openSettings(t.dataset.sec); });
  $('btnHomePreview').onclick = () => openSettings('sec-overlay');
  $('btnSettingsBack').onclick = () => { selectOverlayItem(null); show('screen-home'); renderSummary(); };
  $('btnGallery').onclick = () => { renderGallery(); show('screen-gallery'); };
  $('btnGalleryBack').onclick = () => { releaseGallery(); $('galleryList').innerHTML = ''; show('screen-home'); renderSummary(); };
  const workBusy = () => recording || !!state.abort;
  $('btnRecBack').onclick = () => { if (workBusy()) return toast('Esperá a que termine'); stopCamera(); show('screen-home'); renderSummary(); };
  $('btnShutter').onclick = startCountdownAndRecord;
  $('btnMotion').onclick = () => enableMotion(!s.capture.motionStart);
  // Control remoto Bluetooth (tipo teclado o de presentaciones): empieza a grabar, y mientras graba corta antes.
  // En la pantalla del resultado vuelve a la cámara ("Grabar otro").
  const REMOTE_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'PageUp', 'PageDown', 'MediaPlayPause']);
  document.addEventListener('keydown', (e) => {
    if (!REMOTE_KEYS.has(e.key) || e.repeat) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && e.target.id !== 'btnShutter') return; // (escribiendo en un campo)
    if ($('screen-record').classList.contains('active')) {
      e.preventDefault();
      if (recording) { if (capturing) stopRequested = true; }
      else if (recordReady()) startCountdownAndRecord();
    } else if ($('screen-result').classList.contains('active') && state.resultFrom === 'record' && $('busy').classList.contains('hidden')) {
      e.preventDefault();
      $('btnAgain').click();
    }
  });
  $('btnFlip').onclick = async () => { if (workBusy()) return; s.capture.facing = s.capture.facing === 'environment' ? 'user' : 'environment'; save(); await goRecord(); };
  $('btnShare').onclick = () => state.viewing && shareBlob(state.viewing.blob, state.viewing.name + '.mp4');
  $('btnResultDelete').onclick = async () => {
    const v = state.viewing;
    if (!v || !v.id || !confirm(`¿Borrar “${v.name}”? No se puede deshacer.`)) return;
    $('resultVideo').pause();
    await db.del('videos', v.id);
    renderGallery(); show('screen-gallery');
  };
  $('btnSaveOriginal').onclick = async () => {
    if (!state.lastClip) return;
    const ready = state.originalReady;
    if (ready && ready.clip === state.lastClip) { await shareBlob(ready.blob, ready.name, { button: 'btnSaveOriginal' }); return; }
    busy('Comprimiendo el original…', 0);
    try {
      const orig = await compressClip(state.lastClip.blob, { mbps: s.output.originalMbps, res: s.output.res, onProgress: (p) => busy('Comprimiendo el original…', p) });
      busy(false);
      await db.put('videos', { id: db.uid(), created: Date.now(), kind: 'original', name: videoName('original'), blob: orig, size: orig.size, duration: state.lastClip.seconds });
      state.originalReady = { clip: state.lastClip, blob: orig, name: videoName('original') + '.mp4' };
      $('btnSaveOriginal').textContent = 'Compartir el original (listo)';
      await shareBlob(orig, state.originalReady.name, { button: 'btnSaveOriginal' });
    } catch (e) { busy(false); console.error(e); toast('No se pudo comprimir: ' + (e.message || e)); }
  };
  $('btnAgain').onclick = () => {
    $('resultVideo').pause();
    if (state.resultFrom === 'record') goRecord();
    else if (state.resultFrom === 'gallery') { renderGallery(); show('screen-gallery'); }
    else show('screen-settings');
  };
  $('btnResultBack').onclick = () => { $('resultVideo').pause(); stopCamera(); show('screen-home'); renderSummary(); };
  $('btnBusyCancel').onclick = () => { if (state.abort) state.abort.abort(); };
  renderPresets(); renderSegments(); bindSettings(); bindProfiles(); renderMusicList(); renderSummary(); checkSupport();
  window.__booth = state; // para depuración
}

init();
