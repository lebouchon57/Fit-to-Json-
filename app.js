import {
  formatDuration,
  formatFileSize,
  isValidFitBuffer,
  parseFitToJson
} from "./fit-parser.js";

const state = {
  selectedFile: null, // { name, sizeBytes, buffer }
  profile: "running_trail", // "running_trail" | "strength_cardio"
  parseResult: null, // { profile, jsonPayload, jsonContent, jsonSizeBytes, jsonSizeFormatted, ... }
  deferredInstallPrompt: null
};

const el = {
  drivePanel: document.getElementById("drive-panel"),
  fileInput: document.getElementById("fit-file-input"),
  btnPickFit: document.getElementById("btn-pick-fit"),
  profileButtons: Array.from(document.querySelectorAll(".profile-btn")),
  fitErrorBox: document.getElementById("fit-error-box"),
  fitErrorText: document.getElementById("fit-error-text"),
  fitEmptyState: document.getElementById("fit-empty-state"),
  fitSelectedState: document.getElementById("fit-selected-state"),
  selectedFileName: document.getElementById("selected-file-name"),
  selectedFileSize: document.getElementById("selected-file-size"),
  selectedProfileText: document.getElementById("selected-profile-text"),
  btnConvert: document.getElementById("btn-convert"),
  geminiIdleState: document.getElementById("gemini-idle-state"),
  geminiLoadingState: document.getElementById("gemini-loading-state"),
  geminiErrorState: document.getElementById("gemini-error-state"),
  geminiErrorText: document.getElementById("gemini-error-text"),
  geminiSuccessState: document.getElementById("gemini-success-state"),
  jsonProfileSummary: document.getElementById("json-profile-summary"),
  jsonSizeBadge: document.getElementById("json-size-badge"),
  metricsGrid: document.getElementById("metrics-grid"),
  zonesStrip: document.getElementById("zones-strip"),
  btnOpenGemini: document.getElementById("btn-open-gemini"),
  btnSaveJson: document.getElementById("btn-save-json"),
  btnCopyMarkdown: document.getElementById("btn-copy-markdown"),
  copyMdLabel: document.getElementById("copy-md-label"),
  installBanner: document.getElementById("install-banner"),
  btnInstallPwa: document.getElementById("btn-install-pwa"),
  btnDismissInstall: document.getElementById("btn-dismiss-install"),
  toast: document.getElementById("toast")
};

let toastTimer = null;
let copyConfirmTimer = null;

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove("visible");
  }, 3000);
}

function getProfileLabel(profile) {
  return profile === "strength_cardio" ? "Renforcement / Cardio" : "Course à pied / Trail";
}

function setGeminiView(mode, errorMessage = "") {
  el.geminiIdleState.classList.toggle("hidden", mode !== "idle");
  el.geminiLoadingState.classList.toggle("hidden", mode !== "loading");
  el.geminiErrorState.classList.toggle("hidden", mode !== "error");
  el.geminiSuccessState.classList.toggle("hidden", mode !== "success");
  if (mode === "error") {
    el.geminiErrorText.textContent = errorMessage;
  }
}

function showSourceError(message) {
  el.fitErrorText.textContent = message;
  el.fitErrorBox.classList.remove("hidden");
  el.fitEmptyState.classList.remove("hidden");
  el.fitSelectedState.classList.add("hidden");
  el.btnConvert.classList.remove("ready");
  state.selectedFile = null;
  state.parseResult = null;
  setGeminiView("idle");
}

