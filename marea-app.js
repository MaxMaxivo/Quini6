"use strict";

const LEGACY_STORE_KEY = "marea-quini-state-v2";
const GUEST_STORE_KEY = "marea-quini-state-v3:guest";
const USER_STORE_PREFIX = "marea-quini-state-v3:user:";
const RENDITION_START = "2026-04-01";
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const MAX_IMAGES_PER_ENTRY = 12;
const PAYERS = ["ale", "zamba"];
const SYNC_DELAY_MS = 700;

const {
  VALID_STATUSES,
  collectLocalImages,
  dataUrlToBlob,
  emptyState,
  hasMeaningfulState,
  mergeStates,
  normalizeState,
  replaceImageReferences,
} = window.QuiniState;

const onlineStore = window.QuiniOnlineStore.create(window.QUINI_CONFIG);

let data;
let stateLoadWarning = "";
let state = loadGuestCache();
let activeMonth;
let activeContest;
let imageTarget;
let currentUser = null;
let publicView = false;
let publicRefreshPromise = null;
let serverRevision = null;
let dirty = false;
let stateSequence = 0;
let syncTimer = null;
let syncPromise = null;
let syncAgain = false;
let controlsLocked = false;
let pendingImageDeletes = [];
let lastSyncError = "";
const imageUrlCache = new Map();

function cacheKey(userId = currentUser?.id) {
  return userId ? `${USER_STORE_PREFIX}${userId}` : GUEST_STORE_KEY;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const envelope = parsed?.version === 3 && parsed.state ? parsed : { state: parsed };
    return {
      state: normalizeState(envelope.state),
      revision: Number.isInteger(envelope.revision) && envelope.revision >= 1
        ? envelope.revision
        : null,
      dirty: envelope.dirty === true,
      pendingImageDeletes: Array.isArray(envelope.pendingImageDeletes)
        ? envelope.pendingImageDeletes.filter(path => typeof path === "string")
        : [],
    };
  } catch (error) {
    console.warn(`No se pudo leer ${key}:`, error);
    return null;
  }
}

function loadGuestCache() {
  const current = readCache(GUEST_STORE_KEY);
  if (current) return current.state;
  try {
    const legacy = localStorage.getItem(LEGACY_STORE_KEY);
    if (legacy) return normalizeState(JSON.parse(legacy));
  } catch (error) {
    console.warn("No se pudo cargar el estado local anterior:", error);
    stateLoadWarning = "El estado anterior de este navegador no pudo leerse. No fue eliminado.";
  }
  return emptyState();
}

function writeCache() {
  if (publicView && !currentUser) return;
  const envelope = {
    version: 3,
    savedAt: new Date().toISOString(),
    revision: serverRevision,
    dirty: currentUser ? dirty : false,
    pendingImageDeletes,
    state,
  };
  localStorage.setItem(cacheKey(), JSON.stringify(envelope));
}

function showMessage(message, type = "") {
  const element = document.getElementById("app-message");
  element.textContent = message;
  element.className = `feedback ${type}`.trim();
}

function persistState() {
  if (currentUser) dirty = true;
  try {
    writeCache();
  } catch (error) {
    console.error("No se pudo guardar el estado local:", error);
    showMessage(
      "No se pudo guardar el cambio en este dispositivo. Exportá un respaldo antes de continuar.",
      "error",
    );
    return false;
  }

  stateSequence += 1;
  if (currentUser) scheduleSync();
  else updateAccountUI();
  return true;
}

function drawState(contest) {
  const key = String(contest);
  if (!state.draws[key]) state.draws[key] = { status: "pending", tickets: [] };
  return state.draws[key];
}

function paymentState(person, month = activeMonth) {
  state.payments[month] ||= {};
  state.payments[month][person] ||= { paid: false, receipts: [] };
  return state.payments[month][person];
}

function touch(record) {
  const timestamp = new Date().toISOString();
  record.updatedAt = timestamp;
  state.updatedAt = timestamp;
}

function stampAllRecords(candidate) {
  const stamped = normalizeState(candidate);
  const timestamp = new Date().toISOString();
  for (const draw of Object.values(stamped.draws)) draw.updatedAt = timestamp;
  for (const people of Object.values(stamped.payments)) {
    for (const payment of Object.values(people)) payment.updatedAt = timestamp;
  }
  stamped.updatedAt = timestamp;
  return stamped;
}

function money(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function monthLabel(month) {
  const [year, number] = month.split("-");
  return new Date(+year, +number - 1, 1).toLocaleDateString("es-AR", {
    month: "long",
    year: "numeric",
  });
}

function dateLabel(isoDate, options) {
  return new Date(`${isoDate}T12:00:00-03:00`).toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    ...options,
  });
}

function months() {
  return [...new Set(
    data.sorteos
      .filter(draw => draw.fecha >= RENDITION_START)
      .map(draw => draw.fecha.slice(0, 7)),
  )].sort();
}

function drawsForMonth() {
  return data.sorteos
    .filter(draw => draw.fecha.startsWith(activeMonth))
    .sort((first, second) => first.fecha.localeCompare(second.fecha));
}

