"use strict";

const STORE_KEY = "marea-quini-state-v2";
const RENDITION_START = "2026-04-01";
const VALID_STATUSES = new Set(["played", "skipped", "pending"]);
const IMAGE_DATA_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

let data;
let stateLoadWarning = "";
let state = loadState();
let activeMonth;
let activeContest;
let imageTarget;

function emptyState() {
  return { draws: {}, payments: {} };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeImages(images, field) {
  if (images === undefined) return [];
  if (!Array.isArray(images) || images.some(value => (
    typeof value !== "string" || !IMAGE_DATA_PATTERN.test(value)
  ))) {
    throw new Error(`${field} contiene una imagen inválida`);
  }
  return [...images];
}

function normalizeState(candidate) {
  if (!isRecord(candidate) || !isRecord(candidate.draws) || !isRecord(candidate.payments)) {
    throw new Error("El estado no tiene la estructura esperada");
  }

  const normalized = { ...candidate, draws: {}, payments: {} };

  for (const [contest, draw] of Object.entries(candidate.draws)) {
    if (!/^\d+$/.test(contest) || !isRecord(draw)) {
      throw new Error("El estado contiene un sorteo inválido");
    }
    const status = draw.status ?? "pending";
    if (!VALID_STATUSES.has(status)) {
      throw new Error(`El concurso ${contest} tiene un estado inválido`);
    }
    if (
      draw.cost !== undefined
      && (!Number.isFinite(draw.cost) || draw.cost < 0)
    ) {
      throw new Error(`El concurso ${contest} tiene un gasto inválido`);
    }
    normalized.draws[contest] = {
      ...draw,
      status,
      tickets: normalizeImages(draw.tickets, `El concurso ${contest}`),
    };
  }

  for (const [month, people] of Object.entries(candidate.payments)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !isRecord(people)) {
      throw new Error("El estado contiene un mes de pagos inválido");
    }
    normalized.payments[month] = {};
    for (const [person, payment] of Object.entries(people)) {
      if (!isRecord(payment)) {
        throw new Error(`El pago de ${person} es inválido`);
      }
      if (payment.paid !== undefined && typeof payment.paid !== "boolean") {
        throw new Error(`El pago de ${person} tiene un estado inválido`);
      }
      normalized.payments[month][person] = {
        ...payment,
        paid: payment.paid ?? false,
        receipts: normalizeImages(payment.receipts, `El pago de ${person}`),
      };
    }
  }

  return normalized;
}

function loadState() {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    return stored ? normalizeState(JSON.parse(stored)) : emptyState();
  } catch (error) {
    console.warn("No se pudo cargar el estado local:", error);
    stateLoadWarning = "El estado guardado en este navegador no pudo leerse. No fue eliminado.";
    return emptyState();
  }
}

function showMessage(message, type = "") {
  const element = document.getElementById("app-message");
  element.textContent = message;
  element.className = `feedback ${type}`.trim();
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error("No se pudo guardar el estado:", error);
    showMessage(
      "No se pudo guardar el cambio. El almacenamiento del navegador puede estar lleno; exportá un respaldo antes de continuar.",
      "error",
    );
    return false;
  }
}

function drawState(contest) {
  const key = String(contest);
  if (!state.draws[key]) state.draws[key] = { status: "pending", tickets: [] };
  return state.draws[key];
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
  const periods = data.precios_por_periodo || [];
  const period = periods
    .filter(item => item.desde <= draw.fecha)
    .sort((first, second) => second.desde.localeCompare(first.desde))[0];
  const ticketPrice = period?.precio_boleta ?? data.precio_boleta;
  return ticketPrice * data.boletas_por_sorteo;
}

function validNumbers(values) {
  return (
    Array.isArray(values)
    && values.length === 6
    && new Set(values).size === 6
    && values.every(value => Number.isInteger(value) && value >= 0 && value <= 45)
  );
}