function renderSummaryMetrics(result) {
  const payload = result.jsonPayload;
  const g = payload.global_stats;

  el.jsonProfileSummary.textContent = payload.profile_label;
  el.jsonSizeBadge.textContent = result.jsonSizeFormatted;

  const chips = [];

  if (payload.profile === "strength_cardio") {
    const rec = g.hr_recovery;
    const recoveryText = rec
      ? [
          rec.drop_1min_bpm !== null ? `1m: -${rec.drop_1min_bpm}` : null,
          rec.drop_2min_bpm !== null ? `2m: -${rec.drop_2min_bpm}` : null,
          rec.event_recovery_bpm !== null && rec.drop_1min_bpm === null
            ? `${rec.event_recovery_bpm} bpm`
            : null
        ]
          .filter(Boolean)
          .join(" / ") || "N/A"
      : "N/A";

    const te = g.training_effect;
    const teParts = [];
    if (te?.aerobic !== null && te?.aerobic !== undefined) teParts.push(`TE ${te.aerobic}`);
    if (te?.epoc_load !== null && te?.epoc_load !== undefined) teParts.push(`EPOC ${te.epoc_load}`);
    const teText = teParts.length > 0 ? teParts.join(" · ") : "N/A";

    chips.push(
      { label: "Durée totale", value: g.total_duration_formatted || "00:00" },
      { label: "Calories actives", value: g.active_calories_kcal !== null ? `${g.active_calories_kcal} kcal` : "N/A" },
      { label: "FC moy / max", value: g.avg_heart_rate_bpm ? `${g.avg_heart_rate_bpm} / ${g.max_heart_rate_bpm || "--"} bpm` : "N/A" },
      { label: "Récupération FC", value: recoveryText },
      { label: "Training Effect / EPOC", value: teText },
      { label: "Séries (Lap)", value: `${payload.intervals.length} série${payload.intervals.length > 1 ? "s" : ""}` }
    );
  } else {
    const powerText =
      g.avg_power_w !== null
        ? `${g.avg_power_w} W${g.normalized_power_w ? ` (nP ${g.normalized_power_w})` : ""}`
        : "N/A";

    chips.push(
      { label: "Distance / Durée", value: `${g.total_distance_km} km · ${g.total_duration_formatted}` },
      { label: "D+ / D-", value: `+${g.elevation_gain_m} m / -${g.elevation_loss_m} m` },
      { label: "FC moy / max", value: g.avg_heart_rate_bpm ? `${g.avg_heart_rate_bpm} / ${g.max_heart_rate_bpm || "--"} bpm` : "N/A" },
      { label: "Puissance moy / nP", value: powerText },
      { label: "Cadence moy.", value: g.avg_cadence_spm ? `${g.avg_cadence_spm} spm` : "N/A" },
      { label: "Splits / Trace GPS", value: `${payload.splits.length} km · ${payload.gps_track.length} pts (30s)` }
    );
  }

  el.metricsGrid.replaceChildren();
  for (const chip of chips) {
    const div = document.createElement("div");
    div.className = "metric-chip";

    const lbl = document.createElement("span");
    lbl.className = "metric-label";
    lbl.textContent = chip.label;

    const val = document.createElement("span");
    val.className = "metric-value";
    val.textContent = chip.value;

    div.append(lbl, val);
    el.metricsGrid.appendChild(div);
  }

  // Zones cardiaques Z1..Z5
  el.zonesStrip.replaceChildren();
  const zTitle = document.createElement("div");
  zTitle.className = "zones-title";
  zTitle.textContent = "Zones cardiaques (Z1 à Z5)";

  const zBars = document.createElement("div");
  zBars.className = "zones-bars";

  for (const key of ["Z1", "Z2", "Z3", "Z4", "Z5"]) {
    const z = payload.hr_zones[key] || { seconds: 0, percent: 0 };
    const cell = document.createElement("div");
    cell.className = "zone-cell";
    cell.title = `${key} : ${formatDuration(z.seconds)} (${z.percent}%)`;

    const name = document.createElement("span");
    name.className = "zone-name";
    name.textContent = key;

    const pct = document.createElement("span");
    pct.className = "zone-pct";
    pct.textContent = `${z.percent}%`;

    cell.append(name, pct);
    zBars.appendChild(cell);
  }

  el.zonesStrip.append(zTitle, zBars);
}