function defaultDrawCost(draw) {
  const period = (data.precios_por_periodo || [])
    .filter(item => item.desde <= draw.fecha)
    .sort((first, second) => second.desde.localeCompare(first.desde))[0];
  return (period?.precio_boleta ?? data.precio_boleta) * data.boletas_por_sorteo;
}

function validNumbers(values) {
  return (
    Array.isArray(values)
    && values.length === 6
    && new Set(values).size === 6
    && values.every(value => Number.isInteger(value) && value >= 0 && value <= 45)
  );
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateAppData(candidate) {
  if (
    !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || !validNumbers(candidate.mis_numeros)
    || !Number.isFinite(candidate.precio_boleta) || candidate.precio_boleta <= 0
    || !Number.isInteger(candidate.boletas_por_sorteo) || candidate.boletas_por_sorteo <= 0
    || !Number.isInteger(candidate.integrantes) || candidate.integrantes <= 0
    || !Array.isArray(candidate.sorteos) || candidate.sorteos.length === 0
  ) throw new Error("data.json no tiene una configuración válida");

  const contests = new Set();
  const dates = new Set();
  for (const draw of candidate.sorteos) {
    if (
      !draw || typeof draw !== "object" || Array.isArray(draw)
      || !Number.isInteger(draw.concurso) || draw.concurso <= 0
      || contests.has(draw.concurso)
      || !validIsoDate(draw.fecha) || dates.has(draw.fecha)
      || typeof draw.url !== "string" || !draw.url.startsWith("https://")
      || !["tradicional", "segunda", "revancha", "siempre_sale"]
        .every(section => validNumbers(draw[section]))
    ) throw new Error("data.json contiene un sorteo inválido");
    contests.add(draw.concurso);
    dates.add(draw.fecha);
  }

  if (candidate.precios_por_periodo !== undefined && (
    !Array.isArray(candidate.precios_por_periodo)
    || candidate.precios_por_periodo.some(period => (
      !period || typeof period !== "object" || Array.isArray(period)
      || !validIsoDate(period.desde)
      || !Number.isFinite(period.precio_boleta) || period.precio_boleta <= 0
    ))
  )) throw new Error("data.json contiene un período de precios inválido");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  if (!data) return;
  renderMonths();
  renderDrawTabs();
  renderDraw();
  renderSummary();
  renderPayments();
}

function renderMonths() {
  document.getElementById("month-tabs").innerHTML = months().map(month => (
    `<button type="button" class="tab ${month === activeMonth ? "active" : ""}" `
    + `aria-pressed="${month === activeMonth}" data-action="select-month" data-month="${month}">`
    + `${monthLabel(month)}</button>`
  )).join("");
}

function selectMonth(month) {
  if (!months().includes(month)) return;
  activeMonth = month;
  activeContest = drawsForMonth().at(-1)?.concurso;
  render();
}

function renderDrawTabs() {
  const container = document.getElementById("draw-tabs");
  const draws = drawsForMonth();
  if (draws.length === 0) {
    container.innerHTML = '<div class="empty compact">No hay sorteos en este mes.</div>';
    return;
  }
  container.innerHTML = draws.map(draw => {
    const current = drawState(draw.concurso);
    const icon = current.status === "played" ? "✓" : current.status === "skipped" ? "×" : "·";
    const label = dateLabel(draw.fecha, { weekday: "short", day: "numeric" });
    return (
      `<button type="button" class="draw-tab ${draw.concurso === activeContest ? "active" : ""} ${current.status}" `
      + `aria-pressed="${draw.concurso === activeContest}" data-action="select-draw" data-contest="${draw.concurso}">`
      + `<span aria-hidden="true">${icon}</span> ${label}</button>`
    );
  }).join("");
}

function resultMode(name, values) {
  const hits = values.filter(value => data.mis_numeros.includes(value)).length;
  return `<section class="mode"><h3 class="mode-name">${name}</h3><div class="result-row">
    ${values.map(value => (
      `<span class="result-ball ${data.mis_numeros.includes(value) ? "hit" : ""}">`
      + `${String(value).padStart(2, "0")}</span>`
    )).join("")}
    <span class="hits">${hits} acierto${hits === 1 ? "" : "s"}</span>
  </div></section>`;
}

function statusButton(contest, status, label) {
  const active = drawState(contest).status === status;
  return (
    `<button type="button" class="status-btn ${status} ${active ? "active" : ""}" `
    + `aria-pressed="${active}" data-action="set-status" data-contest="${contest}" `
    + `data-status="${status}" ${controlsLocked ? "disabled" : ""}>${label}</button>`
  );
}

function imageSource(image) {
  if (typeof image === "string") return image;
  const cached = imageUrlCache.get(image.path);
  if (cached?.url) return cached.url;
  if (!cached && (currentUser || publicView) && onlineStore.available) loadImageUrl(image.path);
  return "";
}

function thumb(image, action, descriptor, alt) {
  const source = imageSource(image);
  const path = typeof image === "object" ? image.path : "";
  return `<figure class="thumb ${source ? "" : "loading"}">
    ${source
      ? `<button type="button" class="thumb-open" data-action="open-image" data-image-path="${escapeHtml(path)}" aria-label="Ampliar ${escapeHtml(alt.toLowerCase())}"><img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}" loading="lazy"></button>`
      : `<span class="thumb-placeholder">Cargando…</span>`}
    <button type="button" class="remove" data-action="${action}" ${descriptor} aria-label="Eliminar ${escapeHtml(alt.toLowerCase())}" ${controlsLocked ? "disabled" : ""}>×</button>
  </figure>`;
}

async function loadImageUrl(path) {
  imageUrlCache.set(path, { loading: true });
  try {
    const url = await onlineStore.createImageUrl(path);
    imageUrlCache.set(path, { url });
    render();
  } catch (error) {
    console.error("No se pudo abrir una imagen adjunta:", error);
    imageUrlCache.set(path, { error: true });
    showMessage("No se pudo cargar uno de los adjuntos.", "error");
  }
}

function renderDraw() {
  const draw = data.sorteos.find(item => item.concurso === activeContest);
  const detail = document.getElementById("draw-detail");
  if (!draw) {
    detail.innerHTML = '<div class="empty">No hay un sorteo seleccionado.</div>';
    return;
  }

  const current = drawState(draw.concurso);
  const cost = current.cost ?? defaultDrawCost(draw);
  const drawDate = dateLabel(draw.fecha, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  detail.innerHTML = `
    <div class="draw-header"><div><h2>${drawDate}</h2><div class="contest">Concurso ${draw.concurso}</div></div>
    <a class="source-link" href="${escapeHtml(draw.url)}" target="_blank" rel="noopener noreferrer">Ver fuente del resultado <span aria-hidden="true">↗</span></a></div>
    <div class="results-grid">
      ${resultMode("Tradicional", draw.tradicional)}
      ${resultMode("La Segunda", draw.segunda)}
      ${resultMode("Revancha", draw.revancha)}
      ${resultMode("Siempre Sale", draw.siempre_sale)}
    </div>
    <div class="control">
      <div class="control-top">
        <fieldset><legend class="label">¿Se jugó este sorteo?</legend>
          <div class="status-actions">
            ${statusButton(draw.concurso, "played", "Jugado")}
            ${statusButton(draw.concurso, "skipped", "No jugado")}
            ${statusButton(draw.concurso, "pending", "Pendiente")}
          </div>
        </fieldset>
        <div class="money"><label for="cost-${draw.concurso}">Gasto total</label>
          <span class="money-input"><span aria-hidden="true">$</span><input id="cost-${draw.concurso}" data-action="set-cost" data-contest="${draw.concurso}" type="number" inputmode="numeric" min="0" step="100" value="${cost}" ${controlsLocked ? "disabled" : ""}></span>
        </div>
      </div>
      <div class="ticket-zone">
        <div class="attachment-head"><div><span class="label">Tickets</span><p>Fotos asociadas a este sorteo.</p></div>
          <button type="button" class="ghost" data-action="add-ticket" data-contest="${draw.concurso}" ${controlsLocked ? "disabled" : ""}>Adjuntar ticket</button></div>
        <div class="thumbs">${current.tickets.length
          ? current.tickets.map((image, index) => thumb(
            image,
            "remove-ticket",
            `data-contest="${draw.concurso}" data-index="${index}"`,
            `Ticket ${index + 1} del concurso ${draw.concurso}`,
          )).join("")
          : '<p class="empty-inline">Todavía no hay tickets adjuntos.</p>'}</div>
      </div>
    </div>`;
}

function totals() {
  const draws = drawsForMonth();
  const played = draws.filter(draw => drawState(draw.concurso).status === "played");
  const skipped = draws.filter(draw => drawState(draw.concurso).status === "skipped");
  const total = played.reduce(
    (sum, draw) => sum + (drawState(draw.concurso).cost ?? defaultDrawCost(draw)),
    0,
  );
  return {
    played: played.length,
    skipped: skipped.length,
    pending: draws.length - played.length - skipped.length,
    total,
    share: total / data.integrantes,
  };
}

function renderSummary() {
  const total = totals();
  document.getElementById("summary").innerHTML = [
    [total.played, "Jugados", "played"],
    [total.skipped, "No jugados", "skipped"],
    [total.pending, "Pendientes", "pending"],
    [money(total.total), "Gasto total", "money-total"],
    [money(total.share), "Cada uno", "share"],
  ].map(([value, label, modifier]) => (
    `<div class="stat ${modifier}"><strong>${value}</strong><span>${label}</span></div>`
  )).join("");
}

function renderPayments() {
  document.getElementById("payment-month").textContent = monthLabel(activeMonth);
  const share = totals().share;
  document.getElementById("payments").innerHTML = PAYERS.map(person => {
    const payment = paymentState(person);
    const name = person[0].toUpperCase() + person.slice(1);
    return `<article class="person ${payment.paid ? "is-paid" : ""}">
      <div class="person-head"><div><h3>${name}</h3><div class="owed">Debe transferir <strong>${money(share)}</strong></div></div>
        <span class="payment-badge">${payment.paid ? "Pagado" : "Pendiente"}</span></div>
      <div class="actions">
        <button type="button" class="ghost ${payment.paid ? "paid" : ""}" aria-pressed="${payment.paid}" data-action="toggle-paid" data-person="${person}" ${controlsLocked ? "disabled" : ""}>${payment.paid ? "Desmarcar pago" : "Marcar como pagado"}</button>
        <button type="button" class="ghost" data-action="add-receipt" data-person="${person}" ${controlsLocked ? "disabled" : ""}>Adjuntar comprobante</button>
      </div>
      <div class="thumbs">${payment.receipts.length
        ? payment.receipts.map((image, index) => thumb(
          image,
          "remove-receipt",
          `data-person="${person}" data-index="${index}"`,
          `Comprobante ${index + 1} de ${name}`,
        )).join("")
        : '<p class="empty-inline">Sin comprobantes.</p>'}</div>
    </article>`;
  }).join("");
}

function setStatus(contest, status) {
  if (controlsLocked || !VALID_STATUSES.has(status)) return;
  const current = drawState(contest);
  const previous = current.status;
  const previousUpdatedAt = current.updatedAt;
  current.status = status;
  touch(current);
  if (!persistState()) {
    current.status = previous;
    current.updatedAt = previousUpdatedAt;
  } else {
    const labels = { played: "jugado", skipped: "no jugado", pending: "pendiente" };
    showMessage(`Concurso ${contest} marcado como ${labels[status]}.`, "success");
  }
  render();
}

function setCost(contest, value) {
  if (controlsLocked) return;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    showMessage("Ingresá un gasto válido, igual o mayor que cero.", "error");
    renderDraw();
    return;
  }
  const current = drawState(contest);
  const previous = { cost: current.cost, updatedAt: current.updatedAt, hadCost: Object.hasOwn(current, "cost") };
  current.cost = amount;
  touch(current);
  if (!persistState()) {
    if (previous.hadCost) current.cost = previous.cost;
    else delete current.cost;
    current.updatedAt = previous.updatedAt;
  } else showMessage("Gasto guardado en este dispositivo.", "success");
  render();
}

function togglePaid(person) {
  if (controlsLocked || !PAYERS.includes(person)) return;
  const payment = paymentState(person);
  const previous = { paid: payment.paid, updatedAt: payment.updatedAt };
  payment.paid = !payment.paid;
  touch(payment);
  if (!persistState()) {
    payment.paid = previous.paid;
    payment.updatedAt = previous.updatedAt;
  } else showMessage(`${person[0].toUpperCase() + person.slice(1)} quedó ${payment.paid ? "pagado" : "pendiente"}.`, "success");
  renderPayments();
}

function addImage(type, id) {
  if (controlsLocked) return;
  const images = type === "ticket" ? drawState(id).tickets : paymentState(id).receipts;
  if (images.length >= MAX_IMAGES_PER_ENTRY) {
    showMessage(`Se admiten hasta ${MAX_IMAGES_PER_ENTRY} imágenes por sección.`, "error");
    return;
  }
  imageTarget = { type, id, month: activeMonth };
  document.getElementById("image-file").click();
}

function decodeImage(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file, { imageOrientation: "from-image" });
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("El archivo no es una imagen compatible")); };
    image.src = url;
  });
}

async function compressImage(file) {
  const image = await decodeImage(file);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  const scale = Math.min(1, 1200 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("El navegador no pudo procesar la imagen");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (typeof image.close === "function") image.close();
  return canvas.toDataURL("image/jpeg", 0.76);
}

async function handleImageFile(file, target) {
  if (!file || !target) return;
  if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) {
    showMessage("Elegí una imagen válida de hasta 12 MB.", "error");
    return;
  }
  try {
    showMessage("Procesando la imagen…");
    const source = await compressImage(file);
    const record = target.type === "ticket"
      ? drawState(target.id)
      : paymentState(target.id, target.month);
    const images = target.type === "ticket" ? record.tickets : record.receipts;
    images.push(source);
    touch(record);
    if (!persistState()) images.pop();
    else showMessage(currentUser ? "Imagen guardada localmente; sincronizando…" : "Imagen guardada en este dispositivo.", "success");
    render();
  } catch (error) {
    console.error("No se pudo procesar la imagen:", error);
    showMessage(error.message || "No se pudo procesar la imagen.", "error");
  }
}

function queueImageDeletion(image) {
  if (typeof image === "object" && image.path && !pendingImageDeletes.includes(image.path)) {
    pendingImageDeletes.push(image.path);
  }
}

function removeTicket(contest, index) {
  if (controlsLocked || !window.confirm("¿Eliminar este ticket adjunto?")) return;
  const record = drawState(contest);
  const [removed] = record.tickets.splice(index, 1);
  if (!removed) return;
  const previousUpdatedAt = record.updatedAt;
  touch(record);
  queueImageDeletion(removed);
  if (!persistState()) {
    record.tickets.splice(index, 0, removed);
    record.updatedAt = previousUpdatedAt;
    if (typeof removed === "object") pendingImageDeletes = pendingImageDeletes.filter(path => path !== removed.path);
  }
  renderDraw();
}

function removeReceipt(person, index) {
  if (controlsLocked || !PAYERS.includes(person) || !window.confirm("¿Eliminar este comprobante adjunto?")) return;
  const record = paymentState(person);
  const [removed] = record.receipts.splice(index, 1);
  if (!removed) return;
  const previousUpdatedAt = record.updatedAt;
  touch(record);
  queueImageDeletion(removed);
  if (!persistState()) {
    record.receipts.splice(index, 0, removed);
    record.updatedAt = previousUpdatedAt;
    if (typeof removed === "object") pendingImageDeletes = pendingImageDeletes.filter(path => path !== removed.path);
  }
  renderPayments();
}

function scheduleSync(delay = SYNC_DELAY_MS) {
  if (!currentUser || !onlineStore.available) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => syncNow(), delay);
  updateAccountUI();
}

async function uploadLocalImages(snapshot, userId) {
  const localImages = collectLocalImages(snapshot);
  if (localImages.length === 0) return { state: snapshot, replacements: new Map() };
  const replacements = new Map();
  const uploadedPaths = [];
  try {
    for (const descriptor of localImages) {
      if (replacements.has(descriptor.image)) continue;
      const reference = await onlineStore.uploadImage(
        userId,
        dataUrlToBlob(descriptor.image),
        descriptor,
      );
      replacements.set(descriptor.image, reference);
      uploadedPaths.push(reference.path);
      imageUrlCache.set(reference.path, { url: descriptor.image });
    }
    return { state: replaceImageReferences(snapshot, replacements), replacements };
  } catch (error) {
    try { await onlineStore.removeImages(uploadedPaths); } catch (cleanupError) {
      console.warn("No se pudieron limpiar adjuntos incompletos:", cleanupError);
    }
    throw error;
  }
}

async function syncNow(options = {}) {
  window.clearTimeout(syncTimer);
  if (!currentUser || !onlineStore.available) return;
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }
  if (!dirty && pendingImageDeletes.length === 0) {
    updateAccountUI();
    return;
  }
  if (!navigator.onLine) {
    lastSyncError = "Sin conexión. Los cambios quedan seguros en este dispositivo.";
    updateAccountUI();
    return;
  }

  const userId = currentUser.id;
  const sequence = stateSequence;
  const snapshot = normalizeState(state);
  lastSyncError = "";
  updateAccountUI("saving");

  syncPromise = (async () => {
    try {
      const uploaded = await uploadLocalImages(snapshot, userId);
      const saved = await onlineStore.saveState(userId, uploaded.state, serverRevision);
      if (currentUser?.id !== userId) return;
      serverRevision = saved.revision;
      state = sequence === stateSequence
        ? uploaded.state
        : replaceImageReferences(state, uploaded.replacements);
      dirty = sequence !== stateSequence;

      const deletions = [...pendingImageDeletes];
      if (deletions.length > 0) {
        try {
          await onlineStore.removeImages(deletions);
          pendingImageDeletes = pendingImageDeletes.filter(path => !deletions.includes(path));
          deletions.forEach(path => imageUrlCache.delete(path));
        } catch (error) {
          console.warn("El estado se guardó, pero quedó pendiente limpiar adjuntos:", error);
        }
      }
      writeCache();
      render();
      if (options.announce) showMessage("Todo quedó sincronizado online.", "success");
    } catch (error) {
      if (error.code === "STATE_CONFLICT") {
        try {
          const remote = await onlineStore.loadState(userId);
          if (!remote) throw new Error("No se encontró el estado remoto esperado");
          state = mergeStates(remote.state, state);
          serverRevision = remote.revision;
          dirty = true;
          stateSequence += 1;
          writeCache();
          syncAgain = true;
          showMessage("Había cambios de otro dispositivo; se combinaron sin descartar los más recientes.", "success");
        } catch (refreshError) {
          console.error("No se pudo resolver el conflicto de sincronización:", refreshError);
          lastSyncError = "No se pudo combinar un cambio remoto. Tu copia local se conservó.";
          try { writeCache(); } catch (_cacheError) { /* El estado ya estaba guardado localmente. */ }
          if (options.announce) showMessage(lastSyncError, "error");
        }
      } else {
        console.error("No se pudo sincronizar:", error);
        lastSyncError = "No se pudo sincronizar. Los cambios siguen guardados localmente.";
        try { writeCache(); } catch (_cacheError) { /* El error local ya fue informado antes. */ }
        if (options.announce) showMessage(lastSyncError, "error");
      }
    } finally {
      syncPromise = null;
      updateAccountUI();
      if (syncAgain) {
        syncAgain = false;
        scheduleSync(50);
      }
    }
  })();
  return syncPromise;
}

async function activatePublicView(options = {}) {
  if (currentUser || !onlineStore.available) return;
  if (publicRefreshPromise) return publicRefreshPromise;

  publicView = true;
  controlsLocked = true;
  lastSyncError = "";
  updateAccountUI("loading-public");
  render();

  publicRefreshPromise = (async () => {
    try {
      const remote = await onlineStore.loadPublicState();
      if (currentUser) return;
      if (!remote) throw new Error("Todavía no hay una rendición pública");
      state = normalizeState(remote.state);
      serverRevision = remote.revision;
      dirty = false;
      pendingImageDeletes = [];
      imageUrlCache.clear();
      stateSequence += 1;
      render();
      if (options.announce) showMessage("La rendición está actualizada.", "success");
    } catch (error) {
      console.error("No se pudo cargar la rendición pública:", error);
      if (currentUser) return;
      publicView = false;
      state = loadGuestCache();
      serverRevision = null;
      lastSyncError = "La vista pública todavía no está disponible.";
      render();
      if (options.announce) showMessage(lastSyncError, "error");
    } finally {
      publicRefreshPromise = null;
      if (!currentUser) {
        controlsLocked = publicView;
        updateAccountUI();
      }
    }
  })();
  return publicRefreshPromise;
}

async function activateUser(user) {
  if (!user?.id || currentUser?.id === user.id) return;
  const guestSnapshot = normalizeState(state);
  currentUser = user;
  publicView = false;
  publicRefreshPromise = null;
  imageUrlCache.clear();
  controlsLocked = true;
  lastSyncError = "";
  updateAccountUI("loading");
  render();

  const local = readCache(cacheKey(user.id));
  try {
    const remote = await onlineStore.loadState(user.id);
    if (remote) {
      state = local?.dirty ? mergeStates(remote.state, local.state) : normalizeState(remote.state);
      serverRevision = remote.revision;
      dirty = local?.dirty === true;
      pendingImageDeletes = local?.pendingImageDeletes || [];
    } else {
      state = local?.state || (hasMeaningfulState(guestSnapshot) ? guestSnapshot : emptyState());
      serverRevision = null;
      dirty = true;
      pendingImageDeletes = local?.pendingImageDeletes || [];
    }
    writeCache();
    if (dirty || pendingImageDeletes.length > 0) scheduleSync(50);
  } catch (error) {
    console.error("No se pudo recuperar el estado online:", error);
    state = local?.state || guestSnapshot;
    serverRevision = local?.revision ?? null;
    dirty = local?.dirty ?? true;
    pendingImageDeletes = local?.pendingImageDeletes || [];
    lastSyncError = "No se pudo consultar la nube. Se muestra la copia de este dispositivo.";
  } finally {
    controlsLocked = false;
    stateSequence += 1;
    render();
    updateAccountUI();
    if (stateLoadWarning) showMessage(stateLoadWarning, "error");
  }
}

function deactivateUser() {
  currentUser = null;
  publicView = false;
  serverRevision = null;
  dirty = false;
  pendingImageDeletes = [];
  imageUrlCache.clear();
  state = loadGuestCache();
  stateSequence += 1;
  controlsLocked = true;
  render();
  updateAccountUI();
  void activatePublicView();
}

function configurationMessage(reason) {
  const messages = {
    missing: "La sincronización online está lista para configurar. Mientras tanto, todo se guarda en este dispositivo.",
    incomplete: "La configuración de Supabase está incompleta; se usa almacenamiento local.",
    "invalid-url": "La URL de Supabase no es válida; se usa almacenamiento local.",
    "invalid-key": "La clave pública de Supabase no es válida; se usa almacenamiento local.",
    "secret-key": "Configuración bloqueada: nunca uses una clave secreta en el navegador.",
    "sdk-unavailable": "No se pudo cargar el acceso online; se usa almacenamiento local.",
  };
  return messages[reason] || "La sincronización online no está disponible.";
}

function updateAccountUI(forcedStatus = "") {
  const loginForm = document.getElementById("login-form");
  const publicActions = document.getElementById("public-actions");
  const sessionActions = document.getElementById("session-actions");
  const setupHint = document.getElementById("setup-hint");
  const status = document.getElementById("sync-status");
  const detail = document.getElementById("sync-detail");
  const email = document.getElementById("user-email");
  const importBackup = document.getElementById("import-backup");

  document.body.classList.toggle("read-only", publicView);
  loginForm.hidden = !onlineStore.available || Boolean(currentUser);
  publicActions.hidden = !onlineStore.available || Boolean(currentUser) || !publicView;
  sessionActions.hidden = !onlineStore.available || !currentUser;
  setupHint.hidden = onlineStore.available;
  importBackup.disabled = controlsLocked;

  if (!onlineStore.available) {
    status.textContent = "Modo local";
    status.dataset.state = onlineStore.reason === "secret-key" ? "error" : "local";
    detail.textContent = configurationMessage(onlineStore.reason);
    setupHint.textContent = "La conexión se activa completando app-config.js.";
    document.getElementById("storage-description").textContent = "Los cambios quedan guardados en este navegador. Exportá un respaldo para mayor seguridad.";
    return;
  }

  if (publicView) {
    status.textContent = forcedStatus === "loading-public" ? "Actualizando…" : "Solo lectura";
    status.dataset.state = forcedStatus === "loading-public" ? "saving" : "saved";
    detail.textContent = forcedStatus === "loading-public"
      ? "Cargando la última rendición…"
      : "Estás viendo la rendición compartida, sin necesidad de ingresar.";
    document.getElementById("storage-description").textContent = "Esta vista se actualiza online y no permite hacer cambios.";
    return;
  }

  if (!currentUser) {
    status.textContent = "Sin conexión pública";
    status.dataset.state = "local";
    detail.textContent = lastSyncError || "Ingresá con el email del editor para administrar la rendición.";
    document.getElementById("storage-description").textContent = "La vista compartida todavía no está disponible.";
    return;
  }

  email.textContent = currentUser.email || "Cuenta activa";
  document.getElementById("storage-description").textContent = "Como editor, cada cambio se guarda localmente y se sincroniza online.";
  if (forcedStatus === "loading") {
    status.textContent = "Recuperando datos…";
    status.dataset.state = "saving";
    detail.textContent = "Estamos cargando tu estado privado.";
  } else if (forcedStatus === "saving" || syncPromise) {
    status.textContent = "Sincronizando…";
    status.dataset.state = "saving";
    detail.textContent = "Podés seguir usando la página.";
  } else if (lastSyncError || !navigator.onLine) {
    status.textContent = "Pendiente de sincronizar";
    status.dataset.state = "error";
    detail.textContent = lastSyncError || "Sin conexión. Se reintentará automáticamente.";
  } else if (dirty || pendingImageDeletes.length > 0) {
    status.textContent = "Guardado localmente";
    status.dataset.state = "pending";
    detail.textContent = "Hay cambios esperando subir a tu cuenta.";
  } else {
    status.textContent = "Guardado online";
    status.dataset.state = "saved";
    detail.textContent = "Tu estado está actualizado en este dispositivo y en la nube.";
  }
}

async function initializeOnline() {
  updateAccountUI();
  if (!onlineStore.available) return;
  onlineStore.onAuthStateChange((event, session) => {
    window.setTimeout(() => {
      if (event === "SIGNED_OUT") deactivateUser();
      else if (session?.user && currentUser?.id !== session.user.id) activateUser(session.user);
    }, 0);
  });
  try {
    const session = await onlineStore.getSession();
    if (session?.user) await activateUser(session.user);
    else await activatePublicView();
  } catch (error) {
    console.error("No se pudo iniciar la sesión online:", error);
    lastSyncError = "No se pudo comprobar la sesión. La aplicación continúa en modo local.";
    updateAccountUI();
  }
}

async function handleLogin(form) {
  const emailInput = form.elements.email;
  const button = form.querySelector("button[type=submit]");
  if (!emailInput.checkValidity()) {
    emailInput.reportValidity();
    return;
  }
  button.disabled = true;
  button.textContent = "Enviando…";
  try {
    const redirect = `${window.location.origin}${window.location.pathname}`;
    await onlineStore.signInWithEmail(emailInput.value.trim(), redirect);
    form.reset();
    showMessage("Te enviamos un enlace de acceso. Revisá también la carpeta de spam.", "success");
  } catch (error) {
    console.error("No se pudo enviar el enlace de acceso:", error);
    showMessage("No se pudo enviar el enlace. Revisá el email e intentá nuevamente.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Recibir enlace";
  }
}

async function handleSignOut() {
  try {
    await syncNow();
    await onlineStore.signOut();
    deactivateUser();
    showMessage("Sesión cerrada. Ahora ves la rendición pública en modo lectura.", "success");
  } catch (error) {
    console.error("No se pudo cerrar la sesión:", error);
    showMessage("No se pudo cerrar la sesión. Intentá nuevamente.", "error");
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer un adjunto"));
    reader.readAsDataURL(blob);
  });
}

async function portableState() {
  const snapshot = normalizeState(state);
  if (!currentUser || !onlineStore.available) return snapshot;
  const replacements = new Map();
  const references = [];
  for (const draw of Object.values(snapshot.draws)) {
    for (const image of draw.tickets) if (typeof image === "object") references.push(image.path);
  }
  for (const people of Object.values(snapshot.payments)) {
    for (const payment of Object.values(people)) {
      for (const image of payment.receipts) if (typeof image === "object") references.push(image.path);
    }
  }
  for (const path of new Set(references)) {
    const blob = await onlineStore.downloadImage(path);
    replacements.set(path, await blobToDataUrl(blob));
  }
  return replaceImageReferences(snapshot, replacements);
}

async function exportState() {
  try {
    showMessage("Preparando el respaldo completo…");
    const backup = {
      version: 3,
      exportedAt: new Date().toISOString(),
      state: await portableState(),
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `marea-quini-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage("Respaldo completo exportado.", "success");
  } catch (error) {
    console.error("No se pudo exportar el respaldo:", error);
    showMessage("No se pudo descargar alguno de los adjuntos. Verificá la conexión e intentá nuevamente.", "error");
  }
}

