var rutKey = s => String(s || '').replace(/[^0-9kK]/g, '').toUpperCase().replace(/^0+/, '');
/* MEJORAS CHEQUEOS COMFRUT · Creado por Daniel Zunino · Integra Prevención SpA
   - Documentos del vehículo: foto + fecha SOLO la primera vez; después silencio hasta 15 días antes de vencer; vencido = se piden de nuevo.
   - Identificación más corta (RUT recordado, "Mi equipo de siempre", ruta recordada).
   - Plataforma fluida (sin recargar la pantalla en cada toque).
   - Envío en cola: funciona sin internet, por partes, con reintentos y sin duplicados. */
(function () {
  'use strict';
  if (typeof S === 'undefined' || typeof render !== 'function' || typeof LS === 'undefined') return;
  const DIAS_DOC = 15, PREF = 'cf_cache_', KD = ['soap', 'permiso', 'rt'], NOMD = { soap: 'Seguro obligatorio (SOAP)', permiso: 'Permiso de circulación', rt: 'Revisión técnica' };
  const _setItem = Storage.prototype.setItem, _remItem = Storage.prototype.removeItem;
  const st = document.createElement('style');
  st.textContent = '.docok{background:#E3F4E4;border-radius:12px;padding:10px 12px;margin-top:10px}.docw{background:#FFF0E0;border-radius:12px;padding:10px 12px;margin-top:10px}.doc{margin-top:4px}.doc .ph{margin-top:6px}#net{position:fixed;left:50%;transform:translateX(-50%);top:72px;z-index:30;background:#E65100;color:#fff;font-weight:700;font-size:13px;padding:6px 14px;border-radius:99px;box-shadow:0 3px 10px #0004;display:none;max-width:92vw;text-align:center}.toast{position:fixed;left:16px;right:16px;bottom:90px;z-index:31;max-width:600px;margin:auto;box-shadow:0 4px 18px #0003}';
  document.head.appendChild(st);
  const net = document.createElement('div'); net.id = 'net'; net.textContent = '📵 Sin internet: puedes seguir; se guarda en tu teléfono'; document.body.appendChild(net);
  const pintaNet = () => { net.style.display = navigator.onLine ? 'none' : 'block'; };
  addEventListener('offline', pintaNet); addEventListener('online', () => { pintaNet(); flush(); }); pintaNet();
  const toast = (t, ok) => { const d = document.createElement('div'); d.className = 'info toast' + (ok ? '' : ' x'); d.textContent = t; document.body.appendChild(d); setTimeout(() => d.remove(), 3600); };
  const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { _setItem.call(localStorage, k, v); } catch (e) {} };
  const lsJ = k => { try { return JSON.parse(lsGet(k)); } catch (e) { return null; } };
  const mi = s => String(s == null ? '' : s).replace(/\D/g, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const iso = s => { const d = aFecha(s); return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : ''; };

  // ---------- almacenamiento local (IndexedDB con respaldo en memoria)
  const mem = {};
  const idb = (() => { let db;
    const open = () => db ? Promise.resolve(db) : new Promise((ok, no) => { const r = indexedDB.open('cf_chequeo', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { db = r.result; ok(db); }; r.onerror = () => no(r.error); });
    const tx = (m, f) => open().then(d => new Promise((ok, no) => { const t = d.transaction('kv', m), q = f(t.objectStore('kv')); t.oncomplete = () => ok(q && q.result); t.onerror = () => no(t.error); }));
    return { get: k => tx('readonly', s => s.get(k)).catch(() => mem[k]), set: (k, v) => { mem[k] = v; return tx('readwrite', s => s.put(v, k)).catch(() => {}); }, del: k => { delete mem[k]; return tx('readwrite', s => s.delete(k)).catch(() => {}); }, keys: () => tx('readonly', s => s.getAllKeys()).catch(() => Object.keys(mem)) }; })();

  // ---------- red: tiempo máximo + caché de lecturas
  const conTimeout = (url, opt, ms) => { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); return fetch(url, Object.assign({ signal: c.signal }, opt)).finally(() => clearTimeout(t)); };
  const venc = d => { if (d && d.ok && !d.nuevo && d.ultimo) KD.forEach(k => { const dv = dias(d.ultimo[k]); if (dv != null && dv < 0) d.ultimo[k] = ''; }); return d; };
  window.api = async function (fn, arg) {
    if (fn === 'apiGuardar') return (await conTimeout(SCRIPT_URL, { method: 'POST', body: JSON.stringify(arg) }, 30000)).json();
    const ck = PREF + fn + '|' + (arg || '');
    try {
      const d = await (await conTimeout(SCRIPT_URL + '?' + new URLSearchParams(RUTAS[fn](arg)), {}, 15000)).json();
      if (d && d.ok) lsSet(ck, JSON.stringify(d));
      if (fn === 'apiOperador' && d && d.ok) { const u = lsJ('cf_ult_' + rutKey(arg)); if (u && u.patente) window.api('apiEquipo', u.patente).catch(() => {}); }
      return venc(d);
    } catch (e) { const c = lsJ(ck); if (c) { c._cache = true; return venc(c); } throw e; }
  };

  // ---------- envío en cola (por partes, con reintentos, sin duplicados)
  let PEND = 0; const enCurso = {}, enLinea = new Set(); let DF = {}, docEdit = {};
  async function post(o, ms) { let err; for (let k = 0; k < 3; k++) { try { return await (await conTimeout(SCRIPT_URL, { method: 'POST', body: JSON.stringify(o) }, ms || 20000)).json(); } catch (e) { err = e; if (!navigator.onLine) break; await new Promise(r => setTimeout(r, 700 * (k + 1))); } } throw err; }
  function intentar(id) {
    if (enCurso[id]) return enCurso[id];
    const p = (async () => {
      try {
        if (!navigator.onLine) return null;
        const rec = mem['out_' + id] || await idb.get('out_' + id); if (!rec) return null;
        rec.sent = rec.sent || {}; const txt = JSON.stringify(rec.body), N = 45000, n = Math.ceil(txt.length / N);
        for (let i = 0; i < n; i++) { if (rec.sent[i]) continue; const r = await post({ api: 'parte', envio: id, i, n, d: txt.slice(i * N, (i + 1) * N) }); if (!r || !r.ok) throw 'parte'; rec.sent[i] = 1; await idb.set('out_' + id, rec); prog(i + 1, n); }
        const d = await post({ api: 'commit', envio: id, n }, 70000);
        if (d && d.ok) { await idb.del('out_' + id); PEND = Math.max(0, PEND - 1); return d; }
        if (d && d.faltan) { d.faltan.forEach(i => delete rec.sent[i]); await idb.set('out_' + id, rec); }
        return null;
      } catch (e) { return null; } finally { delete enCurso[id]; }
    })();
    enCurso[id] = p; p.then(d => { if (d) alListo(id, d); }); return p;
  }
  const prog = (i, n) => { const e = document.getElementById('prog-env'); if (e) e.textContent = 'Enviando… ' + Math.round(i / n * 100) + '%'; };
  async function enviarCola(body) {
    const id = body.envio;
    clearTimeout(_gt); await idb.set('out_' + id, { id, body, t: Date.now() }); idb.del('draft_media'); PEND++; enLinea.add(id);
    let d = null; try { d = await Promise.race([intentar(id), new Promise(r => setTimeout(() => r(null), 22000))]); } finally { enLinea.delete(id); }
    return d || { ok: true, pendiente: true, codigo: '', link: '', enviados: [], sinCorreo: [], _envio: id };
  }
  function alListo(id, d) {
    if (S.fin && S.fin.pendiente && S.fin._envio === id) { S.fin = Object.assign({}, d, { resultado: S.fin.resultado, cat: S.fin.cat }); $('#app').innerHTML = vFin(); VOZ.say('Tu chequeo se envió correctamente.'); }
    else if (!enLinea.has(id)) toast('✅ Chequeo pendiente enviado' + (d.codigo ? ': ' + d.codigo : ''), true);
  }
  async function flush() { if (!navigator.onLine) return; const ks = (await idb.keys()).filter(k => String(k).startsWith('out_')); PEND = ks.length; ks.forEach(k => intentar(String(k).slice(4))); }
  window.reintentarEnvio = () => { toast('Intentando enviar…', true); flush(); };
  setInterval(flush, 20000); setTimeout(flush, 1500);

  const _say = VOZ.say; VOZ.say = function (t, e) { if (S.fin && S.fin.pendiente && /Chequeo enviado/.test(t)) t = 'Chequeo guardado en tu teléfono. Se enviará solo cuando tengas internet.'; return _say(t, e); };
  const _vFin = window.vFin;
  window.vFin = function () { const f = S.fin || {};
    if (!f.ok) return '<div class="card center"><div class="spin"></div><p>Enviando informe…</p><div id="prog-env" class="mut small"></div><p class="small mut">Si no hay buena señal, se guarda en tu teléfono y se envía solo.</p></div>';
    if (f.pendiente) return '<div class="card center"><div class="big">📲</div><h2>Chequeo guardado en tu teléfono</h2><p class="m">Aún no hay buena señal. <b>Se enviará solo</b> apenas tengas internet. Puedes cerrar la app o revisar otro equipo.</p><div class="info" id="prog-env">Pendiente de envío…</div><div style="height:10px"></div><button class="btn am" onclick="reintentarEnvio()">Reintentar ahora</button><div style="height:10px"></div><button class="btn gh" onclick="nuevo()">Revisar otro equipo</button></div>';
    return _vFin(); };
  const _vIni = window.vInicio;
  window.vInicio = function () { const h = _vIni(); return (PEND ? '<div class="info w" style="margin-bottom:12px">📲 Tienes ' + PEND + ' chequeo(s) guardado(s) esperando internet. Se envían solos.</div>' : '') + h; };

  // ---------- borrador liviano (fotos y firma van a IndexedDB)
  let _gt;
  const guardaYa = () => { if (S.paso >= pasoFin()) return; try { const c = Object.assign({}, S); ['fin', 'enviando', 'fotos', 'firma', 'fotoEq', '_ultVoz'].forEach(k => delete c[k]); _setItem.call(localStorage, LS, JSON.stringify(c)); } catch (e) {} idb.set('draft_media', { fotos: S.fotos, firma: S.firma, fotoEq: S.fotoEq, DF, docEdit }); };
  Storage.prototype.setItem = function (k, v) { if (this === localStorage && k === LS) { clearTimeout(_gt); _gt = setTimeout(guardaYa, 400); return; } return _setItem.call(this, k, v); };
  Storage.prototype.removeItem = function (k) { if (this === localStorage && k === LS) clearTimeout(_gt); return _remItem.call(this, k); };
  addEventListener('pagehide', guardaYa); document.addEventListener('visibilitychange', () => { if (document.hidden) guardaYa(); });
  const _seguir = window.seguir;
  window.seguir = async function () { S.fotos = {}; _seguir(); const m = await idb.get('draft_media'); if (m) { S.fotos = m.fotos || {}; S.firma = m.firma || ''; S.fotoEq = m.fotoEq || ''; DF = m.DF || {}; docEdit = m.docEdit || {}; render(); } };
  const _desc = window.descartar; window.descartar = function () { idb.del('draft_media'); DF = {}; docEdit = {}; S.envio = ''; _desc(); };

  // ---------- fotos más livianas
  async function comprime(file, max, q) {
    let src, w, h;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); w = src.width; h = src.height; }
    catch (e) { src = await new Promise((ok, no) => { const im = new Image(), u = URL.createObjectURL(file); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = no; im.src = u; }); w = src.width; h = src.height; }
    const r = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas'); c.width = Math.round(w * r); c.height = Math.round(h * r); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q).split(',')[1];
  }

  // ---------- pantalla estable
  let _paso = null; const _render = window.render;
  window.render = function () { const p = S.paso, sc = window.scrollY, igual = _paso === p; _render(); _paso = p; if (igual) window.scrollTo(0, sc);
    ['in-km', 'in-prox'].forEach(i => { const e = document.getElementById(i); if (e) e.value = mi(e.value); }); };
  document.addEventListener('input', e => { const t = e.target; if (t && (t.id === 'in-km' || t.id === 'in-prox')) t.value = mi(t.value).slice(0, 9); });

  // ---------- toques sin recargar la pantalla
  function pintaItem(k) {
    const v = S.res[k] || '', box = document.getElementById('it-' + k.replace('.', '-')); if (!box) return;
    box.className = 'item' + (v ? ' v-' + v : '');
    box.querySelectorAll('.opts button').forEach(b => { const m = /'(B|R|M|NA)'\)/.exec(b.getAttribute('onclick') || ''), x = m && m[1]; b.className = x && x === v ? 'on ' + x : ''; });
    const det = box.querySelector('.det'); if (!det) return; det.classList.toggle('on', v === 'R' || v === 'M'); det.querySelectorAll('.info.x').forEach(e => e.remove());
    const [bid, iid] = k.split('.'), b = bloques().find(x => x.id === bid), it = b && b.items.find(x => x.id === iid);
    if (v === 'M' && it && it.crit) { const d = document.createElement('div'); d.className = 'info x'; d.style.marginTop = '8px'; d.innerHTML = '🛑 <b>' + (b.sn ? 'Hoy no estás en condiciones de manejar.' : 'Ítem crítico en mal estado:') + '</b> ' + (b.sn ? 'Avisa a tu jefatura para que otra persona lo haga.' : NO_SALE[CAT()] + ' hasta que se corrija.'); det.appendChild(d); }
  }
  window.marca = function (k, v) {
    S.res[k] = v; pintaItem(k); guarda(); guia(true);
    if (v === 'R' || v === 'M') setTimeout(() => { const t = document.querySelector('#it-' + k.replace('.', '-') + ' textarea'); if (t && !t.value) t.focus({ preventScroll: true }); }, 300);
    const [bid, iid] = k.split('.'), b = bloques().find(x => x.id === bid), it = b.items.find(x => x.id === iid);
    if (v === 'M' && it.crit) VOZ.say(b.sn ? 'Gracias por ser honesto. Hoy no debes manejar. Avisa a tu jefatura.' : 'Atención. ' + it.t + ' es un punto crítico. Cuenta qué encontraste y saca una foto.');
    else if (v === 'R' || v === 'M') VOZ.say('Cuenta brevemente qué pasa.');
    else if (b.items.every(x => S.res[bid + '.' + x.id])) VOZ.say('¡Bien! Terminaste esta parte. Toca siguiente.');
    else VOZ.stop();
  };
  window.todoBien = function (bid) { const b = bloques().find(x => x.id === bid); b.items.forEach(it => { const k = bid + '.' + it.id; if (!S.res[k]) { S.res[k] = 'B'; pintaItem(k); } }); guarda(); guia(true); };
  const phHtml = k => { const f = S.fotos[k]; return '<label>📷 ' + (f ? 'Cambiar foto' : 'Agregar foto') + '<input type="file" accept="image/*" capture="environment" class="hide" onchange="foto(\'' + k + '\',this)"></label>' + (f ? '<img src="data:image/jpeg;base64,' + f + '">' : ''); };
  window.foto = function (k, inp) { const file = inp.files && inp.files[0]; if (!file) return;
    if (!S.fotos[k] && Object.keys(S.fotos).length >= 6) { alertaUI('Máximo 6 fotos por chequeo.'); return; }
    comprime(file, 900, 0.65).then(b => { S.fotos[k] = b; const ph = document.querySelector('#it-' + k.replace('.', '-') + ' .ph'); if (ph) ph.innerHTML = phHtml(k); guarda(); }).catch(() => alertaUI('No se pudo leer la foto. Intenta de nuevo.')); };
  window.fotoEquipo = function (inp) { const file = inp.files && inp.files[0]; if (file) comprime(file, 900, 0.65).then(b => { S.fotoEq = b; guarda(); render(); }).catch(() => alertaUI('No se pudo leer la foto. Intenta de nuevo.')); };
  window.togRep = function (k) { const i = S.rep.indexOf(k); if (i >= 0) S.rep.splice(i, 1); else S.rep.push(k); const on = S.rep.indexOf(k) >= 0;
    document.querySelectorAll('.who:not(.lock)').forEach(w => { if ((w.getAttribute('onclick') || '').indexOf("'" + k + "'") >= 0) { w.classList.toggle('on', on); w.querySelector('.ck').textContent = on ? '✓' : ''; } }); guarda(); };

  // ---------- identificación más corta
  const resetDoc = () => { DF = {}; docEdit = {}; };
  const _elT = window.elegirTipo; window.elegirTipo = function (t) { if (S.tipo !== t) resetDoc(); _elT(t); };
  const _nuevo = window.nuevo; window.nuevo = function () { resetDoc(); _nuevo(); };
  const _pick = window.pickPat;
  const rutPersona = () => rutKey(lsGet('cf_rut') || '');
  const guardaUlt = () => { if (S.persona && S.tipo && S.patente && !S.nuevoEq) lsSet('cf_ult_' + rutPersona(), JSON.stringify({ tipo: S.tipo, patente: S.patente, fumiga: S.fumiga, fumiEq: S.fumiEq })); };
  window.pickPat = async function (v) {
    if (v !== '__nuevo' && patKey(v) !== patKey(S.patente)) { resetDoc(); Object.assign(S, { soap: '', permiso: '', rt: '', prox: '', marca: '', km: '', asientos: '', pasajeros: '', fumiga: '', fumiEq: '', producto: '', lugar: lsGet('cf_lugar_' + patKey(v)) || lsGet('cf_lugar_ult') || '' }); }
    await _pick(v); guardaUlt();
  };
  const _vTipo = window.vTipo;
  window.vTipo = function () { let h = _vTipo(); const u = lsJ('cf_ult_' + rutPersona()), eq = u && S.equipos.find(x => x.t === u.tipo && patKey(x.p) === patKey(u.patente));
    if (eq) { const card = '<div class="card"><h3>⚡ Mi equipo de siempre</h3><button class="eq" onclick="atajo()">' + SVG[eq.t] + '<div><b>' + esc(TIPOS[eq.t].t) + ' ' + esc(eq.p) + '</b><span>' + esc(eq.m || '') + '</span><span class="sug">Toca para empezar el chequeo</span></div></button></div>';
      const i = h.indexOf('<div class="card"><h3>¿Qué vas a revisar?'); if (i >= 0) h = h.slice(0, i) + card + h.slice(i); }
    return h; };
  window.atajo = async function () { const u = lsJ('cf_ult_' + rutPersona()); if (!u) return; window.elegirTipo(u.tipo); await window.pickPat(u.patente); if (u.fumiga) { S.fumiga = u.fumiga; S.fumiEq = u.fumiEq || ''; render(); } };

  // ---------- documentos: foto la primera vez, después silencio hasta 15 días antes del vencimiento
  const infoDoc = k => (S.eqInfo && S.eqInfo.docs && S.eqInfo.docs[k]) || null;
  function estDoc(k) {
    const inf = infoDoc(k), dv = dias(S[k]);
    if (DF[k] || docEdit[k]) return 'edit';
    if (inf && inf.resp && S[k] && dv != null && iso(S[k]) === iso(inf.f)) { if (dv > DIAS_DOC) return 'ok'; if (dv >= 0) return 'pronto'; }
    return 'falta';
  }
  const badgeF = s => { const dv = dias(s); return dv == null ? '' : dv < 0 ? '<span class="badge b-x">VENCIDO</span>' : dv <= DIAS_DOC ? '<span class="badge b-w">vence en ' + dv + ' días</span>' : '<span class="badge b-ok">vigente</span>'; };
  function vDoc(k) {
    const e = estDoc(k), inf = infoDoc(k), dv = dias(S[k]), f = DF[k], t = NOMD[k];
    if (e === 'ok') return '<div class="docok"><b>✅ ' + t + '</b><div class="small mut">Vigente hasta ' + esc(S[k]) + ' · respaldo guardado' + (inf && inf.resp !== true ? ' · <a href="' + esc(inf.resp) + '" target="_blank">ver</a>' : '') + '</div><button class="why" onclick="docEditar(\'' + k + '\')">Renovar documento</button></div>';
    if (e === 'pronto') return '<div class="docw"><b>⚠️ ' + t + '</b> <span class="badge b-w">vence en ' + dv + ' días</span><div class="small">Vence el ' + esc(S[k]) + '. Cuando lo renueves, sube el nuevo.</div><button class="btn gh" style="padding:9px;font-size:14px;margin-top:6px" onclick="docEditar(\'' + k + '\')">📷 Subir documento renovado</button></div>';
    return '<label class="l">' + t + ' <span id="b-' + k + '">' + badgeF(S[k]) + '</span></label><input id="f-' + k + '" type="date" value="' + iso(S[k]) + '" onchange="fechaDoc(\'' + k + '\',this.value)">' +
      '<div class="ph"><label>📷 ' + (f ? 'Cambiar foto' : 'Foto del documento') + '<input type="file" accept="image/*" capture="environment" class="hide" onchange="fotoDoc(\'' + k + '\',this)"></label>' + (f ? '<img src="data:image/jpeg;base64,' + f + '">' : '<span class="small mut">Obligatoria esta vez</span>') + '</div>' +
      (docEdit[k] ? '<button class="why" onclick="docCancelar(\'' + k + '\')">Cancelar</button>' : '');
  }
  function vDocs() {
    const todo = KD.every(k => estDoc(k) === 'ok');
    return '<div class="card" id="docs"><h3>📄 Documentos del vehículo</h3><p class="m">' + (todo ? '✅ Los documentos ya están respaldados y vigentes: no hace falta subirlos otra vez.' : 'Saca una foto a cada documento (guantera) y anota su vencimiento. Se pide <b>solo esta vez</b>; después el sistema avisa 15 días antes de que venza.') + '</p>' +
      KD.map(k => '<div class="doc" id="doc-' + k + '">' + vDoc(k) + '</div>').join('') + '</div>';
  }
  const _vEq = window.vEquipo;
  window.vEquipo = function () { let h = _vEq(); h = h.replace(/placeholder="(km|horas) del adhesivo"/, 'id="in-prox" placeholder="$1 del adhesivo"');
    if (CAT() === 'veh') { const i = h.indexOf('<div class="card"><h3>📄 Documentos del vehículo'); if (i >= 0) h = h.slice(0, i) + vDocs(); }
    return h; };
  const pintaDoc = k => { const e = document.getElementById('doc-' + k); if (e) e.innerHTML = vDoc(k); const c = document.getElementById('docs'); if (c) { const p = c.querySelector('p.m'), todo = KD.every(x => estDoc(x) === 'ok'); if (p && todo) p.innerHTML = '✅ Los documentos ya están respaldados y vigentes: no hace falta subirlos otra vez.'; } guarda(); guia(true); };
  window.fechaDoc = (k, v) => { S[k] = v ? dd(aFecha(v)) : ''; const b = document.getElementById('b-' + k); if (b) b.innerHTML = badgeF(S[k]); guarda(); guia(true); };
  window.docEditar = k => { docEdit[k] = 1; pintaDoc(k); };
  window.docCancelar = k => { delete docEdit[k]; delete DF[k]; const i = infoDoc(k); if (i && i.f) S[k] = i.f; pintaDoc(k); };
  window.fotoDoc = (k, inp) => { const file = inp.files && inp.files[0]; if (!file) return; comprime(file, 1400, 0.72).then(b => { DF[k] = b; pintaDoc(k); }).catch(() => alertaUI('No se pudo leer la foto. Intenta de nuevo.')); };
  const _val = window.validar;
  window.validar = function () { const e = _val(); if (e) return e;
    if (S.paso === 2 && CAT() === 'veh') for (const k of KD) { const s = estDoc(k); if ((s === 'falta' || s === 'edit') && !DF[k]) { const el = document.querySelector('#doc-' + k); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return 'Falta la foto de: ' + NOMD[k] + '. Se pide solo esta vez.'; } }
    return ''; };
  const _ev = window.evaluar;
  window.evaluar = function () {
    const E = _ev(); if (CAT() !== 'veh') return E;
    const NM = { 'SOAP': 'soap', 'Permiso de circulación': 'permiso', 'Revisión técnica': 'rt' };
    E.al = E.al.filter(a => { const k = NM[a.item]; if (!k || a.nivel !== 'Documento' || !/^Vence el/.test(a.det || '')) return true; const dv = dias(S[k]); return dv != null && dv <= DIAS_DOC; });
    const c = CAT(), crit = E.al.some(a => a.nivel === 'Crítica'), med = E.al.some(a => a.nivel === 'Media' || a.nivel === 'Documento'), quien = { veh: 'El vehículo', tractor: 'El tractor', comedor: 'El comedor' }[c];
    E.resultado = crit ? 'NO APTO' : med ? 'APTO CON OBSERVACIONES' : 'APTO';
    E.mensaje = crit ? quien + ' ' + NO_SALE[c] + ' hasta corregir las fallas críticas. Avisa de inmediato a tu jefatura.' : med ? 'Se puede usar con precaución. Las observaciones deben corregirse pronto.' : '¡Todo en buenas condiciones! Buen trabajo revisando.';
    return E;
  };

  // ---------- semáforo en la pantalla de resultado
  const SEMF = r => { const n = r === 'NO APTO' ? 0 : r === 'APTO' ? 2 : 1, c = ['#EF4444', '#FACC15', '#22C55E'], off = ['#5B2B2B', '#5B4B1B', '#1F4B2B'];
    return '<svg viewBox="0 0 156 60" width="156" height="60" style="display:block;margin:0 auto 8px" aria-label="Semáforo"><rect x="2" y="2" width="152" height="56" rx="28" fill="#1F2A30" stroke="#fff" stroke-opacity=".6" stroke-width="2"/>' +
      [0, 1, 2].map(i => '<circle cx="' + (31 + i * 47) + '" cy="30" r="18" fill="' + (i === n ? c[i] : off[i]) + '"/>' + (i === n ? '<circle cx="' + (25 + i * 47) + '" cy="23" r="5" fill="#fff" opacity=".55"/>' : '')).join('') + '</svg>'; };
  const _vRes = window.vResumen;
  window.vResumen = function () { const h = _vRes(); if (h.indexOf('<svg') >= 0 && h.indexOf('aria-label="Semáforo"') >= 0) return h; return h.replace(/<div style="font-size:40px">[^<]*<\/div>/, SEMF(evaluar().resultado)); };

  // ---------- enviar: siempre llega o queda guardado en el teléfono
  window.enviar = async function () {
    if (S.enviando) return; S.enviando = true;
    if (!S.envio) S.envio = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
    const E = evaluar(), bl = bloques(), c = CAT(), id = S.envio;
    const fotos = Object.keys(S.fotos).map(k => { const [b, i] = k.split('.'), bb = bl.find(x => x.id === b), it = bb && bb.items.find(x => x.id === i); return it ? { item: it.t, b64: S.fotos[k] } : null; }).filter(Boolean);
    const body = { envio: id, pid: S.persona.id, tipo: S.tipo, cat: c, patente: S.patente, nuevo: S.nuevoEq, marca: S.marca, anio: S.anio, fotoEquipo: S.nuevoEq ? S.fotoEq : '',
      lugar: S.lugar, asientos: c === 'veh' ? num(S.asientos) : '', pasajeros: c === 'veh' ? num(S.pasajeros) : '', trab: c === 'comedor' ? num(S.trab) : '', banos: c === 'comedor' ? num(S.banos) : '',
      fumiga: c === 'tractor' && S.fumiga === 'si', fumiEq: S.fumiEq, producto: S.producto,
      km: S.km, prox: S.prox, soap: c === 'veh' ? S.soap : '', permiso: c === 'veh' ? S.permiso : '', rt: c === 'veh' ? S.rt : '', datos: datosInforme(),
      resultado: E.resultado, mensaje: E.mensaje, pct: E.pct, aseo: E.aseo, alertas: E.al, okItems: E.okItems, obs: S.obs, reportar: S.rep, firma: S.firma, fotos, docFotos: c === 'veh' ? Object.assign({}, DF) : {},
      bloques: bl.map(b => ({ t: b.t, sn: !!b.sn, items: b.items.map(it => ({ t: it.t, crit: it.crit, v: S.res[b.id + '.' + it.id] || '', c: S.com[b.id + '.' + it.id] || '' })) })) };
    if (S.lugar) { lsSet('cf_lugar_' + patKey(S.patente), S.lugar); lsSet('cf_lugar_ult', S.lugar); }
    guardaUlt();
    S.paso = pasoFin(); S.fin = null; render();
    const d = await enviarCola(body);
    S.enviando = false; try { localStorage.removeItem(LS); } catch (e) {} idb.del('draft_media');
    S.fin = d.pendiente ? { ok: true, pendiente: true, _envio: id, resultado: E.resultado, cat: c } : Object.assign(d, { resultado: E.resultado, cat: c });
    $('#app').innerHTML = vFin(); $('#foot').classList.add('hide'); $('#bar').style.width = '100%'; const m = $('#mano'); if (m) m.classList.remove('on');
    VOZ.say(E.resultado === 'NO APTO' ? 'Chequeo enviado. Recuerda: ' + NO_SALE[c].toLowerCase() + ' hasta corregir. Avisa de inmediato a tu jefatura.' : '¡Chequeo enviado! Gracias por cuidar a tu cuadrilla.');
  };

  // ---------- abrir sin internet (service worker)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();
