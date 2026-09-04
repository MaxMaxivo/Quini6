(function exposeStateUtils(globalScope) {
  "use strict";

  const VALID_STATUSES = new Set(["played", "skipped", "pending"]);
  const IMAGE_DATA_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i;
  const STORAGE_PATH_PATTERN = /^[0-9a-f-]{36}\/[a-z0-9/_-]+\.jpe?g$/i;
  const MAX_IMAGES_PER_ENTRY = 12;
  const MAX_DATA_URL_LENGTH = 7 * 1024 * 1024;

  function emptyState() {
    return { draws: {}, payments: {} };
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function validTimestamp(value) {
    return typeof value === "string" && !Number.isNaN(Date.parse(value));
  }

  function normalizeTimestamp(value) {
    return validTimestamp(value) ? new Date(value).toISOString() : undefined;
  }

  function normalizeImage(image, field) {
    if (typeof image === "string") {
      if (!IMAGE_DATA_PATTERN.test(image) || image.length > MAX_DATA_URL_LENGTH) {
        throw new Error(`${field} contiene una imagen local inválida o demasiado grande`);
      }
      return image;
    }

    if (!isRecord(image) || typeof image.path !== "string" || !STORAGE_PATH_PATTERN.test(image.path)) {
      throw new Error(`${field} contiene una referencia de imagen inválida`);
    }

    return {
      path: image.path,
      ...(typeof image.name === "string" && image.name.length <= 160 ? { name: image.name } : {}),
      ...(validTimestamp(image.uploadedAt) ? { uploadedAt: normalizeTimestamp(image.uploadedAt) } : {}),
    };
  }

  function normalizeImages(images, field) {
    if (images === undefined) return [];
    if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_ENTRY) {
      throw new Error(`${field} tiene una cantidad de imágenes inválida`);
    }
    return images.map(image => normalizeImage(image, field));
  }

  function normalizeState(candidate) {
    if (!isRecord(candidate) || !isRecord(candidate.draws) || !isRecord(candidate.payments)) {
      throw new Error("El estado no tiene la estructura esperada");
    }

    const normalized = emptyState();
    const stateUpdatedAt = normalizeTimestamp(candidate.updatedAt);
    if (stateUpdatedAt) normalized.updatedAt = stateUpdatedAt;

    for (const [contest, draw] of Object.entries(candidate.draws)) {
      if (!/^[1-9]\d*$/.test(contest) || !isRecord(draw)) {
        throw new Error("El estado contiene un sorteo inválido");
      }
      const status = draw.status ?? "pending";
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`El concurso ${contest} tiene un estado inválido`);
      }
      if (
        draw.cost !== undefined
        && (typeof draw.cost !== "number" || !Number.isFinite(draw.cost) || draw.cost < 0)
      ) {
        throw new Error(`El concurso ${contest} tiene un gasto inválido`);
      }
      const updatedAt = normalizeTimestamp(draw.updatedAt);
      normalized.draws[contest] = {
        status,
        ...(draw.cost !== undefined ? { cost: draw.cost } : {}),
        tickets: normalizeImages(draw.tickets, `El concurso ${contest}`),
        ...(updatedAt ? { updatedAt } : {}),
      };
    }

    for (const [month, people] of Object.entries(candidate.payments)) {
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || !isRecord(people)) {
        throw new Error("El estado contiene un mes de pagos inválido");
      }
      normalized.payments[month] = {};
      for (const [person, payment] of Object.entries(people)) {
        if (!/^[a-z0-9_-]{1,40}$/i.test(person) || !isRecord(payment)) {
          throw new Error(`El pago de ${person} es inválido`);
        }
        if (payment.paid !== undefined && typeof payment.paid !== "boolean") {
          throw new Error(`El pago de ${person} tiene un estado inválido`);
        }
        const updatedAt = normalizeTimestamp(payment.updatedAt);
        normalized.payments[month][person] = {
          paid: payment.paid ?? false,
          receipts: normalizeImages(payment.receipts, `El pago de ${person}`),
          ...(updatedAt ? { updatedAt } : {}),
        };
      }
    }

    return normalized;
  }

  function recordTimestamp(record) {
    const value = record?.updatedAt;
    return validTimestamp(value) ? Date.parse(value) : 0;
  }

  function chooseRecord(remoteRecord, localRecord) {
    if (!remoteRecord) return localRecord;
    if (!localRecord) return remoteRecord;
    return recordTimestamp(localRecord) > recordTimestamp(remoteRecord)
      ? localRecord
      : remoteRecord;
  }

  function mergeStates(remoteCandidate, localCandidate) {
    const remote = normalizeState(remoteCandidate);
    const local = normalizeState(localCandidate);
    const merged = emptyState();

    for (const contest of new Set([...Object.keys(remote.draws), ...Object.keys(local.draws)])) {
      merged.draws[contest] = chooseRecord(remote.draws[contest], local.draws[contest]);
    }

    for (const month of new Set([...Object.keys(remote.payments), ...Object.keys(local.payments)])) {
      merged.payments[month] = {};
      const remotePeople = remote.payments[month] || {};
      const localPeople = local.payments[month] || {};
      for (const person of new Set([...Object.keys(remotePeople), ...Object.keys(localPeople)])) {
        merged.payments[month][person] = chooseRecord(remotePeople[person], localPeople[person]);
      }
    }

    const newest = Math.max(recordTimestamp(remote), recordTimestamp(local));
    if (newest > 0) merged.updatedAt = new Date(newest).toISOString();
    return normalizeState(merged);
  }

  function hasMeaningfulState(candidate) {
    const state = normalizeState(candidate);
    const meaningfulDraw = Object.values(state.draws).some(draw => (
      draw.status !== "pending" || draw.cost !== undefined || draw.tickets.length > 0
    ));
    const meaningfulPayment = Object.values(state.payments).some(people => (
      Object.values(people).some(payment => payment.paid || payment.receipts.length > 0)
    ));
    return meaningfulDraw || meaningfulPayment;
  }

  function replaceImageReferences(candidate, replacements) {
    const state = normalizeState(candidate);
    const replace = image => {
      const key = typeof image === "string" ? image : image.path;
      return replacements.has(key) ? replacements.get(key) : image;
    };
    for (const draw of Object.values(state.draws)) draw.tickets = draw.tickets.map(replace);
    for (const people of Object.values(state.payments)) {
      for (const payment of Object.values(people)) payment.receipts = payment.receipts.map(replace);
    }
    return state;
  }

  function collectLocalImages(candidate) {
    const state = normalizeState(candidate);
    const images = [];
    for (const [contest, draw] of Object.entries(state.draws)) {
      draw.tickets.forEach((image, index) => {
        if (typeof image === "string") images.push({ image, kind: "ticket", owner: contest, index });
      });
    }
    for (const [month, people] of Object.entries(state.payments)) {
      for (const [person, payment] of Object.entries(people)) {
        payment.receipts.forEach((image, index) => {
          if (typeof image === "string") {
            images.push({ image, kind: "receipt", owner: `${month}-${person}`, index });
          }
        });
      }
    }
    return images;
  }

  function dataUrlToBlob(dataUrl) {
    const [header, payload] = dataUrl.split(",", 2);
    const mimeType = header.match(/^data:([^;]+);base64$/i)?.[1];
    if (!mimeType || payload === undefined) throw new Error("La imagen local no es válida");
    const binary = globalScope.atob(payload.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  }

  const api = Object.freeze({
    VALID_STATUSES,
    collectLocalImages,
    dataUrlToBlob,
    emptyState,
    hasMeaningfulState,
    isRecord,
    mergeStates,
    normalizeState,
    replaceImageReferences,
  });

  globalScope.QuiniState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