async function importState(file) {
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) {
    showMessage("El respaldo supera el límite de 50 MB.", "error");
    return;
  }
  try {
    const imported = JSON.parse(await file.text());
    if (![2, 3].includes(imported.version)) throw new Error("La versión del respaldo no es compatible");
    const importedState = stampAllRecords(imported.state);
    const destination = currentUser ? "tu estado online" : "el estado guardado en este navegador";
    if (!window.confirm(`El respaldo reemplazará ${destination}. ¿Continuar?`)) return;

    const previous = state;
    const previousDeletes = [...pendingImageDeletes];
    for (const draw of Object.values(state.draws)) draw.tickets.forEach(queueImageDeletion);
    for (const people of Object.values(state.payments)) {
      for (const payment of Object.values(people)) payment.receipts.forEach(queueImageDeletion);
    }
    state = importedState;
    if (!persistState()) {
      state = previous;
      pendingImageDeletes = previousDeletes;
      return;
    }
    render();
    showMessage(currentUser ? "Respaldo importado; sincronizando online…" : "Respaldo importado correctamente.", "success");
  } catch (error) {
    console.error("No se pudo importar el respaldo:", error);
    showMessage(error.message || "El respaldo no es válido.", "error");
  }
}

function openImage(path, fallbackSource = "") {
  const source = (path ? imageUrlCache.get(path)?.url : "") || fallbackSource;
  const image = document.getElementById("image-preview");
  const dialog = document.getElementById("image-dialog");
  if (!source || typeof dialog.showModal !== "function") return;
  image.src = source;
  dialog.showModal();
}