async function handleSelectedFile(file) {
  if (!file) return;

  try {
    const buffer = await file.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      showSourceError(`Le fichier '${file.name}' est vide (0 octet).`);
      return;
    }

    const hasFitExtension = file.name.toLowerCase().endsWith(".fit");
    const hasFitHeader = isValidFitBuffer(buffer);

    if (!hasFitExtension && !hasFitHeader) {
      showSourceError(`Format invalide : '${file.name}' n'est pas un fichier Garmin .fit.`);
      return;
    }

    const normalizedName = hasFitExtension ? file.name : `${file.name}.fit`;
    state.selectedFile = {
      name: normalizedName,
      sizeBytes: buffer.byteLength,
      buffer
    };
    state.parseResult = null;

    el.fitErrorBox.classList.add("hidden");
    el.fitEmptyState.classList.add("hidden");
    el.fitSelectedState.classList.remove("hidden");
    el.selectedFileName.textContent = normalizedName;
    el.selectedFileSize.textContent = formatFileSize(buffer.byteLength);
    el.selectedProfileText.textContent = getProfileLabel(state.profile);
    el.btnConvert.classList.add("ready");
    setGeminiView("idle");

    showToast(`Fichier .FIT prêt : ${normalizedName}`);
  } catch (err) {
    showSourceError(`Impossible de lire le fichier : ${err.message || "erreur inconnue"}`);
  }
}

function runConversion() {
  if (!state.selectedFile) {
    showToast("Veuillez d'abord sélectionner un fichier .FIT");
    return;
  }

  setGeminiView("loading");

  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const result = parseFitToJson(
          state.selectedFile.buffer,
          state.selectedFile.name,
          state.profile
        );

        if (!result.jsonContent || result.jsonSizeBytes <= 0) {
          throw new Error("Le fichier JSON généré est vide.");
        }

        state.parseResult = result;
        renderSummaryMetrics(result);
        setGeminiView("success");
        showToast(`Synthèse JSON prête (${result.jsonSizeFormatted})`);
      } catch (err) {
        state.parseResult = null;
        setGeminiView("error", err.message || "Impossible de décoder ce fichier .FIT.");
      }
    }, 25);
  });
}

function selectProfile(newProfile) {
  if (state.profile === newProfile) return;
  state.profile = newProfile;

  for (const btn of el.profileButtons) {
    const isActive = btn.dataset.profile === newProfile;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  }

  el.selectedProfileText.textContent = getProfileLabel(newProfile);

  if (state.selectedFile && state.parseResult) {
    runConversion();
  }
}

function buildJsonFilename() {
  const rawName = state.parseResult?.fileName || state.selectedFile?.name || "activity.fit";
  const baseName = rawName.replace(/\.fit$/i, "");
  return `${baseName}_${state.profile}.json`;
}

