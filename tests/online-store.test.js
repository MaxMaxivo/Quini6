"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfiguration } = require("../online-store.js");

function jwt(role) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ role })}.signature`;
}

test("deja el modo online desactivado cuando falta configuración", () => {
  assert.equal(validateConfiguration({}).reason, "missing");
  assert.equal(validateConfiguration({ supabaseUrl: "https://demo.supabase.co" }).reason, "incomplete");
});

test("acepta solamente URL HTTPS de Supabase y clave pública", () => {
  const valid = validateConfiguration({
    supabaseUrl: "https://mi-proyecto.supabase.co/",
    supabasePublishableKey: "sb_publishable_example",
  });
  assert.equal(valid.available, true);
  assert.equal(valid.url, "https://mi-proyecto.supabase.co");
  assert.equal(validateConfiguration({
    supabaseUrl: "https://ejemplo.invalid",
    supabasePublishableKey: "sb_publishable_example",
  }).reason, "invalid-url");
  assert.equal(validateConfiguration({
    supabaseUrl: "https://mi-proyecto.supabase.co",
    supabasePublishableKey: jwt("anon"),
  }).available, true);
});

test("bloquea claves secretas o service_role en el navegador", () => {
  assert.equal(validateConfiguration({
    supabaseUrl: "https://mi-proyecto.supabase.co",
    supabasePublishableKey: "sb_secret_danger",
  }).reason, "secret-key");
  assert.equal(validateConfiguration({
    supabaseUrl: "https://mi-proyecto.supabase.co",
    supabasePublishableKey: jwt("service_role"),
  }).reason, "secret-key");
});
