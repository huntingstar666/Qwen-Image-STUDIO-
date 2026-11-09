const JSON_HEADERS = { "Content-Type": "application/json" };

async function parse(response) {
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }
  if (!response.ok) {
    const detail = (data && (data.error || data.detail)) || text || response.statusText;
    const error = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    error.code = data && data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

export const api = {
  get(path) {
    return fetch(path).then(parse);
  },
  post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(parse);
  },
  patch(path, body) {
    return fetch(path, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) }).then(parse);
  },
  del(path) {
    return fetch(path, { method: "DELETE" }).then(parse);
  },
  upload(path, file, field = "file") {
    const form = new FormData();
    form.append(field, file, file.name);
    return fetch(path, { method: "POST", body: form }).then(parse);
  },
};

export function toast(message, kind = "") {
  const root = document.getElementById("toastRoot");
  if (!root) return;
  const node = document.createElement("div");
  node.className = `toast ${kind}`.trim();
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => node.remove(), kind === "bad" ? 6000 : 3200);
}

export function formatMs(ms) {
  const value = Math.max(0, Math.round(ms || 0));
  const total = Math.floor(value / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const centis = Math.floor((value % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}