function triggerBlobDownload(jsonContent, filename) {
  const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8" });
  if (blob.size <= 0) {
    showToast("Erreur : le fichier JSON est vide.");
    return false;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

async function saveJsonFile() {
  if (!state.parseResult || !state.parseResult.jsonContent) {
    showToast("Aucun fichier JSON généré à sauvegarder.");
    return;
  }

  const filename = buildJsonFilename();
  const jsonContent = state.parseResult.jsonContent;
  const sizeFormatted = state.parseResult.jsonSizeFormatted;

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "Fichier JSON UTF-8",
            accept: { "application/json": [".json"] }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([jsonContent], { type: "application/json;charset=utf-8" }));
      await writable.close();
      showToast(`Fichier .JSON sauvegardé (${sizeFormatted}) !`);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  if (triggerBlobDownload(jsonContent, filename)) {
    showToast(`Fichier .JSON téléchargé (${sizeFormatted}) !`);
  }
}

async function shareToGemini() {
  if (!state.parseResult || !state.parseResult.jsonContent) {
    showToast("Aucun fichier JSON généré à partager.");
    return;
  }

  const filename = buildJsonFilename();
  const jsonContent = state.parseResult.jsonContent;
  const jsonFile = new File([jsonContent], filename, { type: "application/json" });
  const promptText =
    state.profile === "strength_cardio"
      ? "Voici la synthèse JSON de ma séance Renforcement / Cardio (zones FC, séries/repos, récupération et Training Effect). Peux-tu analyser la charge et la récupération ?"
      : "Voici la synthèse JSON de ma sortie Course à pied / Trail (stats globales, zones FC, splits par km et trace GPS rééchantillonnée). Peux-tu analyser mon allure, ma dérive cardiaque et ma gestion d'effort ?";

  if (typeof navigator.share === "function") {
    try {
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [jsonFile] })) {
        await navigator.share({
          title: filename,
          text: promptText,
          files: [jsonFile]
        });
        showToast("Partage avec fichier .JSON joint ouvert !");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  triggerBlobDownload(jsonContent, filename);
  showToast(`JSON téléchargé (${state.parseResult.jsonSizeFormatted}). Importez-le dans Gemini !`);
  setTimeout(() => {
    window.open("https://gemini.google.com/app", "_blank", "noopener");
  }, 450);
}

function buildMarkdownSummary(result) {
  const p = result.jsonPayload;
  const g = p.global_stats;
  const lines = [];

  lines.push(`# Synthèse Garmin — ${p.profile_label}`);
  lines.push(`- **Fichier source** : \`${p.source_file}\``);
  if (p.start_time) {
    lines.push(`- **Date** : ${p.start_time}`);
  }
  lines.push("");
  lines.push("## Statistiques globales");

  if (p.profile === "strength_cardio") {
    lines.push(`- **Durée totale** : ${g.total_duration_formatted} (${g.total_duration_s} s)`);
    lines.push(`- **Calories actives** : ${g.active_calories_kcal !== null ? `${g.active_calories_kcal} kcal` : "N/A"}`);
    lines.push(`- **FC moyenne / max** : ${g.avg_heart_rate_bpm ?? "N/A"} / ${g.max_heart_rate_bpm ?? "N/A"} bpm`);
    if (g.hr_recovery) {
      lines.push(
        `- **Récupération cardiaque** : 1 min = ${g.hr_recovery.drop_1min_bpm !== null ? `-${g.hr_recovery.drop_1min_bpm} bpm` : "N/A"} | 2 min = ${g.hr_recovery.drop_2min_bpm !== null ? `-${g.hr_recovery.drop_2min_bpm} bpm` : "N/A"}`
      );
    } else {
      lines.push(`- **Récupération cardiaque** : N/A`);
    }
    lines.push(
      `- **Training Effect / EPOC** : Aérobie ${g.training_effect?.aerobic ?? "N/A"} | Anaérobie ${g.training_effect?.anaerobic ?? "N/A"} | EPOC ${g.training_effect?.epoc_load ?? "N/A"}`
    );
  } else {
    lines.push(`- **Distance totale** : ${g.total_distance_km} km`);
    lines.push(`- **Durée totale** : ${g.total_duration_formatted} (${g.total_duration_s} s)`);
    lines.push(`- **Dénivelé** : +${g.elevation_gain_m} m / -${g.elevation_loss_m} m`);
    lines.push(`- **FC moyenne / max** : ${g.avg_heart_rate_bpm ?? "N/A"} / ${g.max_heart_rate_bpm ?? "N/A"} bpm`);
    lines.push(`- **Puissance moy / nP** : ${g.avg_power_w ?? "N/A"} W / ${g.normalized_power_w ?? "N/A"} W`);
    lines.push(`- **Cadence moyenne** : ${g.avg_cadence_spm ?? "N/A"} spm`);
  }

  lines.push("");
  lines.push("## Zones cardiaques");
  lines.push("| Zone | Temps | Part |");
  lines.push("| :--- | ---: | ---: |");
  for (const key of ["Z1", "Z2", "Z3", "Z4", "Z5"]) {
    const z = p.hr_zones[key];
    lines.push(`| ${z.label} | ${formatDuration(z.seconds)} (${z.seconds}s) | ${z.percent}% |`);
  }

  if (p.profile === "strength_cardio") {
    lines.push("");
    lines.push("## Séries / Intervalles");
    if (p.intervals.length === 0) {
      lines.push("_Aucun tour (Lap) enregistré._");
    } else {
      lines.push("| Série | Effort | Repos | FC moy | FC pic |");
      lines.push("| :---: | ---: | ---: | ---: | ---: |");
      for (const it of p.intervals) {
        lines.push(
          `| ${it.set_number} | ${it.effort_duration_s}s | ${it.rest_duration_s}s | ${it.avg_heart_rate_bpm ?? "N/A"} bpm | ${it.max_heart_rate_bpm ?? "N/A"} bpm |`
        );
      }
    }
  } else {
    lines.push("");
    lines.push("## Splits par kilomètre");
    if (p.splits.length === 0) {
      lines.push("_Aucun split kilométrique disponible._");
    } else {
      lines.push("| Km | Allure moy | FC moy | Cadence | D+ |");
      lines.push("| :---: | ---: | ---: | ---: | ---: |");
      for (const sp of p.splits) {
        lines.push(
          `| ${sp.km} | ${sp.avg_pace} | ${sp.avg_heart_rate_bpm ?? "N/A"} bpm | ${sp.avg_cadence_spm ?? "N/A"} spm | +${sp.elevation_gain_m} m |`
        );
      }
    }
    lines.push("");
    lines.push(`_Trace GPS rééchantillonnée (30s) : ${p.gps_track.length} points._`);
  }

  return lines.join("\n");
}

async function copyAsMarkdown() {
  if (!state.parseResult) {
    showToast("Aucune synthèse à copier.");
    return;
  }

  const markdown = buildMarkdownSummary(state.parseResult);

  let copied = false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(markdown);
      copied = true;
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    const textarea = document.createElement("textarea");
    textarea.value = markdown;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    document.body.removeChild(textarea);
  }

  if (copied) {
    el.btnCopyMarkdown.classList.add("copied");
    el.copyMdLabel.textContent = "Copié !";
    showToast("Synthèse Markdown copiée dans le presse-papier !");
    if (copyConfirmTimer) clearTimeout(copyConfirmTimer);
    copyConfirmTimer = setTimeout(() => {
      el.btnCopyMarkdown.classList.remove("copied");
      el.copyMdLabel.textContent = "Copier en Markdown";
    }, 2200);
  } else {
    showToast("Impossible d'accéder au presse-papier.");
  }
}

