/* api.js — thin fetch wrapper for the backend REST API. */

const API = {
  async request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  },

  get(url) { return this.request("GET", url); },
  post(url, body) { return this.request("POST", url, body); },
  put(url, body) { return this.request("PUT", url, body); },
  patch(url, body) { return this.request("PATCH", url, body); },
  del(url) { return this.request("DELETE", url); },

  async upload(file, onProgress) {
    return this.uploadTo("/api/library/upload", file, onProgress);
  },

  async uploadTo(url, file, onProgress) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || ("HTTP " + xhr.status)));
        } catch (_) { reject(new Error(xhr.responseText || "upload failed")); }
      };
      xhr.onerror = () => reject(new Error("upload failed"));
      xhr.send(fd);
    });
  },

  fileUrl(id) { return `/api/audio/${id}`; },
  downloadUrl(id) { return `/api/download/${id}`; },
};
