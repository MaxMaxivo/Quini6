(function exposeOnlineStore(globalScope) {
  "use strict";

  const TABLE = "user_states";
  const BUCKET = "user-attachments";
  const STATE_FIELDS = "state,revision,updated_at";

  class StateConflictError extends Error {
    constructor() {
      super("El estado online cambió desde otro dispositivo");
      this.name = "StateConflictError";
      this.code = "STATE_CONFLICT";
    }
  }

  function decodeJwtRole(key) {
    const payload = key.split(".")[1];
    if (!payload) return "";
    try {
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      return JSON.parse(globalScope.atob(padded)).role || "";
    } catch (_error) {
      return "";
    }
  }

  function validateConfiguration(config = {}) {
    const url = String(config.supabaseUrl || "").trim().replace(/\/$/, "");
    const key = String(config.supabasePublishableKey || "").trim();
    if (!url && !key) return { available: false, reason: "missing", url, key };
    if (!url || !key) return { available: false, reason: "incomplete", url, key };
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
      return { available: false, reason: "invalid-url", url, key };
    }
    if (key.startsWith("sb_secret_") || decodeJwtRole(key) === "service_role") {
      return { available: false, reason: "secret-key", url, key: "" };
    }
    if (!key.startsWith("sb_publishable_") && decodeJwtRole(key) !== "anon") {
      return { available: false, reason: "invalid-key", url, key: "" };
    }
    return { available: true, reason: "", url, key };
  }

  function create(config, sdk = globalScope.supabase) {
    const validation = validateConfiguration(config);
    if (!validation.available) {
      return Object.freeze({
        available: false,
        reason: validation.reason,
      });
    }
    if (!sdk || typeof sdk.createClient !== "function") {
      return Object.freeze({ available: false, reason: "sdk-unavailable" });
    }

    const client = sdk.createClient(validation.url, validation.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    async function getSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    }

    function onAuthStateChange(callback) {
      const { data } = client.auth.onAuthStateChange(callback);
      return () => data.subscription.unsubscribe();
    }

    async function signInWithEmail(email, redirectTo) {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectTo,
          shouldCreateUser: true,
        },
      });
      if (error) throw error;
    }

    async function signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    }

    async function loadPublicState() {
      const { data, error } = await client
        .from(TABLE)
        .select(STATE_FIELDS)
        .eq("is_public", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    }

    async function loadState(userId) {
      const { data, error } = await client
        .from(TABLE)
        .select(STATE_FIELDS)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    }

    async function saveState(userId, state, expectedRevision) {
      if (expectedRevision === null) {
        const { data, error } = await client
          .from(TABLE)
          .insert({ user_id: userId, state, revision: 1 })
          .select(STATE_FIELDS)
          .single();
        if (error?.code === "23505") throw new StateConflictError();
        if (error) throw error;
        return data;
      }

      const { data, error } = await client
        .from(TABLE)
        .update({ state, revision: expectedRevision + 1 })
        .eq("user_id", userId)
        .eq("revision", expectedRevision)
        .select(STATE_FIELDS)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new StateConflictError();
      return data;
    }

    async function uploadImage(userId, blob, descriptor) {
      const safeKind = descriptor.kind === "receipt" ? "receipts" : "tickets";
      const safeOwner = String(descriptor.owner).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const uniqueId = globalScope.crypto.randomUUID();
      const path = `${userId}/${safeKind}/${safeOwner}/${Date.now()}-${uniqueId}.jpg`;
      const { error } = await client.storage.from(BUCKET).upload(path, blob, {
        cacheControl: "3600",
        contentType: "image/jpeg",
        upsert: false,
      });
      if (error) throw error;
      return {
        path,
        name: descriptor.name || `${descriptor.kind}.jpg`,
        uploadedAt: new Date().toISOString(),
      };
    }

    async function createImageUrl(path) {
      const { data } = client.storage.from(BUCKET).getPublicUrl(path);
      if (!data?.publicUrl) throw new Error("No se pudo crear la URL pública del adjunto");
      return data.publicUrl;
    }

    async function downloadImage(path) {
      const { data, error } = await client.storage.from(BUCKET).download(path);
      if (error) throw error;
      return data;
    }

    async function removeImages(paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from(BUCKET).remove(paths);
      if (error) throw error;
    }

    return Object.freeze({
      available: true,
      reason: "",
      createImageUrl,
      downloadImage,
      getSession,
      loadPublicState,
      loadState,
      onAuthStateChange,
      removeImages,
      saveState,
      signInWithEmail,
      signOut,
      uploadImage,
    });
  }

  const api = Object.freeze({ StateConflictError, create, validateConfiguration });
  globalScope.QuiniOnlineStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