function validateAppData(candidate) {
  if (
    !isRecord(candidate)
    || !validNumbers(candidate.mis_numeros)
    || !Number.isFinite(candidate.precio_boleta)
    || candidate.precio_boleta <= 0
    || !Number.isInteger(candidate.boletas_por_sorteo)
    || candidate.boletas_por_sorteo <= 0
    || !Number.isInteger(candidate.integrantes)
    || candidate.integrantes <= 0
    || !Array.isArray(candidate.sorteos)
    || candidate.sorteos.length === 0
  ) {
    throw new Error("data.json no tiene una configuración válida");
  }

  const contests = new Set();
  for (const draw of candidate.sorteos) {
    if (
      !isRecord(draw)
      || !Number.isInteger(draw.concurso)
      || contests.has(draw.concurso)
      || !/^\d{4}-\d{2}-\d{2}$/.test(draw.fecha)
      || typeof draw.url !== "string"
      || !draw.url.startsWith("https://")
      || !["tradicional", "segunda", "revancha", "siempre_sale"]
        .every(section => validNumbers(draw[section]))
    ) {
      throw new Error("data.json contiene un sorteo inválido");
    }
    contests.add(draw.concurso);
  }

  if (
    candidate.precios_por_periodo !== undefined
    && (
      !Array.isArray(candidate.precios_por_periodo)
      || candidate.precios_por_periodo.some(period => (
        !isRecord(period)
        || !/^\d{4}-\d{2}-\d{2}$/.test(period.desde)
        || !Number.isFinite(period.precio_boleta)
        || period.precio_boleta <= 0
      ))
    )
  ) {
    throw new Error("data.json contiene un período de precios inválido");
  }
}

async function init() {
  const response = await fetch("data.json", { cache: "no-store" });
  if (!response.ok) throw new Error("No se pudo cargar data.json");
  const candidate = await response.json();
  validateAppData(candidate);
  data = candidate;

  document.getElementById("my-numbers").innerHTML = data.mis_numeros
    .map(number => `<span class="ball">${String(number).padStart(2, "0")}</span>`)
    .join("");

  const available = months();
  if (available.length === 0) {
    throw new Error("No hay sorteos disponibles para la rendición");
  }
  activeMonth = available.at(-1);
  activeContest = drawsForMonth().at(-1)?.concurso;
  render();

  const updatedDate = new Date(data.actualizado_en_utc);
  const updated = Number.isNaN(updatedDate.getTime())
    ? "sin fecha"
    : updatedDate.toLocaleString("es-AR");
  document.getElementById("updated-at").textContent = `Resultados actualizados: ${updated}.`;

  if (stateLoadWarning) showMessage(stateLoadWarning, "error");
}

function render() {
  renderMonths();
  renderDrawTabs();
  renderDraw();
  renderSummary();
  renderPayments();
}

function renderMonths() {
  document.getElementById("month-tabs").innerHTML = months().map(month => (
    `<button type="button" class="tab ${month === activeMonth ? "active" : ""}" `
    + `aria-pressed="${month === activeMonth}" onclick="selectMonth('${month}')">`
    + `${monthLabel(month)}</button>`
  )).join("");
}

function selectMonth(month) {
  activeMonth = month;
  activeContest = drawsForMonth().at(-1)?.concurso;
  render();
}

function renderDrawTabs() {
  document.getElementById("draw-tabs").innerHTML = drawsForMonth().map(draw => {
    const current = drawState(draw.concurso);
    const icon = current.status === "played" ? "✓" : current.status === "skipped" ? "×" : "·";
    const drawDate = new Date(`${draw.fecha}T12:00:00`).toLocaleDateString("es-AR", {
      weekday: "short",
      day: "numeric",
    });
    return (
      `<button type="button" class="draw-tab ${draw.concurso === activeContest ? "active" : ""}" `
      + `aria-pressed="${draw.concurso === activeContest}" onclick="selectDraw(${draw.concurso})">`
      + `${icon} ${drawDate}</button>`
    );
  }).join("");
}

function selectDraw(contest) {
  activeContest = contest;
  renderDrawTabs();
  renderDraw();
}