function handleAction(button) {
  const { action } = button.dataset;
  const editorActions = new Set([
    "set-status", "toggle-paid", "add-ticket", "add-receipt",
    "remove-ticket", "remove-receipt", "choose-import",
  ]);
  if (controlsLocked && editorActions.has(action)) return;
  if (action === "select-month") selectMonth(button.dataset.month);
  else if (action === "select-draw") {
    activeContest = Number(button.dataset.contest);
    renderDrawTabs();
    renderDraw();
  } else if (action === "set-status") setStatus(Number(button.dataset.contest), button.dataset.status);
  else if (action === "toggle-paid") togglePaid(button.dataset.person);
  else if (action === "add-ticket") addImage("ticket", Number(button.dataset.contest));
  else if (action === "add-receipt") addImage("receipt", button.dataset.person);
  else if (action === "remove-ticket") removeTicket(Number(button.dataset.contest), Number(button.dataset.index));
  else if (action === "remove-receipt") removeReceipt(button.dataset.person, Number(button.dataset.index));
  else if (action === "choose-import") document.getElementById("import-file").click();
  else if (action === "export") exportState();
  else if (action === "sync") syncNow({ announce: true });
  else if (action === "refresh-public") activatePublicView({ announce: true });
  else if (action === "sign-out") handleSignOut();
  else if (action === "retry-data") loadData();
  else if (action === "open-image") openImage(
    button.dataset.imagePath,
    button.querySelector("img")?.currentSrc || button.querySelector("img")?.src,
  );
  else if (action === "close-image") document.getElementById("image-dialog").close();
}

