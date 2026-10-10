"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const stateUtils = require("../state-utils.js");

const USER = { id: "123e4567-e89b-12d3-a456-426614174000", email: "editor@example.com" };
const MONTH = "2026-10";
const TICKET = { path: `${USER.id}/tickets/3400/photo.jpg` };
const RECEIPT = { path: `${USER.id}/receipts/2026-10-ale/photo.jpg` };
const APP_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "../data.json"), "utf8"));
const SOURCE = fs.readFileSync(path.join(__dirname, "../marea-app.js"), "utf8")
  .replace(/\binit\(\);\s*$/, "globalThis.ready = init();");

function fixture(paid = false) {
  return {
    draws: { 3400: { status: "played", cost: 12000, tickets: [TICKET] } },
    payments: {
      [MONTH]: {
        ale: { paid, receipts: [RECEIPT], updatedAt: "2026-10-08T10:00:00Z" },
        zamba: { paid, receipts: [], updatedAt: "2026-10-08T10:00:00Z" },
      },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function openApp(options = {}) {
  const elements = new Map();
  const storage = options.storage || new Map();
  let remote = stateUtils.normalizeState(options.state || fixture());
  let revision = 1;
  let clock = Date.parse("2026-10-10T12:00:00Z");
  let writes = 0;
  const store = {
    available: options.available !== false,
    reason: "missing",
    getSession: async () => options.public ? null : { user: USER },
    onAuthStateChange: () => () => {},
    loadState: async () => ({ state: remote, revision }),
    loadPublicState: async () => ({ state: remote, revision }),
    saveState: async (_user, candidate, expectedRevision) => {
      assert.equal(expectedRevision, revision);
      writes += 1;
      remote = stateUtils.normalizeState(candidate);
      revision += 1;
      return { state: remote, revision };
    },
    createImageUrl: async imagePath => `https://example.supabase.co/${imagePath}`,
    removeImages: async () => {},
  };
  const sandbox = vm.createContext({
    window: {
      QuiniState: stateUtils,
      QuiniOnlineStore: { create: () => store },
      setTimeout: () => 1,
      clearTimeout: () => {},
      addEventListener: () => {},
    },
    document: {
      body: { classList: { toggle: () => {} } },
      addEventListener: () => {},
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, {
          innerHTML: "", textContent: "", dataset: {}, hidden: false,
          addEventListener: () => {},
          querySelector: () => null,
        });
        return elements.get(id);
      },
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    navigator: { onLine: true },
    fetch: async () => ({ ok: true, json: async () => APP_DATA }),
    console: { error: () => {}, warn: () => {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock++])); }
    },
    Blob,
    Uint8Array,
    atob,
  });
  if (options.loadError) store.loadState = async () => { throw new Error("Sin red"); };
  vm.runInContext(SOURCE, sandbox);
  await sandbox.ready;
  return {
    evaluate: code => vm.runInContext(code, sandbox),
    archived: () => vm.runInContext('isMonthArchived(state, confirmedPayments, "2026-10")', sandbox),
    snapshot: () => JSON.parse(vm.runInContext("JSON.stringify(state)", sandbox)),
    elements, storage, store, sandbox,
    writes: () => writes,
    remote: () => remote,
  };
}

test("archiva solo después de guardar ambos pagos y conserva adjuntos", async () => {
  const app = await openApp();
  assert.match(app.elements.get("month-tabs").innerHTML, /2026-04/);
  app.evaluate('togglePaid("ale")');
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), false);
  app.evaluate('togglePaid("zamba")');
  assert.equal(app.archived(), false);
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), true);
  assert.equal(app.elements.get("month-tabs").hidden, true);
  assert.match(app.elements.get("history-tabs").innerHTML, /2026-10/);
  assert.deepEqual(app.remote().draws[3400].tickets, [TICKET]);
  assert.deepEqual(app.remote().payments[MONTH].ale.receipts, [RECEIPT]);
  assert.equal(app.writes(), 2);
});

test("un guardado fallido o sin conexión conserva pagos locales sin archivar", async () => {
  const app = await openApp();
  const save = app.store.saveState;
  app.evaluate('togglePaid("ale"); togglePaid("zamba")');
  app.store.saveState = async () => { throw new Error("Guardado rechazado"); };
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), false);
  assert.equal(app.snapshot().payments[MONTH].zamba.paid, true);
  app.sandbox.navigator.onLine = false;
  app.store.saveState = save;
  await app.evaluate("syncNow()");
  assert.equal(app.writes(), 0);
  assert.equal(app.archived(), false);
  app.sandbox.navigator.onLine = true;
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), true);
});