function resultMode(name, values) {
  const hits = values.filter(value => data.mis_numeros.includes(value)).length;
  return `<div class="mode"><div class="mode-name">${name}</div><div class="result-row">
    ${values.map(value => (
      `<span class="result-ball ${data.mis_numeros.includes(value) ? "hit" : ""}">`
      + `${String(value).padStart(2, "0")}</span>`
    )).join("")}
    <span class="hits">${hits} acierto${hits === 1 ? "" : "s"}</span>
  </div></div>`;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderDraw() {
  const draw = data.sorteos.find(item => item.concurso === activeContest);
  const detail = document.getElementById("draw-detail");
  if (!draw) {
    detail.innerHTML = '<div class="empty">No hay un sorteo seleccionado.</div>';
    return;
  }

  const current = drawState(draw.concurso);
  const defaultCost = defaultDrawCost(draw);
  const cost = current.cost ?? defaultCost;
  const drawDate = new Date(`${draw.fecha}T12:00:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  detail.innerHTML = `
    <div class="draw-header"><div><h2>${drawDate}</h2><div class="contest">Concurso ${draw.concurso}</div></div>
    <a href="${escapeAttribute(draw.url)}" target="_blank" rel="noopener noreferrer">Ver fuente del resultado</a></div>
    ${resultMode("Tradicional", draw.tradicional)}
    ${resultMode("La Segunda", draw.segunda)}
    ${resultMode("Revancha", draw.revancha)}
    ${resultMode("Siempre Sale", draw.siempre_sale)}
    <div class="control">
      <div class="control-top">
        <div><div class="label">¿Se jugó este sorteo?</div>
          <div class="status-actions" style="margin-top:10px">
            ${statusButton(draw.concurso, "played", "Jugado")}
            ${statusButton(draw.concurso, "skipped", "No jugado")}
            ${statusButton(draw.concurso, "pending", "Pendiente")}
          </div>
        </div>
        <div class="money"><label for="cost-${draw.concurso}">Gasto total</label>
          <input id="cost-${draw.concurso}" type="number" min="0" step="100" value="${cost}" onchange="setCost(${draw.concurso},this.value)">
        </div>
      </div>
      <div class="ticket-zone">
        <button type="button" class="ghost" onclick="addImage('ticket',${draw.concurso})">Adjuntar ticket</button>
        <div class="thumbs">${(current.tickets || []).map((src, index) => (
          thumb(src, `removeTicket(${draw.concurso},${index})`, "Ticket adjunto")
        )).join("")}</div>
      </div>
    </div>`;
}

function statusButton(contest, status, label) {
  const active = drawState(contest).status === status;
  return (
    `<button type="button" class="status-btn ${status} ${active ? "active" : ""}" `
    + `aria-pressed="${active}" onclick="setStatus(${contest},'${status}')">${label}</button>`
  );
}

function setStatus(contest, status) {
  if (!VALID_STATUSES.has(status)) return;
  const current = drawState(contest);
  const previous = current.status;
  current.status = status;
  if (!saveState()) current.status = previous;
  render();
}

function setCost(contest, value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    showMessage("Ingresá un gasto válido, igual o mayor que cero.", "error");
    renderDraw();
    return;
  }

  const current = drawState(contest);
  const hadCost = Object.hasOwn(current, "cost");
  const previous = current.cost;
  current.cost = amount;
  if (!saveState()) {
    if (hadCost) current.cost = previous;
    else delete current.cost;
  } else {
    showMessage("Gasto guardado.", "success");
  }
  renderDraw();
  renderSummary();
  renderPayments();
}

function totals() {
  const draws = drawsForMonth();
  const played = draws.filter(draw => drawState(draw.concurso).status === "played");
  const skipped = draws.filter(draw => drawState(draw.concurso).status === "skipped");
  const pending = draws.length - played.length - skipped.length;
  const total = played.reduce(
    (sum, draw) => sum + (drawState(draw.concurso).cost ?? defaultDrawCost(draw)),
    0,
  );
  return {
    played: played.length,
    skipped: skipped.length,
    pending,
    total,
    share: total / data.integrantes,
  };
}

function renderSummary() {
  const total = totals();
  document.getElementById("summary").innerHTML = [
    [total.played, "Jugados"],
    [total.skipped, "No jugados"],
    [total.pending, "Pendientes"],
    [money(total.total), "Gasto total"],
    [money(total.share), "Cada uno"],
  ].map(([value, label]) => (
    `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`
  )).join("");
}

function paymentState(person, month = activeMonth) {
  state.payments[month] ||= {};
  state.payments[month][person] ||= { paid: false, receipts: [] };
  return state.payments[month][person];
}

function renderPayments() {
  document.getElementById("payment-month").textContent = monthLabel(activeMonth);
  const share = totals().share;
  document.getElementById("payments").innerHTML = ["ale", "zamba"].map(person => {
    const payment = paymentState(person);
    const name = person[0].toUpperCase() + person.slice(1);
    return `<div class="person"><h3>${name}</h3><div class="owed">Debe transferir: <strong>${money(share)}</strong></div>
      <div class="actions">
        <button type="button" class="ghost ${payment.paid ? "paid" : ""}" aria-pressed="${payment.paid}" onclick="togglePaid('${person}')">${payment.paid ? "Pago confirmado" : "Marcar como pagado"}</button>
        <button type="button" class="ghost" onclick="addImage('receipt','${person}')">Adjuntar comprobante</button>
      </div>
      <div class="thumbs">${(payment.receipts || []).map((src, index) => (
        thumb(src, `removeReceipt('${person}',${index})`, "Comprobante de pago")
      )).join("")}</div>
    </div>`;
  }).join("");
}

function togglePaid(person) {
  const payment = paymentState(person);
  const previous = payment.paid;
  payment.paid = !payment.paid;
  if (!saveState()) payment.paid = previous;
  renderPayments();
}

function thumb(src, action, alt) {
  return (
    `<div class="thumb"><img src="${escapeAttribute(src)}" alt="${alt}">`
    + `<button type="button" class="remove" onclick="${action}" aria-label="Eliminar ${alt.toLowerCase()}">×</button></div>`
  );
}

function addImage(type, id) {
  imageTarget = { type, id, month: activeMonth };
  document.getElementById("image-file").click();
}

function decodeImage(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file);

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("El archivo no es una imagen compatible"));
    };
    image.src = url;
  });
}

async function compressImage(file) {
  const image = await decodeImage(file);
  const width = image.width || image.naturalWidth;
  const height = image.height || image.naturalHeight;
  const scale = Math.min(1, 1400 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("El navegador no pudo procesar la imagen");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  if (typeof image.close === "function") image.close();
  return canvas.toDataURL("image/jpeg", 0.78);
}

document.getElementById("image-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  const target = imageTarget;
  event.target.value = "";
  imageTarget = null;
  if (!file || !target) return;

  if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) {
    showMessage("Elegí una imagen válida de hasta 20 MB.", "error");
    return;
  }

  try {
    const source = await compressImage(file);
    const images = target.type === "ticket"
      ? drawState(target.id).tickets
      : paymentState(target.id, target.month).receipts;
    images.push(source);
    if (!saveState()) images.pop();
    else showMessage("Imagen guardada.", "success");
    render();
  } catch (error) {
    console.error("No se pudo procesar la imagen:", error);
    showMessage(error.message || "No se pudo procesar la imagen.", "error");
  }
});

function removeTicket(contest, index) {
  if (!window.confirm("¿Eliminar este ticket adjunto?")) return;
  const tickets = drawState(contest).tickets;
  const [removed] = tickets.splice(index, 1);
  if (!saveState()) tickets.splice(index, 0, removed);
  renderDraw();
}

function removeReceipt(person, index) {
  if (!window.confirm("¿Eliminar este comprobante adjunto?")) return;
  const receipts = paymentState(person).receipts;
  const [removed] = receipts.splice(index, 1);
  if (!saveState()) receipts.splice(index, 0, removed);
  renderPayments();
}

function exportState() {
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    state,
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
  showMessage("Respaldo exportado.", "success");
}

document.getElementById("import-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;

  if (file.size > MAX_BACKUP_BYTES) {
    showMessage("El respaldo supera el límite de 50 MB.", "error");
    return;
  }

  try {
    const imported = JSON.parse(await file.text());
    if (imported.version !== 2) throw new Error("La versión del respaldo no es compatible");
    const importedState = normalizeState(imported.state);
    if (!window.confirm("Importar reemplazará el estado guardado en este navegador. ¿Continuar?")) {
      return;
    }

    const previous = state;
    state = importedState;
    if (!saveState()) {
      state = previous;
      return;
    }
    render();
    showMessage("Respaldo importado correctamente.", "success");
  } catch (error) {
    console.error("No se pudo importar el respaldo:", error);
    showMessage(error.message || "El respaldo no es válido.", "error");
  }
});

init().catch(error => {
  console.error("No se pudo iniciar la aplicación:", error);
  const detail = document.getElementById("draw-detail");
  detail.innerHTML = "";
  const message = document.createElement("div");
  message.className = "empty";
  message.textContent = error.message || "No se pudo iniciar la aplicación.";
  detail.appendChild(message);
  showMessage("Revisá la conexión y el archivo de datos, y volvé a intentar.", "error");
});
