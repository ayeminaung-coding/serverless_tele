"use strict";
/* telegram-serverless console — vanilla JS, no build step, no dependencies.
 *
 * Every API error envelope { error: { code, message } } is shown verbatim
 * (code + message + HTTP status), never swallowed.
 */
(function () {
  var banner = document.getElementById("banner");
  var apiBaseLabel = document.getElementById("api-base-label");

  function getApiBase() {
    if (typeof window.APP_CONFIG === "object" && window.APP_CONFIG !== null &&
        typeof window.APP_CONFIG.API_BASE === "string" && window.APP_CONFIG.API_BASE !== "") {
      return window.APP_CONFIG.API_BASE.replace(/\/+$/, "");
    }
    return null;
  }

  var API_BASE = getApiBase();
  if (API_BASE) {
    apiBaseLabel.textContent = API_BASE;
  } else {
    apiBaseLabel.textContent = "(missing config.js)";
    banner.hidden = false;
    banner.textContent = "Missing console/config.js. Copy console/config.example.js to " +
      "console/config.js and set window.APP_CONFIG = { API_BASE: \"https://<worker>\" }. " +
      "The console cannot call the API until then.";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Verbatim error text: "HTTP <status> <code>: <message>". */
  function errText(err) {
    var code = err && err.code ? err.code : "error";
    var msg = err && err.message ? err.message : "request failed";
    var status = err && err.status ? "HTTP " + err.status + " " : "";
    return status + code + ": " + msg;
  }

  function setStatus(el, msg, isError) {
    if (!el) return;
    el.textContent = msg || "";
    el.className = "status" + (isError ? " error" : "");
  }

  /**
   * JSON API helper. Throws { code, message, status, retryAfter } where
   * code/message come verbatim from the { error: { code, message } } envelope.
   */
  function api(path, opts) {
    opts = opts || {};
    if (!API_BASE) {
      return Promise.reject({ code: "missing_config", message: "config.js is missing; set API_BASE first", status: 0 });
    }
    var headers = { "Content-Type": "application/json" };
    var init = {
      method: opts.method || "GET",
      headers: headers
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetch(API_BASE + path, init).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          if (data && data.error) {
            var err = { code: data.error.code || "error", message: data.error.message || res.statusText, status: res.status };
            if (data.retry_after_seconds !== undefined) err.retryAfter = data.retry_after_seconds;
            throw err;
          }
          throw { code: "http_error", message: text || res.statusText, status: res.status };
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.code) throw err;
      throw { code: "network_error", message: String((err && err.message) || err), status: 0 };
    });
  }

  /* ---- tabs ---- */
  var tabBtns = document.querySelectorAll(".tab-btn");
  function showView(name) {
    Array.prototype.forEach.call(tabBtns, function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".view"), function (v) {
      v.classList.toggle("active", v.id === "view-" + name);
    });
    if (name === "channels") refreshChannels();
    if (name === "series") { refreshSeriesList(); refreshSeriesChannelPick(); }
    if (name === "schedule") { refreshSlots(); refreshJobs(); }
  }
  Array.prototype.forEach.call(tabBtns, function (b) {
    b.addEventListener("click", function () { showView(b.getAttribute("data-view")); });
  });

  /* ---- health ---- */
  document.getElementById("btn-health").addEventListener("click", function () {
    var el = document.getElementById("health-status");
    el.textContent = "checking…";
    api("/healthz").then(function (data) {
      el.textContent = "ok (" + (data && data.version ? data.version : "?") + ")";
    }).catch(function (err) {
      el.textContent = errText(err);
    });
  });

  /* ================= Channels ================= */
  var channelsCache = [];

  function refreshChannels() {
    var statusEl = document.getElementById("channels-status");
    var tbody = document.getElementById("channels-table-body");
    setStatus(statusEl, "loading…");
    return api("/channels").then(function (rows) {
      channelsCache = Array.isArray(rows) ? rows : [];
      setStatus(statusEl, channelsCache.length + " channel(s)");
      tbody.innerHTML = "";
      channelsCache.forEach(function (ch) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + esc(ch.label) + "<br><small class='muted'>" + esc(ch.id) + "</small></td>" +
          "<td><code>" + esc(ch.chat_id) + "</code></td>" +
          "<td>" + (ch.is_public ? "yes" : "no") + "</td>" +
          "<td><input type='checkbox' data-act='protect' " + (ch.protect_content ? "checked" : "") + " aria-label='protect_content'></td>" +
          "<td><input type='checkbox' data-act='enabled' " + (ch.enabled ? "checked" : "") + " aria-label='enabled'></td>" +
          "<td><button type='button' data-act='verify'>Verify</button> " +
          "<button type='button' data-act='delete' class='danger'>Delete</button>" +
          "<div class='verify-out muted'></div></td>";
        var out = tr.querySelector(".verify-out");
        tr.querySelector("[data-act='protect']").addEventListener("change", function (ev) {
          api("/channels/" + encodeURIComponent(ch.id), {
            method: "PATCH", body: { protect_content: ev.target.checked }
          }).then(function () { setStatus(statusEl, "updated " + ch.label); refreshChannels(); })
            .catch(function (err) { setStatus(statusEl, errText(err), true); ev.target.checked = !ev.target.checked; });
        });
        tr.querySelector("[data-act='enabled']").addEventListener("change", function (ev) {
          api("/channels/" + encodeURIComponent(ch.id), {
            method: "PATCH", body: { enabled: ev.target.checked }
          }).then(function () { setStatus(statusEl, "updated " + ch.label); refreshChannels(); })
            .catch(function (err) { setStatus(statusEl, errText(err), true); ev.target.checked = !ev.target.checked; });
        });
        tr.querySelector("[data-act='delete']").addEventListener("click", function () {
          if (!window.confirm("Delete channel " + ch.label + " (" + ch.chat_id + ")?")) return;
          api("/channels/" + encodeURIComponent(ch.id), { method: "DELETE" })
            .then(function () { setStatus(statusEl, "deleted " + ch.label); refreshChannels(); })
            .catch(function (err) { setStatus(statusEl, errText(err), true); });
        });
        tr.querySelector("[data-act='verify']").addEventListener("click", function () {
          out.textContent = "verifying…";
          api("/channels/" + encodeURIComponent(ch.id) + "/verify", { method: "POST" })
            .then(function (data) {
              var chat = (data && data.chat) || {};
              out.textContent = "ok: " + (chat.title || chat.username || JSON.stringify(chat));
            })
            .catch(function (err) {
              var extra = err.retryAfter !== undefined ? " (retry_after_seconds=" + err.retryAfter + ")" : "";
              out.textContent = errText(err) + extra;
            });
        });
        tbody.appendChild(tr);
      });
    }).catch(function (err) {
      setStatus(statusEl, errText(err), true);
    });
  }

  document.getElementById("btn-channel-create").addEventListener("click", function () {
    var statusEl = document.getElementById("channel-create-status");
    var body = {
      label: document.getElementById("ch-label").value,
      chat_id: document.getElementById("ch-chat-id").value,
      is_public: document.getElementById("ch-is-public").checked,
      protect_content: document.getElementById("ch-protect").checked,
      enabled: document.getElementById("ch-enabled").checked
    };
    api("/channels", { method: "POST", body: body }).then(function (ch) {
      setStatus(statusEl, "created " + ch.id);
      document.getElementById("ch-label").value = "";
      document.getElementById("ch-chat-id").value = "";
      refreshChannels();
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  });

  /* ================= Assets ================= */
  document.getElementById("btn-upload").addEventListener("click", function () {
    var statusEl = document.getElementById("assets-status");
    var resultEl = document.getElementById("assets-result");
    var file = document.getElementById("asset-file").files[0];
    resultEl.textContent = "";
    if (!file) { setStatus(statusEl, "pick an .mp4 file first", true); return; }
    if (!API_BASE) { setStatus(statusEl, errText({ code: "missing_config", message: "config.js is missing" }), true); return; }
    setStatus(statusEl, "requesting upload URL…");
    api("/assets/upload-url", {
      method: "POST",
      body: { filename: file.name, content_type: "video/mp4", size_bytes: file.size }
    }).then(function (intent) {
      setStatus(statusEl, "PUTting bytes to R2…");
      // Exact Content-Type is a signature requirement (T2).
      return fetch(intent.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4" },
        body: file
      }).then(function (putRes) {
        if (!putRes.ok) {
          throw { code: "r2_put_failed", message: "R2 PUT returned HTTP " + putRes.status, status: putRes.status };
        }
        return intent.storage_key;
      });
    }).then(function (storageKey) {
      setStatus(statusEl, "registering asset…");
      return api("/assets", { method: "POST", body: { storage_key: storageKey } });
    }).then(function (asset) {
      setStatus(statusEl, "done");
      resultEl.textContent = "asset id: " + asset.id + "\nstorage_key: " + asset.storage_key +
        "\nsize: " + asset.size_bytes + " bytes";
    }).catch(function (err) {
      setStatus(statusEl, errText(err), true);
      resultEl.textContent = errText(err);
    });
  });

  /* ================= Series ================= */
  var selectedSeriesId = null;

  function channelCheckbox(container, ch, checked) {
    var label = document.createElement("label");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.value = ch.id;
    box.checked = !!checked;
    label.appendChild(box);
    label.appendChild(document.createTextNode(" " + ch.label + " (" + ch.chat_id + ")"));
    container.appendChild(label);
  }

  function checkedIds(container) {
    var ids = [];
    Array.prototype.forEach.call(container.querySelectorAll("input[type='checkbox']"), function (b) {
      if (b.checked) ids.push(b.value);
    });
    return ids;
  }

  function refreshSeriesChannelPick() {
    var box = document.getElementById("series-channel-pick");
    return api("/channels").then(function (rows) {
      box.innerHTML = "";
      (rows || []).forEach(function (ch) { channelCheckbox(box, ch, false); });
      if (!rows || !rows.length) box.innerHTML = "<span class='muted'>(no channels yet)</span>";
    }).catch(function () {
      box.innerHTML = "<span class='muted'>(could not load channels)</span>";
    });
  }

  function hashtagsInputToBody(raw) {
    var t = (raw || "").trim();
    return t; // server accepts a plain string or a JSON object; pass through raw
  }

  function refreshSeriesList() {
    var statusEl = document.getElementById("series-status");
    var tbody = document.getElementById("series-table-body");
    setStatus(statusEl, "loading…");
    return api("/series").then(function (rows) {
      rows = Array.isArray(rows) ? rows : [];
      setStatus(statusEl, rows.length + " series");
      tbody.innerHTML = "";
      rows.forEach(function (s) {
        var tr = document.createElement("tr");
        var chanCount = Array.isArray(s.channel_ids) ? s.channel_ids.length : 0;
        tr.innerHTML =
          "<td><code>" + esc(s.slug) + "</code><br><small class='muted'>" + esc(s.id) + "</small></td>" +
          "<td>" + esc(s.title_local || "") + " / " + esc(s.title_en || "") + "</td>" +
          "<td>" + esc(s.total_parts == null ? "—" : s.total_parts) + "</td>" +
          "<td>" + esc(String(chanCount)) + "</td>" +
          "<td><button type='button'>Open</button></td>";
        tr.querySelector("button").addEventListener("click", function () { openSeries(s.id); });
        tbody.appendChild(tr);
      });
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  }

  document.getElementById("btn-series-create").addEventListener("click", function () {
    var statusEl = document.getElementById("series-create-status");
    var totalRaw = document.getElementById("s-total").value;
    var body = {
      slug: document.getElementById("s-slug").value,
      title_local: document.getElementById("s-title-local").value,
      title_en: document.getElementById("s-title-en").value,
      synopsis: document.getElementById("s-synopsis").value,
      language: document.getElementById("s-language").value || undefined,
      style_example: document.getElementById("s-style").value,
      caption_template: document.getElementById("s-caption-tpl").value,
      title_template: document.getElementById("s-title-tpl").value,
      next_teaser_template: document.getElementById("s-teaser-tpl").value,
      hashtags: hashtagsInputToBody(document.getElementById("s-hashtags").value),
      channel_ids: checkedIds(document.getElementById("series-channel-pick"))
    };
    if (totalRaw !== "") body.total_parts = Number(totalRaw);
    api("/series", { method: "POST", body: body }).then(function (s) {
      setStatus(statusEl, "created " + s.id);
      refreshSeriesList();
      openSeries(s.id);
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  });

  function openSeries(id) {
    selectedSeriesId = id;
    var detail = document.getElementById("series-detail");
    detail.hidden = false;
    var statusEl = document.getElementById("sd-status");
    setStatus(statusEl, "loading…");
    api("/series/" + encodeURIComponent(id)).then(function (s) {
      document.getElementById("sd-title").textContent = "Series: " + s.slug + " (" + s.id + ")";
      document.getElementById("se-slug").value = s.slug || "";
      document.getElementById("se-title-local").value = s.title_local || "";
      document.getElementById("se-title-en").value = s.title_en || "";
      document.getElementById("se-language").value = s.language || "";
      document.getElementById("se-total").value = s.total_parts == null ? "" : s.total_parts;
      document.getElementById("se-hashtags").value =
        typeof s.hashtags === "string" ? s.hashtags : JSON.stringify(s.hashtags || {});
      document.getElementById("se-synopsis").value = s.synopsis || "";
      document.getElementById("se-style").value = s.style_example || "";
      document.getElementById("se-caption-tpl").value = s.caption_template || "";
      document.getElementById("se-title-tpl").value = s.title_template || "";
      document.getElementById("se-teaser-tpl").value = s.next_teaser_template || "";
      setStatus(statusEl, "");
      return refreshSeriesChannels(id, s.channel_ids || []);
    }).then(function () {
      return refreshParts(id);
    }).catch(function (err) {
      setStatus(statusEl, errText(err), true);
    });
  }

  function refreshSeriesChannels(id, picked) {
    var box = document.getElementById("sd-channels");
    var missingEl = document.getElementById("sd-missing");
    missingEl.textContent = "";
    return api("/channels").then(function (all) {
      box.innerHTML = "";
      (all || []).forEach(function (ch) {
        channelCheckbox(box, ch, picked.indexOf(ch.id) !== -1);
      });
      return api("/series/" + encodeURIComponent(id) + "/channels");
    }).then(function (resolved) {
      var missing = (resolved && resolved.missing_ids) || [];
      if (missing.length) {
        missingEl.textContent = "Stale channel ids (deleted since pick, kept out of the fan-out): " + missing.join(", ");
      }
    }).catch(function (err) {
      missingEl.textContent = "channel pick: " + errText(err);
    });
  }

  document.getElementById("sd-save").addEventListener("click", function () {
    if (!selectedSeriesId) return;
    var statusEl = document.getElementById("sd-status");
    var totalRaw = document.getElementById("se-total").value;
    var body = {
      slug: document.getElementById("se-slug").value,
      title_local: document.getElementById("se-title-local").value,
      title_en: document.getElementById("se-title-en").value,
      synopsis: document.getElementById("se-synopsis").value,
      language: document.getElementById("se-language").value,
      style_example: document.getElementById("se-style").value,
      caption_template: document.getElementById("se-caption-tpl").value,
      title_template: document.getElementById("se-title-tpl").value,
      next_teaser_template: document.getElementById("se-teaser-tpl").value,
      hashtags: hashtagsInputToBody(document.getElementById("se-hashtags").value),
      channel_ids: checkedIds(document.getElementById("sd-channels"))
    };
    if (totalRaw !== "") body.total_parts = Number(totalRaw);
    api("/series/" + encodeURIComponent(selectedSeriesId), { method: "PATCH", body: body })
      .then(function (s) {
        setStatus(statusEl, "saved " + s.id);
        refreshSeriesList();
        refreshSeriesChannels(selectedSeriesId, s.channel_ids || []);
      })
      .catch(function (err) { setStatus(statusEl, errText(err), true); });
  });

  document.getElementById("sd-delete").addEventListener("click", function () {
    if (!selectedSeriesId) return;
    if (!window.confirm("Delete this series and detach all its parts?")) return;
    var statusEl = document.getElementById("sd-status");
    api("/series/" + encodeURIComponent(selectedSeriesId), { method: "DELETE" })
      .then(function () {
        setStatus(statusEl, "deleted");
        document.getElementById("series-detail").hidden = true;
        selectedSeriesId = null;
        refreshSeriesList();
      })
      .catch(function (err) { setStatus(statusEl, errText(err), true); });
  });

  document.getElementById("sd-close").addEventListener("click", function () {
    document.getElementById("series-detail").hidden = true;
    selectedSeriesId = null;
  });

  function refreshParts(seriesId) {
    var statusEl = document.getElementById("parts-status");
    var tbody = document.getElementById("parts-table-body");
    setStatus(statusEl, "loading parts…");
    return api("/series/" + encodeURIComponent(seriesId) + "/parts").then(function (parts) {
      parts = Array.isArray(parts) ? parts : [];
      setStatus(statusEl, parts.length + " part(s)");
      tbody.innerHTML = "";
      parts.forEach(function (p) {
        var tr = document.createElement("tr");
        var hookCell = document.createElement("td");
        var hookInput = document.createElement("input");
        hookInput.type = "text";
        hookInput.value = p.hook || "";
        hookInput.style.width = "100%";
        hookCell.appendChild(hookInput);
        tr.innerHTML = "<td>" + esc(String(p.part_index)) + "</td>" +
          "<td><code>" + esc(p.asset_id) + "</code><br><small class='muted'>" + esc(p.id) + "</small></td>";
        tr.appendChild(hookCell);
        var act = document.createElement("td");
        var btnSave = document.createElement("button");
        btnSave.type = "button";
        btnSave.textContent = "Save hook";
        var btnCap = document.createElement("button");
        btnCap.type = "button";
        btnCap.textContent = "Caption";
        var btnDetach = document.createElement("button");
        btnDetach.type = "button";
        btnDetach.textContent = "Detach";
        btnDetach.className = "danger";
        btnSave.addEventListener("click", function () {
          api("/series/" + encodeURIComponent(seriesId) + "/parts/" + encodeURIComponent(p.id), {
            method: "PATCH", body: { hook: hookInput.value }
          }).then(function () { setStatus(statusEl, "hook saved for part " + p.part_index); })
            .catch(function (err) { setStatus(statusEl, errText(err), true); });
        });
        btnCap.addEventListener("click", function () {
          var out = document.getElementById("part-cap-output");
          out.textContent = "rendering…";
          api("/series/" + encodeURIComponent(seriesId) + "/parts/" + encodeURIComponent(p.id) + "/caption")
            .then(function (cap) {
              out.textContent = "caption (" + cap.caption_length + "/1024" +
                (cap.truncated ? ", TRUNCATED" : "") + "):\n" + cap.caption +
                (cap.title ? "\n\ntitle: " + cap.title : "") +
                (cap.next_teaser ? "\nnext: " + cap.next_teaser : "");
            })
            .catch(function (err) { out.textContent = errText(err); });
        });
        btnDetach.addEventListener("click", function () {
          if (!window.confirm("Detach part " + p.part_index + "?")) return;
          api("/series/" + encodeURIComponent(seriesId) + "/parts/" + encodeURIComponent(p.id), { method: "DELETE" })
            .then(function () { refreshParts(seriesId); })
            .catch(function (err) { setStatus(statusEl, errText(err), true); });
        });
        act.appendChild(btnSave);
        act.appendChild(document.createTextNode(" "));
        act.appendChild(btnCap);
        act.appendChild(document.createTextNode(" "));
        act.appendChild(btnDetach);
        tr.appendChild(act);
        tbody.appendChild(tr);
      });
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  }

  document.getElementById("btn-part-attach").addEventListener("click", function () {
    if (!selectedSeriesId) return;
    var statusEl = document.getElementById("parts-status");
    var body = {
      asset_id: document.getElementById("pa-asset-id").value,
      part_index: Number(document.getElementById("pa-index").value),
      hook: document.getElementById("pa-hook").value,
      source_filename: document.getElementById("pa-source").value || undefined
    };
    api("/series/" + encodeURIComponent(selectedSeriesId) + "/parts", { method: "POST", body: body })
      .then(function () {
        setStatus(statusEl, "attached");
        document.getElementById("pa-asset-id").value = "";
        refreshParts(selectedSeriesId);
      })
      .catch(function (err) { setStatus(statusEl, errText(err), true); });
  });

  /* ================= Captions lab ================= */
  function renderCaptionResult(cap, outEl, meterEl) {
    var len = cap.caption_length || 0;
    meterEl.textContent = len + " / 1024";
    meterEl.classList.toggle("over", len > 1024 || cap.within_limit === false);
    var warn = "";
    if (cap.truncated) warn += "\n[TRUNCATED to fit 1024 chars]";
    if (cap.within_limit === false) warn += "\n[OVER LIMIT]";
    outEl.textContent = "caption (" + len + "/1024):\n" + cap.caption +
      (cap.title ? "\n\ntitle: " + cap.title : "") +
      (cap.next_teaser ? "\nnext: " + cap.next_teaser : "") + warn;
  }

  document.getElementById("btn-cap-preview").addEventListener("click", function () {
    var statusEl = document.getElementById("cap-status");
    var outEl = document.getElementById("cap-output");
    var meterEl = document.getElementById("cap-meter");
    var body = {
      title_local: document.getElementById("cap-title-local").value,
      title_en: document.getElementById("cap-title-en").value,
      synopsis: document.getElementById("cap-synopsis").value,
      language: document.getElementById("cap-language").value || undefined,
      style_example: document.getElementById("cap-style").value,
      caption_template: document.getElementById("cap-caption-tpl").value,
      title_template: document.getElementById("cap-title-tpl").value,
      next_teaser_template: document.getElementById("cap-teaser-tpl").value,
      hashtags: hashtagsInputToBody(document.getElementById("cap-hashtags").value),
      part_index: Number(document.getElementById("cap-part-index").value),
      total_parts: Number(document.getElementById("cap-total").value),
      hook: document.getElementById("cap-hook").value
    };
    setStatus(statusEl, "rendering…");
    api("/captions/preview", { method: "POST", body: body }).then(function (cap) {
      setStatus(statusEl, "");
      renderCaptionResult(cap, outEl, meterEl);
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  });

  /* ================= Schedule ================= */
  function refreshSlots() {
    var statusEl = document.getElementById("slots-status");
    var tbody = document.getElementById("slots-table-body");
    setStatus(statusEl, "loading…");
    return api("/slots").then(function (rows) {
      rows = Array.isArray(rows) ? rows : [];
      setStatus(statusEl, rows.length + " slot(s)");
      tbody.innerHTML = "";
      rows.forEach(function (s) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><input type='text' data-f='label' value='" + esc(s.label || "") + "'></td>" +
          "<td><input type='number' data-f='hour' min='0' max='23' value='" + esc(String(s.hour)) + "'>" +
          ":<input type='number' data-f='minute' min='0' max='59' value='" + esc(String(s.minute)) + "'></td>" +
          "<td><input type='text' data-f='timezone' value='" + esc(s.timezone || "") + "'></td>" +
          "<td><input type='checkbox' data-f='enabled' " + (s.enabled ? "checked" : "") + "></td>" +
          "<td class='muted'>" + esc(s.last_fired_on || "—") + "</td>" +
          "<td><button type='button'>Save</button></td>";
        tr.querySelector("button").addEventListener("click", function () {
          var body = {
            label: tr.querySelector("[data-f='label']").value,
            hour: Number(tr.querySelector("[data-f='hour']").value),
            minute: Number(tr.querySelector("[data-f='minute']").value),
            timezone: tr.querySelector("[data-f='timezone']").value,
            enabled: tr.querySelector("[data-f='enabled']").checked
          };
          api("/slots/" + encodeURIComponent(s.id), { method: "PATCH", body: body })
            .then(function () { setStatus(statusEl, "slot saved"); refreshSlots(); })
            .catch(function (err) { setStatus(statusEl, errText(err), true); });
        });
        tbody.appendChild(tr);
      });
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  }

  function jobsQuery() {
    var q = [];
    var st = document.getElementById("jobs-state").value;
    var series = document.getElementById("jobs-series").value.trim();
    var channel = document.getElementById("jobs-channel").value.trim();
    var limit = document.getElementById("jobs-limit").value;
    if (st) q.push("state=" + encodeURIComponent(st));
    if (series) q.push("series_id=" + encodeURIComponent(series));
    if (channel) q.push("channel_id=" + encodeURIComponent(channel));
    if (limit) q.push("limit=" + encodeURIComponent(limit));
    return q.length ? "?" + q.join("&") : "";
  }

  function refreshJobs() {
    var statusEl = document.getElementById("jobs-status");
    var tbody = document.getElementById("jobs-table-body");
    setStatus(statusEl, "loading…");
    return api("/jobs" + jobsQuery()).then(function (rows) {
      rows = Array.isArray(rows) ? rows : [];
      setStatus(statusEl, rows.length + " job(s)");
      tbody.innerHTML = "";
      rows.forEach(function (j) {
        var seriesSlug = (j.series && (j.series.slug || j.series.id)) || j.series_id || "—";
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><small><code>" + esc(String(j.id).slice(0, 8)) + "</code></small></td>" +
          "<td>" + esc(seriesSlug) + " #" + esc(String(j.part_index == null ? "?" : j.part_index)) + "</td>" +
          "<td><small><code>" + esc(String(j.channel_id || "—").slice(0, 8)) + "</code></small></td>" +
          "<td>" + esc(j.state) + "</td>" +
          "<td>" + esc(String(j.attempts == null ? 0 : j.attempts)) + "</td>" +
          "<td><small>" + esc(j.last_error || "—") + "</small></td>";
        var act = document.createElement("td");
        if (j.state === "failed") {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "Retry";
          btn.addEventListener("click", function () {
            api("/jobs/" + encodeURIComponent(j.id) + "/retry", { method: "POST" })
              .then(function () { setStatus(statusEl, "retry dispatched for " + j.id); refreshJobs(); })
              .catch(function (err) { setStatus(statusEl, errText(err), true); });
          });
          act.appendChild(btn);
        } else {
          act.textContent = "—";
        }
        tr.appendChild(act);
        tbody.appendChild(tr);
      });
    }).catch(function (err) { setStatus(statusEl, errText(err), true); });
  }

  document.getElementById("btn-jobs-refresh").addEventListener("click", refreshJobs);

  document.getElementById("btn-tick").addEventListener("click", function () {
    var statusEl = document.getElementById("tick-status");
    var summaryEl = document.getElementById("tick-summary");
    var lastEl = document.getElementById("last-tick");
    setStatus(statusEl, "ticking…");
    api("/tick", { method: "POST" }).then(function (t) {
      setStatus(statusEl, "tick done");
      var text = "fired_slots: " + JSON.stringify(t.fired_slots) +
        "\njobs_created: " + t.jobs_created +
        "\npublished: " + t.published +
        "\nfailed: " + t.failed +
        "\ndeferred: " + t.deferred +
        "\nerrors: " + JSON.stringify(t.errors, null, 2);
      summaryEl.textContent = text;
      lastEl.textContent = new Date().toISOString() + "\n" + text;
      refreshSlots();
      refreshJobs();
    }).catch(function (err) {
      setStatus(statusEl, errText(err), true);
      summaryEl.textContent = errText(err);
    });
  });

  /* initial lightweight load */
  refreshChannels();
})();