// Événements
for (const btn of el.profileButtons) {
  btn.addEventListener("click", () => {
    selectProfile(btn.dataset.profile);
  });
}

el.btnPickFit.addEventListener("click", () => {
  el.fileInput.value = "";
  el.fileInput.click();
});

el.fileInput.addEventListener("change", (event) => {
  const file = event.target.files && event.target.files[0];
  if (file) {
    handleSelectedFile(file);
  }
});

el.drivePanel.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.drivePanel.classList.add("drag-over");
});

el.drivePanel.addEventListener("dragleave", (e) => {
  if (!el.drivePanel.contains(e.relatedTarget)) {
    el.drivePanel.classList.remove("drag-over");
  }
});

el.drivePanel.addEventListener("drop", (e) => {
  e.preventDefault();
  el.drivePanel.classList.remove("drag-over");
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) {
    handleSelectedFile(file);
  }
});

el.btnConvert.addEventListener("click", runConversion);
el.btnOpenGemini.addEventListener("click", shareToGemini);
el.btnSaveJson.addEventListener("click", saveJsonFile);
el.btnCopyMarkdown.addEventListener("click", copyAsMarkdown);

// Enregistrement Service Worker (cache désactivé) & bannière d'installation PWA
if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
  window.addEventListener("load", async () => {
    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      } catch {
        // Ignore cache cleanup errors
      }
    }
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  el.installBanner.classList.remove("hidden");
});

el.btnInstallPwa.addEventListener("click", async () => {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  el.installBanner.classList.add("hidden");
});

el.btnDismissInstall.addEventListener("click", () => {
  el.installBanner.classList.add("hidden");
});