function bindEvents() {
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-action]");
    if (button) handleAction(button);
  });
  document.addEventListener("change", event => {
    if (event.target.matches('[data-action="set-cost"]')) {
      setCost(Number(event.target.dataset.contest), event.target.value);
    }
  });
  document.getElementById("login-form").addEventListener("submit", event => {
    event.preventDefault();
    handleLogin(event.currentTarget);
  });
  document.getElementById("image-file").addEventListener("change", event => {
    const file = event.target.files[0];
    const target = imageTarget;
    event.target.value = "";
    imageTarget = null;
    handleImageFile(file, target);
  });
  document.getElementById("import-file").addEventListener("change", event => {
    const file = event.target.files[0];
    event.target.value = "";
    importState(file);
  });
  window.addEventListener("online", () => {
    lastSyncError = "";
    if (currentUser) scheduleSync(50);
    updateAccountUI();
  });
  window.addEventListener("offline", () => updateAccountUI());
  window.addEventListener("focus", () => {
    if (publicView && !currentUser) void activatePublicView();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && publicView && !currentUser) {
      void activatePublicView();
    }
  });
  window.addEventListener("pagehide", () => {
    try { writeCache(); } catch (_error) { /* Ya hubo guardado inmediato tras cada cambio. */ }
  });
}

