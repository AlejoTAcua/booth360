import { db } from './db.js';
import { loadSettings, saveSettings, PRESETS, SPEEDS, FONTS, LOOKS, expandTimeline, finalDuration, outputSize } from './settings.js';
import { support, openCamera, closeCamera, cameraSettings, recordClip } from './capture.js';
import { renderVideo, compressClip, normalizeClip } from './render.js';
import { EFFECTS, Effect } from './effects.js';
import { drawOverlay, ensureFontLoaded } from './overlay.js';
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
  const ov = s.overlay.mode === 'text' ? `“${(s.overlay.text || '').split('\n')[0]}”` : s.overlay.mode === 'image' ? 'imagen PNG' : 'sin texto';
  $('summary').innerHTML = `
    <div><b>Grabación:</b> ${s.capture.seconds}s a ${s.capture.fps} fps · <b>Final:</b> ~${fmtSec(dur)}${dur > 30 ? ' <span class="warnText">· largo: tarda más en editarse y pesa más (ideal 15–25 s)</span>' : ''}</div>
    <div><b>Velocidades:</b> ${passes}${s.timeline.smooth ? ' · suavizado' : ''}</div>
    <div><b>Efecto:</b> ${fx ? fx.name : '-'} · <b>Filtro:</b> ${look ? look.name : 'Natural'} · <b>Texto:</b> ${ov}</div>
    <div><b>Música:</b> ${musicOn ? `${musicOn} canción(es), ${s.music.mode === 'random' ? 'al azar' : 'en orden'}${s.music.beatSync !== false ? ', al ritmo' : ''}` : 'sin música'}</div>`;
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
      clip, settings: s, overlayImage: await getOverlayImage(), endCard: await getEndCard(), music, canvas, signal: ctrl.signal,
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
  if (!state.tracks.length) { list.innerHTML = '<p class="muted small">Todavía no hay canciones.</p>'; return; }
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
      ctx.fillStyle = '#39314f'; ctx.fillRect(x0, 0, x1 - x0, H);
      for (let i = 0; i < peaks.length; i++) {
        const x = i / peaks.length * W; const h = Math.max(1, peaks[i] * (H - 4));
        ctx.fillStyle = x >= x0 && x <= x1 ? '#ec4899' : '#6b6283';
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
  return Object.values(loadProfiles()).some((p) => (p.overlay && p.overlay.imageId === id) || (p.endCard && p.endCard.imageId === id));
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

// ---------- superposición ----------
async function getOverlayImage() {
  const o = state.settings.overlay;
  if (o.mode !== 'image' || !o.imageId) return null;
  if (state.overlayImage && state.overlayImage.id === o.imageId) return state.overlayImage.bmp;
  const a = await db.get('assets', o.imageId);
  if (!a) return null;
  const bmp = await createImageBitmap(a.blob);
  if (state.overlayImage) { try { state.overlayImage.bmp.close(); } catch (e) { /* */ } }
  state.overlayImage = { id: o.imageId, bmp };
  return bmp;
}
let ovPreviewFx = null;
async function drawOverlayPreview() {
  const c = $('ovPreview'); const ctx = c.getContext('2d'); const W = c.width, H = c.height;
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#3a2a55'); g.addColorStop(1, '#1b1230');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.ellipse(W / 2, H * 0.55, W * 0.22, H * 0.3, 0, 0, Math.PI * 2); ctx.fill();
  if (!ovPreviewFx || ovPreviewFx.type !== state.settings.effects.type) ovPreviewFx = new Effect(state.settings.effects.type, { intensity: state.settings.effects.intensity, color: state.settings.effects.color, seed: 3 });
  for (let i = 0; i < 20; i++) ovPreviewFx.render(ctx, W, H, 1 / 30);
  await ensureFontLoaded(state.settings.overlay, H);
  drawOverlay(ctx, W, H, state.settings.overlay, await getOverlayImage());
}
function bindOverlayDrag() {
  const c = $('ovPreview'); let dragging = false;
  const upd = (ev) => { const r = c.getBoundingClientRect(); state.settings.overlay.x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); state.settings.overlay.y = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)); drawOverlayPreview(); };
  c.addEventListener('pointerdown', (ev) => { if (state.settings.overlay.mode !== 'text') return; dragging = true; c.setPointerCapture(ev.pointerId); upd(ev); });
  c.addEventListener('pointermove', (ev) => { if (dragging) upd(ev); });
  c.addEventListener('pointerup', () => { if (dragging) { dragging = false; save(); } });
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
  const renderLooks = () => { lookBox.innerHTML = ''; for (const l of LOOKS) { const b = document.createElement('button'); b.className = 'chip' + ((s.look || 'none') === l.id ? ' on' : ''); b.textContent = l.name; b.onclick = () => { s.look = l.id; save(); renderLooks(); }; lookBox.appendChild(b); } };
  renderLooks();
  $('fxIntensity').value = s.effects.intensity; $('fxIntensity').oninput = (e) => { s.effects.intensity = +e.target.value; ovPreviewFx = null; save(); drawOverlayPreview(); };
  $('fxColor').value = s.effects.color; $('fxColor').oninput = (e) => { s.effects.color = e.target.value; ovPreviewFx = null; save(); drawOverlayPreview(); };

  // superposición
  const modes = [['text', 'Texto'], ['image', 'Imagen PNG'], ['none', 'Nada']];
  const mb = $('overlayModeChips');
  const renderModes = () => { mb.innerHTML = ''; for (const [id, name] of modes) { const b = document.createElement('button'); b.className = 'chip' + (s.overlay.mode === id ? ' on' : ''); b.textContent = name; b.onclick = () => { s.overlay.mode = id; save(); renderModes(); drawOverlayPreview(); }; mb.appendChild(b); }
    $('overlayText').classList.toggle('hidden', s.overlay.mode !== 'text'); $('overlayImage').classList.toggle('hidden', s.overlay.mode !== 'image'); };
  renderModes();
  $('ovText').value = s.overlay.text; $('ovText').oninput = (e) => { s.overlay.text = e.target.value; save(); drawOverlayPreview(); };
  $('ovEmoji').value = s.overlay.emoji || ''; $('ovEmoji').oninput = (e) => { s.overlay.emoji = e.target.value; save(); drawOverlayPreview(); };
  const fsel = $('ovFont'); fsel.innerHTML = FONTS.map(f => `<option value="${f.id}">${f.label}</option>`).join(''); fsel.value = s.overlay.font; fsel.onchange = (e) => { s.overlay.font = e.target.value; save(); drawOverlayPreview(); };
  $('ovSize').value = s.overlay.size; $('ovSize').oninput = (e) => { s.overlay.size = +e.target.value; save(); drawOverlayPreview(); };
  $('ovColor').value = s.overlay.color; $('ovColor').oninput = (e) => { s.overlay.color = e.target.value; save(); drawOverlayPreview(); };
  $('ovShadow').checked = s.overlay.shadow; $('ovShadow').onchange = (e) => { s.overlay.shadow = e.target.checked; save(); drawOverlayPreview(); };
  $('ovStroke').checked = s.overlay.stroke; $('ovStroke').onchange = (e) => { s.overlay.stroke = e.target.checked; save(); drawOverlayPreview(); };
  $('ovImageFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (s.overlay.imageId && !assetInProfiles(s.overlay.imageId)) { try { await db.del('assets', s.overlay.imageId); } catch (err) { /* */ } }
    const id = db.uid(); await db.put('assets', { id, kind: 'image', name: f.name, blob: f, created: Date.now() });
    s.overlay.imageId = id; state.overlayImage = null; save(); updateImageInfo(); drawOverlayPreview();
  };
  const updateImageInfo = async () => { const a = s.overlay.imageId ? await db.get('assets', s.overlay.imageId) : null; $('ovImageInfo').textContent = a ? `Imagen: ${a.name} (${fmtBytes(a.blob.size)})` : 'Sin imagen cargada.'; };
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
  $('storageInfo').textContent = `${vids.length} video(s) · ${fmtBytes(vids.reduce((a, v) => a + (v.size || 0), 0))}${u ? ` · espacio usado por la app ${fmtBytes(u.usage || 0)}` : ''}`;
  if (!vids.length) { list.innerHTML = '<p class="muted">Todavía no hay videos guardados.</p>'; return; }
  for (const v of vids) {
    const el = document.createElement('div'); el.className = 'gitem';
    el.innerHTML = `<video muted playsinline preload="metadata"></video><div class="meta"><div class="n">${escapeHtml(v.name)}</div><div class="muted small">${new Date(v.created).toLocaleString()} · ${v.kind === 'original' ? 'original' : 'editado'} · ${fmtSec(v.duration || 0)} · ${fmtBytes(v.size || 0)}</div>
      <div class="row"><button class="btn small primary sh">Compartir</button><button class="btn small pl">Ver</button><button class="btn small danger del">Borrar</button></div></div>`;
    list.appendChild(el);
    const vid = el.querySelector('video'); vid.src = URL.createObjectURL(v.blob); galleryUrls.push(vid.src);
    el.querySelector('.sh').onclick = () => shareBlob(v.blob, v.name + '.mp4');
    el.querySelector('.pl').onclick = () => { state.resultFrom = 'gallery'; showResult({ blob: v.blob, duration: v.duration || 0, width: '', height: '' }, null); $('resultInfo').textContent = `${v.name} · ${fmtBytes(v.size || 0)}`; $('btnAgain').textContent = 'Volver a la galería'; };
    el.querySelector('.del').onclick = async () => { if (!confirm(`¿Borrar “${v.name}”?`)) return; await db.del('videos', v.id); renderGallery(); };
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- arranque ----------
async function init() {
  if ('serviceWorker' in navigator && window.isSecureContext) { navigator.serviceWorker.register('./sw.js').catch(() => {}); }
  db.persist();
  await loadTracks();
  const s = state.settings;
  $('eventName').value = s.eventName; $('eventName').oninput = (e) => { s.eventName = e.target.value; save(); };
  $('btnGoRecord').onclick = goRecord;
  $('btnSettings').onclick = () => { show('screen-settings'); drawOverlayPreview(); };
  $('btnSettingsBack').onclick = () => { show('screen-home'); renderSummary(); };
  $('btnGallery').onclick = () => { renderGallery(); show('screen-gallery'); };
  $('btnGalleryBack').onclick = () => { releaseGallery(); $('galleryList').innerHTML = ''; show('screen-home'); };
  const workBusy = () => recording || !!state.abort;
  $('btnRecBack').onclick = () => { if (workBusy()) return toast('Esperá a que termine'); stopCamera(); show('screen-home'); };
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
  $('btnShare').onclick = () => state.lastResult && shareBlob(state.lastResult.blob, videoName('360') + '.mp4');
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
  $('btnResultBack').onclick = () => { $('resultVideo').pause(); stopCamera(); show('screen-home'); };
  $('btnBusyCancel').onclick = () => { if (state.abort) state.abort.abort(); };
  renderPresets(); renderSegments(); bindSettings(); bindProfiles(); renderMusicList(); renderSummary(); checkSupport();
  window.__booth = state; // para depuración
}

init();
