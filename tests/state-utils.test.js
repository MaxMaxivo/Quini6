"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stateUtils = require("../state-utils.js");

const EMPTY = { draws: {}, payments: {} };
const DATA_URL = "data:image/jpeg;base64,YQ==";
const PATH = "123e4567-e89b-12d3-a456-426614174000/tickets/3400/photo.jpg";

test("normaliza el formato local anterior sin perder datos", () => {
  const normalized = stateUtils.normalizeState({
    draws: { 3400: { status: "played", cost: 12000, tickets: [DATA_URL] } },
    payments: { "2026-07": { ale: { paid: true, receipts: [] } } },
  });
  assert.equal(normalized.draws["3400"].status, "played");
  assert.equal(normalized.draws["3400"].cost, 12000);
  assert.equal(normalized.payments["2026-07"].ale.paid, true);
});

test("rechaza meses, estados y referencias de imagen inválidos", () => {
  assert.throws(
    () => stateUtils.normalizeState({ draws: {}, payments: { "2026-13": {} } }),
    /mes de pagos inválido/,
  );
  assert.throws(
    () => stateUtils.normalizeState({
      draws: { 3400: { status: "inventado", tickets: [] } },
      payments: {},
    }),
    /estado inválido/,
  );
  assert.throws(
    () => stateUtils.normalizeState({
      draws: { 3400: { tickets: [{ path: "javascript:alert(1)" }] } },
      payments: {},
    }),
    /referencia de imagen inválida/,
  );
});

test("combina registros por fecha sin pisar cambios independientes", () => {
  const remote = {
    draws: {
      3400: { status: "played", tickets: [], updatedAt: "2026-09-04T10:00:00Z" },
    },
    payments: {
      "2026-09": {
        ale: { paid: true, receipts: [], updatedAt: "2026-09-04T12:00:00Z" },
      },
    },
  };
  const local = {
    draws: {
      3400: { status: "skipped", tickets: [], updatedAt: "2026-09-04T11:00:00Z" },
    },
    payments: {
      "2026-09": {
        ale: { paid: false, receipts: [], updatedAt: "2026-09-04T09:00:00Z" },
        zamba: { paid: true, receipts: [], updatedAt: "2026-09-04T13:00:00Z" },
      },
    },
  };
  const merged = stateUtils.mergeStates(remote, local);
  assert.equal(merged.draws["3400"].status, "skipped");
  assert.equal(merged.payments["2026-09"].ale.paid, true);
  assert.equal(merged.payments["2026-09"].zamba.paid, true);
});

test("distingue estado vacío y reemplaza adjuntos locales o remotos", () => {
  assert.equal(stateUtils.hasMeaningfulState(EMPTY), false);
  assert.equal(stateUtils.hasMeaningfulState({
    draws: { 3400: { status: "pending", tickets: [] } },
    payments: {},
  }), false);
  const state = {
    draws: { 3400: { status: "played", tickets: [DATA_URL, { path: PATH }] } },
    payments: {},
  };
  assert.equal(stateUtils.hasMeaningfulState(state), true);
  const replacement = { path: PATH, uploadedAt: "2026-09-04T14:00:00Z" };
  const replaced = stateUtils.replaceImageReferences(
    state,
    new Map([[DATA_URL, replacement], [PATH, DATA_URL]]),
  );
  assert.deepEqual(replaced.draws["3400"].tickets, [replacement, DATA_URL]);
});