async function loadData() {
  const detail = document.getElementById("draw-detail");
  detail.innerHTML = '<div class="empty"><span class="loader" aria-hidden="true"></span>Cargando resultados…</div>';
  try {
    const response = await fetch("data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`No se pudo cargar data.json (${response.status})`);
    const candidate = await response.json();
    validateAppData(candidate);
    data = candidate;
    document.getElementById("my-numbers").innerHTML = data.mis_numeros
      .map(number => `<span class="ball">${String(number).padStart(2, "0")}</span>`)
      .join("");
    const available = months();
    if (available.length === 0) throw new Error("No hay sorteos disponibles para la rendición");
    activeMonth = available.at(-1);
    activeContest = drawsForMonth().at(-1)?.concurso;
    render();

    const updatedDate = new Date(data.actualizado_en_utc);
    const updated = Number.isNaN(updatedDate.getTime())
      ? "sin fecha disponible"
      : updatedDate.toLocaleString("es-AR", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "America/Argentina/Buenos_Aires",
      });
    document.getElementById("updated-at").textContent = `Resultados actualizados: ${updated} (Argentina).`;
  } catch (error) {
    console.error("No se pudo iniciar la aplicación:", error);
    detail.innerHTML = `<div class="empty error-state"><strong>No pudimos cargar los resultados.</strong><span>${escapeHtml(error.message || "Error desconocido")}</span><button type="button" class="ghost" data-action="retry-data">Reintentar</button></div>`;
    showMessage("Revisá la conexión y volvé a intentar.", "error");
  }
}

async function init() {
  bindEvents();
  updateAccountUI();
  await Promise.all([loadData(), initializeOnline()]);
  if (stateLoadWarning && !currentUser) showMessage(stateLoadWarning, "error");
}

init();