test("reabrir y volver a marcar un pago exige otra confirmación y no borra datos", async () => {
  const app = await openApp({ state: fixture(true) });
  assert.equal(app.archived(), true);
  app.evaluate('togglePaid("ale")');
  assert.equal(app.archived(), false);
  assert.equal(app.elements.get("month-tabs").hidden, false);
  await app.evaluate("syncNow()");
  assert.equal(app.remote().payments[MONTH].ale.paid, false);
  assert.deepEqual(app.remote().draws[3400].tickets, [TICKET]);
  assert.deepEqual(app.remote().payments[MONTH].ale.receipts, [RECEIPT]);
  app.evaluate('togglePaid("ale")');
  assert.equal(app.archived(), false);
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), true);
  const restored = await openApp({ storage: app.storage, loadError: true });
  assert.equal(restored.archived(), true);
});

test("una respuesta anterior no archiva pagos modificados durante el guardado", async () => {
  const app = await openApp();
  const started = deferred();
  const response = deferred();
  let submitted;
  app.store.saveState = async (_user, candidate) => {
    submitted = stateUtils.normalizeState(candidate);
    started.resolve();
    return response.promise;
  };
  app.evaluate('togglePaid("ale"); togglePaid("zamba")');
  const syncing = app.evaluate("syncNow({ announce: true })");
  await started.promise;
  assert.equal(app.archived(), false);
  app.evaluate('togglePaid("zamba"); togglePaid("zamba")');
  response.resolve({ state: submitted, revision: 2 });
  await syncing;
  assert.equal(app.archived(), false);
  assert.equal(app.snapshot().payments[MONTH].zamba.paid, true);
  assert.match(app.elements.get("app-message").textContent, /pendientes/);
});

test("un conflicto con otro dispositivo no archiva ni pierde comprobantes", async () => {
  const app = await openApp();
  app.evaluate('togglePaid("ale"); togglePaid("zamba")');
  app.store.saveState = async () => {
    throw Object.assign(new Error("Cambió la revisión"), { code: "STATE_CONFLICT" });
  };
  const otherDevice = fixture();
  otherDevice.payments[MONTH].ale.updatedAt = "2026-10-10T13:00:00Z";
  app.store.loadState = async () => ({ state: otherDevice, revision: 2 });
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), false);
  assert.equal(app.snapshot().payments[MONTH].ale.paid, false);
  assert.deepEqual(app.snapshot().payments[MONTH].ale.receipts, [RECEIPT]);
});

test("la vista pública refleja pagos persistidos y soporta vistas vacías", async () => {
  const app = await openApp({ public: true, state: fixture(true) });
  assert.equal(app.archived(), true);
  const before = app.snapshot();
  app.evaluate('togglePaid("ale")');
  assert.deepEqual(app.snapshot(), before);
  assert.equal(app.writes(), 0);
  const pending = await openApp({ public: true });
  pending.evaluate('selectView("history")');
  assert.match(pending.elements.get("history-tabs").innerHTML, /No hay meses archivados/);
  assert.match(pending.elements.get("payments").innerHTML, /No hay un mes seleccionado/);
  pending.evaluate('selectView("pending")');
  assert.match(pending.elements.get("month-tabs").innerHTML, /2026-10/);
});

test("el modo local no confirma pagos online y un fallo al subir imágenes no archiva", async () => {
  const local = await openApp({ available: false });
  local.evaluate('togglePaid("ale"); togglePaid("zamba")');
  await local.evaluate("syncNow()");
  assert.equal(local.archived(), false);
  assert.equal(local.writes(), 0);

  const app = await openApp();
  app.evaluate('togglePaid("ale"); togglePaid("zamba"); state.draws[3400].tickets.push("data:image/jpeg;base64,YQ==");');
  app.store.uploadImage = async () => { throw new Error("No se pudo subir el ticket"); };
  await app.evaluate("syncNow()");
  assert.equal(app.archived(), false);
  assert.equal(app.writes(), 0);
  assert.equal(app.snapshot().draws[3400].tickets.length, 2);
});
