import { formatFileSize, isValidFitBuffer, parseFitBuffer } from "./fit-parser.js";

const state = {
  selectedFile: null, // { name, sizeBytes, buffer }
  parseResult: null,  // { csvContent, csvSizeBytes, csvSizeFormatted, records, summary, fileName }
  deferredInstallPrompt: null
};

const el = {
  drivePanel: document.getElementById("drive-panel"),
  fileInput: document.getElementById("fit-file-input"),
  btnPickFit: document.getElementById("btn-pick-fit"),
  fitErrorBox: document.getElementById("fit-error-box"),
  fitErrorText: document.getElementById("fit-error-text"),
  fitEmptyState: document.getElementById("fit-empty-state"),
  fitSelectedState: document.getElementById("fit-selected-state"),
  selectedFileName: document.getElementById("selected-file-name"),
  selectedFileSize: document.getElementById("selected-file-size"),
  btnConvert: document.getElementById("btn-convert"),
  geminiIdleState: document.getElementById("gemini-idle-state"),
  geminiLoadingState: document.getElementById("gemini-loading-state"),
  geminiErrorState: document.getElementById("gemini-error-state"),
  geminiErrorText: document.getElementById("gemini-error-text"),
  geminiSuccessState: document.getElementById("gemini-success-state"),
  csvPointsBadge: document.getElementById("csv-points-badge"),
  metricDistance: document.getElementById("metric-distance"),
  metricHr: document.getElementById("metric-hr"),
  metricSpeed: document.getElementById("metric-speed"),
  metricPower: document.getElementById("metric-power"),
  btnOpenGemini: document.getElementById("btn-open-gemini"),
  btnSaveCsv: document.getElementById("btn-save-csv"),
  installBanner: document.getElementById("install-banner"),
  btnInstallPwa: document.getElementById("btn-install-pwa"),
  btnDismissInstall: document.getElementById("btn-dismiss-install"),
  toast: document.getElementById("toast")
};

let toastTimer = null;

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove("visible");
  }, 3000);
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
    el.btnConvert.classList.add("ready");
    setGeminiView("idle");

    showToast(`Fichier .FIT prêt : ${normalizedName} (${formatFileSize(buffer.byteLength)})`);
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

  // Yield one frame so the loading spinner paints smoothly before parsing
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        const result = parseFitBuffer(
          state.selectedFile.buffer,
          state.selectedFile.name,
          state.selectedFile.sizeBytes
        );

        if (!result.csvContent || result.csvSizeBytes <= 0) {
          throw new Error("Le fichier CSV généré est vide.");
        }

        state.parseResult = result;
        el.csvPointsBadge.textContent = `${result.records.length} points • ${result.csvSizeFormatted}`;
        el.metricDistance.textContent = `${(result.summary.totalDistanceMeters / 1000).toFixed(2)} km`;
        el.metricHr.textContent = result.summary.avgHeartRate ? `${result.summary.avgHeartRate} bpm` : "N/A";
        el.metricSpeed.textContent = result.summary.avgSpeedKmh ? `${result.summary.avgSpeedKmh.toFixed(1)} km/h` : "N/A";
        el.metricPower.textContent = result.summary.avgPower ? `${result.summary.avgPower} W` : "N/A";

        setGeminiView("success");
        showToast(`Conversion réussie : ${result.records.length} points (${result.csvSizeFormatted})`);
      } catch (err) {
        state.parseResult = null;
        setGeminiView("error", err.message || "Impossible de décoder ce fichier .FIT.");
      }
    }, 30);
  });
}

function buildCsvFilename() {
  const rawName = state.parseResult?.fileName || state.selectedFile?.name || "activity.fit";
  const baseName = rawName.replace(/\.fit$/i, "");
  return `${baseName}_gemini.csv`;
}

function triggerBlobDownload(csvContent, filename) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  if (blob.size <= 0) {
    showToast("Erreur : le fichier CSV est vide.");
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

async function saveCsvFile() {
  if (!state.parseResult || !state.parseResult.csvContent) {
    showToast("Aucun CSV converti à sauvegarder.");
    return;
  }

  const filename = buildCsvFilename();
  const csvContent = state.parseResult.csvContent;
  const sizeFormatted = state.parseResult.csvSizeFormatted;

  // Use File System Access API on supported mobile/desktop browsers if available
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "Fichier CSV UTF-8",
            accept: { "text/csv": [".csv"] }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([csvContent], { type: "text/csv;charset=utf-8" }));
      await writable.close();
      showToast(`Fichier .CSV sauvegardé (${sizeFormatted}) !`);
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      // Fall through to standard Blob download if showSaveFilePicker fails
    }
  }

  if (triggerBlobDownload(csvContent, filename)) {
    showToast(`Fichier .CSV téléchargé (${sizeFormatted}) !`);
  }
}

async function shareToGemini() {
  if (!state.parseResult || !state.parseResult.csvContent) {
    showToast("Aucun CSV converti à envoyer.");
    return;
  }

  const filename = buildCsvFilename();
  const csvContent = state.parseResult.csvContent;

  const csvFile = new File([csvContent], filename, { type: "text/csv" });
  const promptText =
    "Voici les données de mon activité Garmin (fichier CSV joint). Peux-tu analyser mes métriques (allure, dénivelé, fréquence cardiaque, puissance) et me donner des recommandations ?";

  if (typeof navigator.share === "function") {
    const shareWithFile = {
      title: filename,
      text: promptText,
      files: [csvFile]
    };

    try {
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [csvFile] })) {
        await navigator.share(shareWithFile);
        showToast("Partage avec fichier CSV joint ouvert !");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
      // Fall through to download + Gemini web fallback
    }
  }

  // Fallback for browsers without Web Share file support: download CSV + open Gemini
  triggerBlobDownload(csvContent, filename);
  showToast(`CSV téléchargé (${state.parseResult.csvSizeFormatted}). Importez-le dans Gemini !`);
  setTimeout(() => {
    window.open("https://gemini.google.com/app", "_blank", "noopener");
  }, 450);
}

// Wire Events
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

// Drag & drop support for tablet/desktop browsers
el.drivePanel.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.drivePanel.classList.add("drag-over");
});

el.drivePanel.addEventListener("dragleave", () => {
  el.drivePanel.classList.remove("drag-over");
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
el.btnSaveCsv.addEventListener("click", saveCsvFile);
el.btnOpenGemini.addEventListener("click", shareToGemini);

// PWA Service Worker Registration & Install Prompt
if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Ignore SW registration errors in restricted WebView preview origins
    });
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
