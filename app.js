(function () {
  "use strict";

  const STORAGE_KEY = "proposal-manager:proposals:v1";
  const LEGACY_DRAFT_KEY = "proposal-manager:draft:v1";
  const DIVISION_OPTIONS_KEY = "proposal-manager:division-options:v1";
  const FIREBASE_SDK_VERSION = "12.7.0";
  const FIREBASE_COLLECTION = "proposals";
  const FIREBASE_SETTINGS_COLLECTION = "proposalManager";
  const FIREBASE_OPTIONS_DOC = "divisionOptions";
  const IMAGE_MAX_SIZE = 1400;
  const IMAGE_JPEG_QUALITY = 0.72;
  const COUNTRY_COLOR_ORDER = ["none", "green", "red"];
  const STATUSES = ["Pending", "Completed", "For information only"];
  const SORT_OPTIONS = [
    { value: "date-desc", label: "Newest first" },
    { value: "date-asc", label: "Oldest first" },
    { value: "proposal-date-desc", label: "Proposal date newest" },
    { value: "proposal-date-asc", label: "Proposal date oldest" },
    { value: "deadline-asc", label: "Deadline soonest" },
    { value: "deadline-desc", label: "Deadline latest" },
    { value: "title-asc", label: "Title A-Z" },
    { value: "title-desc", label: "Title Z-A" }
  ];
  const STATUS_MIGRATION = {
    Draft: "Pending",
    Final: "Completed",
    Sent: "For information only"
  };

  const app = document.getElementById("app");
  const topbar = document.querySelector(".topbar");
  const backupButton = document.getElementById("backupButton");
  const importInput = document.getElementById("importInput");
  const cloudStatus = document.getElementById("cloudStatus");

  let proposals = loadProposals();
  let divisionOptions = loadDivisionOptions();
  let firebaseState = {
    enabled: false,
    db: null,
    api: null,
    remoteProposalIds: new Set()
  };

  function uid() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "proposal-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function todayISO() {
    return new Date().toISOString();
  }

  function dateInputValue(value) {
    if (!value) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
  }

  function todayDateInput() {
    return dateInputValue(todayISO());
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(date);
  }

  function formatDateInput(value, fallback) {
    const normalized = dateInputValue(value);
    if (!normalized) return fallback || "";
    return formatDate(normalized + "T00:00:00");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeStatus(status) {
    const migrated = STATUS_MIGRATION[status] || status;
    return STATUSES.includes(migrated) ? migrated : "Pending";
  }

  function statusClass(status) {
    return normalizeStatus(status).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function shortStatusLabel(status) {
    return status === "For information only" ? "For info..." : status;
  }

  function datedSortValue(value) {
    const normalized = dateInputValue(value);
    return normalized ? new Date(normalized + "T00:00:00").getTime() : null;
  }

  function compareDatesWithEmptyLast(aValue, bValue, direction = "asc") {
    const aTime = datedSortValue(aValue);
    const bTime = datedSortValue(bValue);
    if (aTime === null && bTime === null) return 0;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return direction === "desc" ? bTime - aTime : aTime - bTime;
  }

  function normalizeStoredImage(image, fallbackName = "Captured image") {
    if (!image || !image.dataUrl) return null;
    return {
      name: String(image.name || fallbackName),
      type: String(image.type || "image/*"),
      size: Number(image.size || 0),
      originalName: String(image.originalName || ""),
      originalType: String(image.originalType || ""),
      originalSize: Number(image.originalSize || 0),
      width: Number(image.width || 0),
      height: Number(image.height || 0),
      compressed: Boolean(image.compressed),
      dataUrl: String(image.dataUrl || "")
    };
  }

  function normalizeCommentStatus(row) {
    const status = String(row.commentsStatus || row.commentStatus || "").trim();
    if (status === "clear") return "cleared";
    if (["awaited", "cleared", "partial", "declined"].includes(status)) return status;
    if (String(row.comments || "").trim()) return "partial";
    return "awaited";
  }

  function normalizeCountries(value) {
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === "string") {
            return { name: item.trim(), color: "none" };
          }
          const name = String((item && item.name) || "").trim();
          const color = ["green", "red"].includes(item && item.color) ? item.color : "none";
          return name ? { name, color } : null;
        })
        .filter(Boolean);
    }

    if (typeof value === "string") {
      return value
        .split(",")
        .map((country) => country.trim())
        .filter(Boolean)
        .map((name) => ({ name, color: "none" }));
    }

    return [];
  }

  function normalizeDivisionRows(divisions) {
    const incoming = Array.isArray(divisions) ? divisions : [];
    return incoming
      .map((row) => {
        const additionalPhoto = normalizeStoredImage(row && row.additionalPhoto);
        return {
          division: String((row && (row.division || row.divisions)) || "").trim(),
          commentsStatus: normalizeCommentStatus(row || {}),
          comments: String((row && row.comments) || "").trim(),
          additionalPhoto,
          countries: normalizeCountries(row && row.countries)
        };
      })
      .filter((row) => row.division);
  }

  function normalizeProposal(proposal) {
    const now = todayISO();
    const images = normalizeImages(proposal);
    const legacyTimeline = String(proposal.timeline || "").trim();
    const inferredDate = /^\d{4}-\d{2}-\d{2}$/.test(legacyTimeline) ? legacyTimeline : "";
    const incomingTimelineDate = dateInputValue(proposal.timelineDate || inferredDate);
    const timelineType = proposal.timelineType === "date" || incomingTimelineDate ? "date" : "none";
    const timelineDate = timelineType === "date" ? incomingTimelineDate : "";

    return {
      id: String(proposal.id || uid()),
      title: String(proposal.title || "").trim(),
      description: String(proposal.description || "").trim(),
      timelineType,
      timelineDate,
      deadline: dateInputValue(proposal.deadline || proposal.dueDate),
      def: Boolean(proposal.def),
      notes: String(proposal.notes || "").trim(),
      divisions: normalizeDivisionRows(proposal.divisions),
      images,
      status: normalizeStatus(proposal.status),
      createdAt: proposal.createdAt || now,
      updatedAt: proposal.updatedAt || now
    };
  }

  function loadProposals() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(stored)) return [];
      return stored.map(normalizeProposal);
    } catch (error) {
      console.warn("Unable to load proposals", error);
      return [];
    }
  }

  function saveProposals() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(proposals));
    saveProposalsToFirebase();
  }

  function collectDivisionOptions(source) {
    const seen = new Set();
    return (source || [])
      .flatMap((proposal) => Array.isArray(proposal.divisions) ? proposal.divisions : [])
      .map((row) => String(row.division || "").trim())
      .filter((name) => {
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
  }

  function normalizeDivisionOptions(options) {
    const seen = new Set();
    const incoming = Array.isArray(options) ? options : [];
    return incoming
      .map((option) => String(option || "").trim())
      .filter((option) => {
        if (!option || seen.has(option)) return false;
        seen.add(option);
        return true;
      });
  }

  function loadDivisionOptions() {
    try {
      const raw = localStorage.getItem(DIVISION_OPTIONS_KEY);
      if (raw === null) {
        return collectDivisionOptions(proposals);
      }
      const stored = JSON.parse(raw);
      return normalizeDivisionOptions(stored);
    } catch (error) {
      return collectDivisionOptions(proposals);
    }
  }

  function saveDivisionOptions() {
    localStorage.setItem(DIVISION_OPTIONS_KEY, JSON.stringify(divisionOptions));
    saveDivisionOptionsToFirebase();
  }

  function syncStoredDivisionOptions() {
    divisionOptions = normalizeDivisionOptions(divisionOptions);
    saveDivisionOptions();
  }

  function setCloudStatus(message) {
    if (cloudStatus) {
      cloudStatus.textContent = message;
    }
  }

  function firebaseDoc(path) {
    return firebaseState.api.doc(firebaseState.db, path);
  }

  function firebaseCollection(path) {
    return firebaseState.api.collection(firebaseState.db, path);
  }

  function canUseFirebase() {
    return firebaseState.enabled && firebaseState.db && firebaseState.api;
  }

  async function initializeFirebase() {
    try {
      const configModule = await import("./firebase-config.js");
      const config = configModule.firebaseConfig || {};
      const configured = typeof configModule.isFirebaseConfigured === "function"
        ? configModule.isFirebaseConfigured(config)
        : Boolean(config.apiKey && config.projectId && config.appId);

      if (!configured) {
        setCloudStatus("Local storage");
        return;
      }

      setCloudStatus("Connecting...");
      const appModule = await import("https://www.gstatic.com/firebasejs/" + FIREBASE_SDK_VERSION + "/firebase-app.js");
      const firestoreModule = await import("https://www.gstatic.com/firebasejs/" + FIREBASE_SDK_VERSION + "/firebase-firestore.js");
      const firebaseApp = appModule.initializeApp(config);
      const db = firestoreModule.getFirestore(firebaseApp);

      firebaseState = {
        ...firebaseState,
        enabled: true,
        db,
        api: firestoreModule
      };

      await loadFirebaseData();
      setCloudStatus("Synced");
      render();
    } catch (error) {
      console.warn("Firebase unavailable; continuing with local storage.", error);
      firebaseState.enabled = false;
      setCloudStatus("Local storage");
    }
  }

  async function loadFirebaseData() {
    if (!canUseFirebase()) return;

    const { getDocs, getDoc } = firebaseState.api;

    const proposalSnapshot = await getDocs(firebaseCollection(FIREBASE_COLLECTION));
    const remoteProposals = [];
    proposalSnapshot.forEach((docSnapshot) => {
      remoteProposals.push(normalizeProposal({
        id: docSnapshot.id,
        ...docSnapshot.data()
      }));
    });

    firebaseState.remoteProposalIds = new Set(remoteProposals.map((proposal) => proposal.id));

    const optionsSnapshot = await getDoc(firebaseDoc(FIREBASE_SETTINGS_COLLECTION + "/" + FIREBASE_OPTIONS_DOC));
    const remoteOptions = optionsSnapshot.exists()
      ? normalizeDivisionOptions((optionsSnapshot.data() || {}).options)
      : null;

    if (remoteProposals.length || optionsSnapshot.exists()) {
      proposals = remoteProposals;
      divisionOptions = remoteOptions || collectDivisionOptions(proposals);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(proposals));
      localStorage.setItem(DIVISION_OPTIONS_KEY, JSON.stringify(divisionOptions));
    } else if (proposals.length || divisionOptions.length) {
      await saveProposalsToFirebase();
      await saveDivisionOptionsToFirebase();
    }
  }

  async function saveProposalsToFirebase() {
    if (!canUseFirebase()) return;

    try {
      const {
        writeBatch
      } = firebaseState.api;
      const batch = writeBatch(firebaseState.db);
      const nextIds = new Set(proposals.map((proposal) => proposal.id));

      proposals.forEach((proposal) => {
        batch.set(firebaseDoc(FIREBASE_COLLECTION + "/" + proposal.id), proposal);
      });

      firebaseState.remoteProposalIds.forEach((id) => {
        if (!nextIds.has(id)) {
          batch.delete(firebaseDoc(FIREBASE_COLLECTION + "/" + id));
        }
      });

      await batch.commit();
      firebaseState.remoteProposalIds = nextIds;
      setCloudStatus("Synced");
    } catch (error) {
      console.warn("Unable to save proposals to Firebase", error);
      setCloudStatus("Sync pending");
    }
  }

  async function saveDivisionOptionsToFirebase() {
    if (!canUseFirebase()) return;

    try {
      await firebaseState.api.setDoc(
        firebaseDoc(FIREBASE_SETTINGS_COLLECTION + "/" + FIREBASE_OPTIONS_DOC),
        {
          options: normalizeDivisionOptions(divisionOptions),
          updatedAt: todayISO()
        }
      );
      setCloudStatus("Synced");
    } catch (error) {
      console.warn("Unable to save division options to Firebase", error);
      setCloudStatus("Sync pending");
    }
  }

  function getProposal(id) {
    return proposals.find((proposal) => proposal.id === id);
  }

  function navigate(path) {
    window.location.hash = path;
  }

  function currentRoute() {
    const hash = window.location.hash.replace(/^#/, "") || "/";
    const parts = hash.split("/").filter(Boolean);
    if (parts.length === 0) return { page: "dashboard" };
    if (parts[0] === "new") return { page: "form", id: null };
    if (parts[0] === "edit" && parts[1]) return { page: "form", id: parts[1] };
    if (parts[0] === "proposal" && parts[1]) return { page: "detail", id: parts[1] };
    return { page: "not-found" };
  }

  function render() {
    document.title = "Proposal Manager";
    const route = currentRoute();
    topbar.hidden = route.page !== "dashboard";
    if (route.page === "dashboard") renderDashboard();
    if (route.page === "form") renderForm(route.id);
    if (route.page === "detail") renderDetail(route.id);
    if (route.page === "not-found") renderNotFound();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderDashboard() {
    app.innerHTML = "";
    app.append(document.getElementById("dashboardTemplate").content.cloneNode(true));

    const searchInput = document.getElementById("searchInput");
    const statusFilterPanel = document.getElementById("statusFilterPanel");
    const sortPanel = document.getElementById("sortPanel");
    const proposalList = document.getElementById("proposalList");
    const emptyState = document.getElementById("emptyState");
    const resultCount = document.getElementById("resultCount");
    const selectedStatuses = new Set(["All"]);
    let selectedSort = "date-desc";

    function renderDashboardPanels() {
      renderChoicePanel(statusFilterPanel, ["All"].concat(STATUSES), {
        selectedValues: selectedStatuses,
        labelFor: (value) => shortStatusLabel(value),
        titleFor: (value) => value,
        onChange(nextValue) {
          if (nextValue === "All") {
            selectedStatuses.clear();
            selectedStatuses.add("All");
          } else {
            selectedStatuses.delete("All");
            if (selectedStatuses.has(nextValue)) {
              selectedStatuses.delete(nextValue);
            } else {
              selectedStatuses.add(nextValue);
            }
            if (!selectedStatuses.size) {
              selectedStatuses.add("All");
            }
          }
          drawList();
          renderDashboardPanels();
        }
      });

      renderChoicePanel(sortPanel, SORT_OPTIONS.map((option) => option.value), {
        selectedValues: new Set([selectedSort]),
        labelFor: (value) => (SORT_OPTIONS.find((option) => option.value === value) || {}).label || value,
        onChange(nextValue) {
          selectedSort = nextValue;
          drawList();
          renderDashboardPanels();
        }
      });
    }

    function drawList() {
      const query = searchInput.value.trim().toLowerCase();
      const sort = selectedSort;
      const activeStatuses = selectedStatuses.has("All") ? STATUSES : Array.from(selectedStatuses);

      let visible = proposals.filter((proposal) => {
        const searchable = [
          proposal.title,
          proposal.description,
          proposal.deadline,
          proposal.timelineDate,
          proposal.notes,
          ...proposal.divisions.flatMap((row) => [
            row.division,
            row.comments
          ])
        ].join(" ").toLowerCase();
        return (!query || searchable.includes(query)) && activeStatuses.includes(proposal.status);
      });

      visible = visible.sort((a, b) => {
        if (sort === "date-asc") return new Date(a.updatedAt) - new Date(b.updatedAt);
        if (sort === "proposal-date-asc") return compareDatesWithEmptyLast(a.timelineDate, b.timelineDate, "asc");
        if (sort === "proposal-date-desc") return compareDatesWithEmptyLast(a.timelineDate, b.timelineDate, "desc");
        if (sort === "deadline-asc") return compareDatesWithEmptyLast(a.deadline, b.deadline, "asc");
        if (sort === "deadline-desc") return compareDatesWithEmptyLast(a.deadline, b.deadline, "desc");
        if (sort === "title-asc") return a.title.localeCompare(b.title);
        if (sort === "title-desc") return b.title.localeCompare(a.title);
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });

      proposalList.innerHTML = "";
      resultCount.textContent = visible.length + " shown";
      emptyState.hidden = visible.length > 0;

      visible.forEach((proposal) => {
        const card = document.createElement("a");
        card.className = "proposal-card";
        card.href = "#/proposal/" + encodeURIComponent(proposal.id);
        card.innerHTML = `
          <div class="card-title-row">
            <h3>${escapeHtml(proposal.title || "Untitled Proposal")}</h3>
            <span class="status-badge ${statusClass(proposal.status)}">${escapeHtml(proposal.status)}</span>
          </div>
          <div class="proposal-meta">
            <span>${proposal.deadline ? "Deadline " + formatDateInput(proposal.deadline) : formatDate(proposal.updatedAt)}</span>
          </div>
        `;
        proposalList.append(card);
      });
    }

    searchInput.addEventListener("input", drawList);
    renderDashboardPanels();
    drawList();
  }

  function renderForm(id) {
    const existing = id ? getProposal(id) : null;
    if (id && !existing) {
      renderNotFound();
      return;
    }

    app.innerHTML = "";
    app.append(document.getElementById("formTemplate").content.cloneNode(true));

    const form = document.getElementById("proposalForm");
    const autosaveState = document.getElementById("autosaveState");
    const deleteButton = document.getElementById("deleteFromForm");
    const ocrUpload = document.getElementById("ocrUpload");
    const cameraCapture = document.getElementById("cameraCapture");
    const divisionRows = document.getElementById("divisionRows");
    const formDivisionPanel = document.getElementById("formDivisionPanel");
    const formDivisionEmpty = document.getElementById("formDivisionEmpty");
    const editFormDivisionsButton = document.getElementById("editFormDivisionsButton");
    const importDivisionJsonButton = document.getElementById("importDivisionJsonButton");
    const formDivisionModal = document.getElementById("formDivisionModal");
    const divisionJsonModal = document.getElementById("divisionJsonModal");
    const divisionJsonInput = document.getElementById("divisionJsonInput");
    const applyDivisionJsonButton = document.getElementById("applyDivisionJsonButton");
    const cancelDivisionJsonModal = document.getElementById("cancelDivisionJsonModal");
    const closeDivisionJsonModal = document.getElementById("closeDivisionJsonModal");
    const formDivisionOptionList = document.getElementById("formDivisionOptionList");
    const formNewDivisionInput = document.getElementById("formNewDivisionInput");
    const addFormDivisionOption = document.getElementById("addFormDivisionOption");
    const saveFormDivisionOptions = document.getElementById("saveFormDivisionOptions");
    const cancelFormDivisionModal = document.getElementById("cancelFormDivisionModal");
    const closeFormDivisionModal = document.getElementById("closeFormDivisionModal");
    const removeImageButton = document.getElementById("removeImageButton");
    const data = existing || {};
    const imageOwnerId = existing ? existing.id : uid();
    let currentImages = normalizeImages(data);

    if (!existing) {
      localStorage.removeItem(LEGACY_DRAFT_KEY);
    }

    deleteButton.hidden = !existing;

    form.elements.title.value = data.title || "";
    form.elements.description.value = data.description || "";
    setBinarySwitch(form, "def", Boolean(data.def));
    setOptionalDate(form, "deadline", data.deadline || "");
    setOptionalDate(form, "timelineDate", data.timelineDate || "");
    form.elements.notes.value = data.notes || "";
    form.elements.status.value = data.status || "Pending";
    renderDivisionRows(divisionRows, data.divisions || []);
    renderFormDivisionSelector();
    syncFormDivisionEmptyState();
    updateImagePreview(currentImages);

    let autosaveTimer;
    form.addEventListener("input", () => {
      clearTimeout(autosaveTimer);
      autosaveState.textContent = "Saving...";
      autosaveTimer = setTimeout(() => {
        const formData = readForm(form, currentImages);
        if (existing) {
          Object.assign(existing, formData, { updatedAt: todayISO() });
          saveProposals();
          autosaveState.textContent = "Autosaved";
        } else {
          autosaveState.textContent = "Unsaved changes";
        }
      }, 350);
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = readForm(form, currentImages);
      if (!formData.title) {
        alert("Please add a proposal title.");
        return;
      }
      if (existing) {
        Object.assign(existing, formData, { updatedAt: todayISO() });
      } else {
        const now = todayISO();
        proposals.unshift(normalizeProposal({
          ...formData,
          id: imageOwnerId,
          createdAt: now,
          updatedAt: now
        }));
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      }

      saveProposals();
      navigate("#/proposal/" + encodeURIComponent((existing || proposals[0]).id));
    });

    deleteButton.addEventListener("click", () => {
      if (existing && confirm("Delete this proposal permanently?")) {
        proposals = proposals.filter((proposal) => proposal.id !== existing.id);
        saveProposals();
        navigate("#/");
      }
    });

    form.querySelectorAll("[data-date-switch]").forEach((toggle) => {
      toggle.addEventListener("click", (event) => {
        const name = toggle.dataset.dateSwitch;
        const active = form.elements[name + "Mode"].value === "date";
        const clickedTrack = Boolean(event.target.closest(".switch-track"));
        if (active && !clickedTrack) {
          openDatePicker(form.elements[name]);
        } else {
          form.elements[name + "Mode"].value = active ? "none" : "date";
          syncOptionalDate(form, name);
          if (!active) {
            openDatePicker(form.elements[name]);
          }
        }
        form.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    form.querySelectorAll("[data-binary-switch]").forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const name = toggle.dataset.binarySwitch;
        const nextValue = form.elements[name + "Mode"].value === "on" ? "off" : "on";
        form.elements[name + "Mode"].value = nextValue;
        syncBinarySwitch(form, name);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    form.elements.deadline.addEventListener("change", () => {
      syncOptionalDate(form, "deadline");
      form.dispatchEvent(new Event("input", { bubbles: true }));
    });
    form.elements.timelineDate.addEventListener("change", () => {
      syncOptionalDate(form, "timelineDate");
      form.dispatchEvent(new Event("input", { bubbles: true }));
    });

    function renderFormDivisionSelector() {
      const selectedValues = new Set(readDivisions(form).map((row) => row.division).filter(Boolean));
      renderChoicePanel(formDivisionPanel, divisionOptions, {
        selectedValues,
        emptyMessage: "Add division options to start selecting them.",
        onChange(nextValue) {
          const nextSelected = new Set(selectedValues);
          if (nextSelected.has(nextValue)) {
            nextSelected.delete(nextValue);
          } else {
            nextSelected.add(nextValue);
          }
          renderDivisionRows(divisionRows, syncProposalDivisions(readDivisions(form), nextSelected));
          syncFormDivisionEmptyState();
          renderFormDivisionSelector();
          form.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    }

    function syncFormDivisionEmptyState() {
      formDivisionEmpty.hidden = readDivisions(form).length > 0;
    }

    function renderFormDivisionOptionEditor(options) {
      formDivisionOptionList.innerHTML = "";
      options.forEach((option) => {
        const row = document.createElement("div");
        row.className = "division-option-row";
        row.dataset.originalOption = option;
        row.innerHTML = `
          <input type="text" value="${escapeHtml(option)}" data-division-option-input>
          <button class="danger-button compact-button" type="button" data-division-option-remove>Delete</button>
        `;
        formDivisionOptionList.append(row);
      });
    }

    function openFormDivisionModal() {
      renderFormDivisionOptionEditor(divisionOptions);
      formNewDivisionInput.value = "";
      formDivisionModal.hidden = false;
    }

    function closeFormDivisionEditor() {
      formDivisionModal.hidden = true;
    }

    function openDivisionJsonModal() {
      divisionJsonInput.value = "";
      divisionJsonModal.hidden = false;
      divisionJsonInput.focus();
    }

    function closeDivisionJsonEditor() {
      divisionJsonModal.hidden = true;
    }

    function applyDivisionJsonImport() {
      let importedRows;
      try {
        importedRows = parseDivisionJson(divisionJsonInput.value);
      } catch (error) {
        alert(error.message || "That JSON could not be read.");
        return;
      }

      const currentRows = readDivisions(form);
      const rowMap = new Map(currentRows.map((row) => [row.division, row]));
      importedRows.forEach((row) => {
        const existingRow = rowMap.get(row.division);
        rowMap.set(row.division, existingRow
          ? {
              ...existingRow,
              countries: row.countries
            }
          : row);
      });

      divisionOptions = normalizeDivisionOptions(divisionOptions.concat(importedRows.map((row) => row.division)));
      syncStoredDivisionOptions();
      const selectedValues = new Set(Array.from(rowMap.keys()));
      const nextRows = syncProposalDivisions(Array.from(rowMap.values()), selectedValues);
      renderDivisionRows(divisionRows, nextRows);
      renderFormDivisionSelector();
      syncFormDivisionEmptyState();
      closeDivisionJsonEditor();
      form.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function appendFormDivisionOptionRow(value) {
      const row = document.createElement("div");
      row.className = "division-option-row";
      row.innerHTML = `
        <input type="text" value="${escapeHtml(value)}" data-division-option-input>
        <button class="danger-button compact-button" type="button" data-division-option-remove>Delete</button>
      `;
      formDivisionOptionList.append(row);
    }

    function saveFormDivisionOptionChanges() {
      const currentRows = readDivisions(form);
      const editedRows = Array.from(formDivisionOptionList.querySelectorAll(".division-option-row")).map((row) => ({
        original: row.dataset.originalOption || "",
        current: row.querySelector("[data-division-option-input]").value.trim()
      }));
      divisionOptions = normalizeDivisionOptions(editedRows.map((row) => row.current));
      const renameMap = new Map();
      editedRows.forEach((row) => {
        if (row.original && row.current && row.original !== row.current && divisionOptions.includes(row.current)) {
          renameMap.set(row.original, row.current);
        }
      });
      proposals = proposals.map((item) => ({
        ...item,
        divisions: syncProposalDivisions(
          (item.divisions || []).map((row) => ({
            ...row,
            division: renameMap.get(row.division) || row.division
          })).filter((row) => divisionOptions.includes(row.division)),
          new Set((item.divisions || [])
            .map((row) => renameMap.get(row.division) || row.division)
            .filter((division) => divisionOptions.includes(division)))
        )
      }));
      const nextRows = syncProposalDivisions(
        currentRows.map((row) => ({
          ...row,
          division: renameMap.get(row.division) || row.division
        })).filter((row) => divisionOptions.includes(row.division)),
        new Set(currentRows
          .map((row) => renameMap.get(row.division) || row.division)
          .filter((division) => divisionOptions.includes(division)))
      );
      renderDivisionRows(divisionRows, nextRows);
      syncStoredDivisionOptions();
      saveProposals();
      renderFormDivisionSelector();
      syncFormDivisionEmptyState();
      closeFormDivisionEditor();
      form.dispatchEvent(new Event("input", { bubbles: true }));
    }

    divisionRows.addEventListener("input", () => {
      syncFormDivisionEmptyState();
    });
    divisionRows.addEventListener("click", (event) => {
      const removePhotoButton = event.target.closest("[data-remove-division-photo]");
      if (removePhotoButton) {
        const row = removePhotoButton.closest("tr");
        row.querySelector("[data-division-field='additionalPhoto']").value = "";
        renderDivisionPhotoPreview(row, null);
        form.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      const countryChip = event.target.closest("[data-country-index]");
      if (countryChip) {
        const row = countryChip.closest("tr");
        cycleCountryColor(row, Number(countryChip.dataset.countryIndex));
        form.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    divisionRows.addEventListener("change", async (event) => {
      const input = event.target.closest("[data-division-photo-input]");
      if (!input) return;
      const file = input.files && input.files[0];
      if (!file) return;
      const row = input.closest("tr");
      try {
        const storedImage = await createLocalStoredImage(file);
        row.querySelector("[data-division-field='additionalPhoto']").value = JSON.stringify(storedImage);
        renderDivisionPhotoPreview(row, storedImage);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) {
        console.warn("Division photo capture failed", error);
        alert("Could not save that captured photo. Please try another image.");
      } finally {
        input.value = "";
      }
    });

    editFormDivisionsButton.addEventListener("click", openFormDivisionModal);
    importDivisionJsonButton.addEventListener("click", openDivisionJsonModal);
    addFormDivisionOption.addEventListener("click", () => {
      const value = formNewDivisionInput.value.trim();
      if (!value) return;
      appendFormDivisionOptionRow(value);
      formNewDivisionInput.value = "";
      formNewDivisionInput.focus();
    });
    formDivisionOptionList.addEventListener("click", (event) => {
      const removeButton = event.target.closest("[data-division-option-remove]");
      if (!removeButton) return;
      removeButton.closest(".division-option-row").remove();
    });
    saveFormDivisionOptions.addEventListener("click", saveFormDivisionOptionChanges);
    cancelFormDivisionModal.addEventListener("click", closeFormDivisionEditor);
    closeFormDivisionModal.addEventListener("click", closeFormDivisionEditor);
    applyDivisionJsonButton.addEventListener("click", applyDivisionJsonImport);
    cancelDivisionJsonModal.addEventListener("click", closeDivisionJsonEditor);
    closeDivisionJsonModal.addEventListener("click", closeDivisionJsonEditor);
    formDivisionModal.addEventListener("click", (event) => {
      if (event.target === formDivisionModal) {
        closeFormDivisionEditor();
      }
    });
    divisionJsonModal.addEventListener("click", (event) => {
      if (event.target === divisionJsonModal) {
        closeDivisionJsonEditor();
      }
    });

    removeImageButton.addEventListener("click", () => {
      currentImages = [];
      updateImagePreview(currentImages);
      form.dispatchEvent(new Event("input", { bubbles: true }));
    });

    async function processOcrFiles(input) {
      const files = Array.from(input.files || []);
      if (!files.length) return;

      try {
        autosaveState.textContent = "Saving images...";
        const storedImages = await Promise.all(files.map(createLocalStoredImage));
        currentImages = currentImages.concat(storedImages);
        updateImagePreview(currentImages);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) {
        console.warn("Image upload failed", error);
        alert("Could not save those images. Please try different files.");
        input.value = "";
        return;
      }

      if (!window.Tesseract || !window.Tesseract.recognize) {
        const missingScriptNote = "\n\n[OCR unavailable: Tesseract.js could not be loaded. Check your internet connection, then try again.]";
        form.elements.description.value = (form.elements.description.value || "") + missingScriptNote;
        form.dispatchEvent(new Event("input", { bubbles: true }));
        input.value = "";
        return;
      }

      ocrUpload.disabled = true;
      cameraCapture.disabled = true;
      autosaveState.textContent = "OCR starting...";

      const notes = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        try {
          const result = await window.Tesseract.recognize(file, "eng", {
            logger: (progress) => {
              if (progress.status === "recognizing text") {
                const percent = Math.round((progress.progress || 0) * 100);
                autosaveState.textContent = "OCR " + (index + 1) + "/" + files.length + " " + percent + "%";
              } else if (progress.status) {
                autosaveState.textContent = "OCR " + (index + 1) + "/" + files.length + " " + progress.status;
              }
            }
          });
          const extracted = (result.data && result.data.text ? result.data.text : "").trim();
          notes.push(extracted
            ? "[OCR from " + file.name + "]\n" + extracted
            : "[OCR from " + file.name + ": no readable text found.]");
        } catch (error) {
          notes.push("[OCR from " + file.name + " failed. Try a clearer image or check your connection.]");
        }
      }

      if (notes.length) {
        form.elements.description.value = (form.elements.description.value || "") + "\n\n" + notes.join("\n\n");
        form.dispatchEvent(new Event("input", { bubbles: true }));
      }

      ocrUpload.disabled = false;
      cameraCapture.disabled = false;
      input.value = "";
      if (autosaveState.textContent.startsWith("OCR") || autosaveState.textContent.includes("loading")) {
        autosaveState.textContent = "OCR complete";
      }
    }

    ocrUpload.addEventListener("change", () => processOcrFiles(ocrUpload));
    cameraCapture.addEventListener("change", () => processOcrFiles(cameraCapture));
  }

  function syncOptionalDate(form, name) {
    const input = form.elements[name];
    const mode = form.elements[name + "Mode"];
    const hasDate = mode.value === "date";
    input.disabled = !hasDate;
    if (!hasDate) {
      input.value = "";
    } else if (!input.value) {
      input.value = todayDateInput();
    }
    syncDateSwitch(form, name);
  }

  function setOptionalDate(form, name, value) {
    const normalized = dateInputValue(value);
    form.elements[name + "Mode"].value = normalized ? "date" : "none";
    form.elements[name].value = normalized;
    syncOptionalDate(form, name);
  }

  function syncDateSwitch(form, name) {
    const value = form.elements[name + "Mode"].value;
    const toggle = form.querySelector('[data-date-switch="' + name + '"]');
    if (!toggle) return;
    const checked = value === "date";
    const label = toggle.querySelector("[data-date-switch-label]");
    toggle.classList.toggle("active", checked);
    toggle.setAttribute("aria-checked", checked ? "true" : "false");
    if (label) {
      label.textContent = checked
        ? formatDateInput(form.elements[name].value, "Select date")
        : "No date";
    }
  }

  function setBinarySwitch(form, name, value) {
    form.elements[name + "Mode"].value = value ? "on" : "off";
    syncBinarySwitch(form, name);
  }

  function syncBinarySwitch(form, name) {
    const toggle = form.querySelector('[data-binary-switch="' + name + '"]');
    if (!toggle) return;
    const checked = form.elements[name + "Mode"].value === "on";
    const label = toggle.querySelector("[data-binary-switch-label]");
    toggle.classList.toggle("active", checked);
    toggle.setAttribute("aria-checked", checked ? "true" : "false");
    if (label) {
      label.textContent = checked ? "On" : "Off";
    }
  }

  function openDatePicker(input) {
    if (!input || input.disabled) return;
    if (typeof input.showPicker === "function") {
      input.showPicker();
    } else {
      input.focus();
    }
  }

  function renderDivisionRows(container, rows) {
    container.innerHTML = "";
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "division-empty-row";
      tr.innerHTML = `<td colspan="4">No divisions selected yet.</td>`;
      container.append(tr);
      return;
    }
    rows.forEach((row) => appendDivisionRow(container, row));
  }

  function appendDivisionRow(container, row) {
    const tr = document.createElement("tr");
    tr.dataset.division = row.division;
    const commentStatus = normalizeCommentStatus(row);
    const additionalPhoto = normalizeStoredImage(row.additionalPhoto);
    const countries = normalizeCountries(row.countries);
    tr.innerHTML = `
      <td><span class="division-name">${escapeHtml(row.division)}</span></td>
      <td>
        <select data-division-field="commentsStatus" aria-label="Comment status">
          <option value="awaited">Awaited</option>
          <option value="cleared">Cleared</option>
          <option value="partial">Partial</option>
          <option value="declined">Declined</option>
        </select>
      </td>
      <td>
        <input type="hidden" data-division-field="additionalPhoto" value="${escapeHtml(additionalPhoto ? JSON.stringify(additionalPhoto) : "")}">
        <div class="division-photo-tools">
          <label class="secondary-button compact-button">
            Capture Photo
            <input type="file" accept="image/*" capture="environment" data-division-photo-input>
          </label>
          <button class="danger-button compact-button" type="button" data-remove-division-photo hidden>Remove Photo</button>
          <div class="division-photo-preview" data-division-photo-preview></div>
        </div>
      </td>
      <td>
        <input type="hidden" data-division-field="countries" value="${escapeHtml(JSON.stringify(countries))}">
        <div class="country-chip-wrap" data-country-chip-wrap></div>
      </td>
    `;
    container.append(tr);
    tr.querySelector('[data-division-field="commentsStatus"]').value = commentStatus;
    renderDivisionPhotoPreview(tr, additionalPhoto);
    renderCountryChips(tr, countries);
  }

  function readDivisions(form) {
    return Array.from(form.querySelectorAll("#divisionRows tr"))
      .filter((row) => row.dataset.division)
      .map((row) => {
        const additionalPhotoValue = row.querySelector('[data-division-field="additionalPhoto"]').value;
        let additionalPhoto = null;
        try {
          additionalPhoto = normalizeStoredImage(JSON.parse(additionalPhotoValue || "null"));
        } catch (error) {
          additionalPhoto = null;
        }
        return {
          division: String(row.dataset.division || "").trim(),
          commentsStatus: row.querySelector('[data-division-field="commentsStatus"]').value,
          comments: "",
          additionalPhoto,
          countries: readDivisionCountries(row)
        };
      })
      .filter((row) => row.division);
  }

  function renderDivisionCommentDetail(row) {
    const status = normalizeCommentStatus(row);
    if (status === "awaited") return "Awaited";
    if (status === "cleared") return "Cleared";
    if (status === "declined") return "Declined";
    if (status === "partial") return "Partial";
    return "Awaited";
  }

  function renderDivisionPhotoPreview(row, image) {
    const preview = row.querySelector("[data-division-photo-preview]");
    const removeButton = row.querySelector("[data-remove-division-photo]");
    if (!preview) return;
    if (removeButton) {
      removeButton.hidden = !(image && image.dataUrl);
    }
    preview.innerHTML = image && image.dataUrl
      ? `<figure class="division-photo-thumb"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "Captured division photo")}"><figcaption>${escapeHtml(image.name || "Captured photo")}</figcaption></figure>`
      : "";
  }

  function readDivisionCountries(row) {
    const input = row.querySelector('[data-division-field="countries"]');
    try {
      return normalizeCountries(JSON.parse(input.value || "[]"));
    } catch (error) {
      return [];
    }
  }

  function renderCountryChips(row, countries) {
    const input = row.querySelector('[data-division-field="countries"]');
    const wrap = row.querySelector("[data-country-chip-wrap]");
    const normalized = normalizeCountries(countries);
    input.value = JSON.stringify(normalized);
    wrap.innerHTML = normalized.length
      ? normalized.map((country, index) => `
          <button type="button" class="country-chip color-${country.color}" data-country-index="${index}" title="Tap to cycle color">
            ${escapeHtml(country.name)}
          </button>
        `).join("")
      : `<span class="hint">No countries imported.</span>`;
  }

  function cycleCountryColor(row, index) {
    const countries = readDivisionCountries(row);
    if (!countries[index]) return;
    const currentIndex = COUNTRY_COLOR_ORDER.indexOf(countries[index].color || "none");
    countries[index].color = COUNTRY_COLOR_ORDER[(currentIndex + 1) % COUNTRY_COLOR_ORDER.length];
    renderCountryChips(row, countries);
  }

  function parseDivisionJson(text) {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => ({
          division: String((row && row.division) || "").trim(),
          countries: normalizeCountries(row && row.countries)
        }))
        .filter((row) => row.division);
    }

    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed)
        .map(([division, countries]) => ({
          division: String(division || "").trim(),
          countries: normalizeCountries(countries)
        }))
        .filter((row) => row.division);
    }

    throw new Error("Use either an array of division objects or an object keyed by division.");
  }

  function createLocalStoredImage(file) {
    return compressImage(file).catch((error) => {
      console.warn("Image compression failed; saving original image.", error);
      return readOriginalImage(file);
    });
  }

  function readOriginalImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name,
        type: file.type,
        originalType: file.type,
        originalSize: file.size || 0,
        compressed: false,
        dataUrl: reader.result
      });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to load image for compression."));
      image.src = src;
    });
  }

  async function compressImage(file) {
    const original = await readOriginalImage(file);
    if (!file.type.startsWith("image/")) {
      return original;
    }

    const image = await loadImageElement(original.dataUrl);
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, IMAGE_MAX_SIZE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      return original;
    }

    canvas.width = width;
    canvas.height = height;
    context.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY);
    const compressedSize = Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
    return {
      name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
      type: "image/jpeg",
      size: compressedSize,
      originalName: file.name,
      originalType: file.type,
      originalSize: file.size || 0,
      width,
      height,
      compressed: true,
      dataUrl
    };
  }

  function normalizeImages(source) {
    const rawImages = Array.isArray(source.images) ? source.images : (source.image ? [source.image] : []);
    return rawImages
      .map((image) => normalizeStoredImage(image, "Uploaded image"))
      .filter(Boolean);
  }

  function updateImagePreview(images) {
    const preview = document.getElementById("imagePreview");
    const removeButton = document.getElementById("removeImageButton");
    const visibleImages = Array.isArray(images) ? images.filter((image) => image && image.dataUrl) : [];

    preview.hidden = !visibleImages.length;
    removeButton.hidden = !visibleImages.length;
    preview.innerHTML = visibleImages.map((image) => `
      <figure class="image-preview">
        <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "Uploaded proposal reference")}">
        <figcaption>${escapeHtml(image.name || "Uploaded image")}</figcaption>
      </figure>
    `).join("");
  }

  function readForm(form, images) {
    const normalizedImages = normalizeImages({ images });
    const deadline = form.elements.deadlineMode.value === "date" ? form.elements.deadline.value : "";
    const timelineDate = form.elements.timelineDateMode.value === "date" ? form.elements.timelineDate.value : "";
    return {
      title: form.elements.title.value.trim(),
      description: form.elements.description.value.trim(),
      def: form.elements.defMode.value === "on",
      timelineType: timelineDate ? "date" : "none",
      timelineDate,
      deadline,
      notes: form.elements.notes.value.trim(),
      divisions: readDivisions(form),
      images: normalizedImages,
      status: form.elements.status.value
    };
  }

  function textOrFallback(value, fallback) {
    return value && value.trim() ? value : fallback;
  }

  function renderDetail(id) {
    const proposal = getProposal(id);
    if (!proposal) {
      renderNotFound();
      return;
    }

    app.innerHTML = "";
    app.append(document.getElementById("detailTemplate").content.cloneNode(true));

    document.title = proposal.title + " - Proposal Manager";
    document.getElementById("detailTitle").textContent = textOrFallback(proposal.title, "Untitled Proposal");
    document.getElementById("detailDef").textContent = proposal.def ? "On" : "Off";
    document.getElementById("detailStatus").textContent = proposal.status;
    document.getElementById("detailDeadline").textContent = formatDateInput(proposal.deadline, "None");
    document.getElementById("detailDate").textContent = formatDateInput(proposal.timelineDate, "None");
    document.getElementById("detailDescription").textContent = textOrFallback(proposal.description, "No extracted text available.");

    const detailNotesSection = document.getElementById("detailNotesSection");
    const detailNotes = document.getElementById("detailNotes");
    if (proposal.notes && proposal.notes.trim()) {
      detailNotesSection.hidden = false;
      detailNotes.textContent = proposal.notes;
    }

    const detailImages = normalizeImages(proposal);
    const detailImageSection = document.getElementById("detailImageSection");
    const detailImageList = document.getElementById("detailImages");
    if (detailImages.length) {
      detailImageSection.hidden = false;
      detailImageList.innerHTML = detailImages.map((image) => `
        <figure class="document-image-item">
          <img class="document-image" src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "Uploaded proposal reference")}">
          <figcaption>${escapeHtml(image.name || "Uploaded image")}</figcaption>
        </figure>
      `).join("");
    }

    const detailTableSection = document.getElementById("detailTableSection");
    const detailDivisionRows = document.getElementById("detailDivisionRows");
    const detailDivisionEmpty = document.getElementById("detailDivisionEmpty");

    detailTableSection.hidden = false;

    function renderDivisionTable() {
      const selectedRows = (proposal.divisions || []).filter((row) => row.division);
      detailDivisionRows.innerHTML = selectedRows.map((row, index) => {
        const status = normalizeCommentStatus(row);
        const statusLabel = renderDivisionCommentDetail(row);
        const hasPhoto = Boolean(row.additionalPhoto && row.additionalPhoto.dataUrl);
        const hasCountries = normalizeCountries(row.countries).length > 0;
        return `
          <div class="division-row">
            <span class="division-name">${escapeHtml(row.division)}</span>
            <span class="division-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
            ${hasPhoto
              ? `<button class="division-action photo" type="button" data-detail-photo="${index}">Photo</button>`
              : `<span class="division-action none">None</span>`}
            ${hasCountries
              ? `<button class="division-action list" type="button" data-detail-countries="${index}">List</button>`
              : `<span class="division-action none">None</span>`}
          </div>
        `;
      }).join("");
      detailDivisionEmpty.hidden = selectedRows.length > 0;
    }

    renderDivisionTable();

    const detailPreviewModal = document.getElementById("detailPreviewModal");
    const detailPreviewTitle = document.getElementById("detailPreviewTitle");
    const detailPreviewBody = document.getElementById("detailPreviewBody");
    const closeDetailPreviewModal = document.getElementById("closeDetailPreviewModal");

    function openDetailPreview(title, content) {
      detailPreviewTitle.textContent = title;
      detailPreviewBody.innerHTML = content;
      detailPreviewModal.hidden = false;
    }

    function closeDetailPreview() {
      detailPreviewModal.hidden = true;
      detailPreviewTitle.textContent = "";
      detailPreviewBody.innerHTML = "";
    }

    detailDivisionRows.addEventListener("click", (event) => {
      const photoButton = event.target.closest("[data-detail-photo]");
      const countryButton = event.target.closest("[data-detail-countries]");
      const selectedRows = (proposal.divisions || []).filter((row) => row.division);

      if (photoButton) {
        const row = selectedRows[Number(photoButton.dataset.detailPhoto)];
        const image = row ? normalizeStoredImage(row.additionalPhoto) : null;
        if (image && image.dataUrl) {
          openDetailPreview(
            image.name || "Division photo",
            `<figure class="detail-preview-figure"><img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name || "Captured division photo")}"><figcaption>${escapeHtml(image.name || "Captured photo")}</figcaption></figure>`
          );
        }
      }

      if (countryButton) {
        const row = selectedRows[Number(countryButton.dataset.detailCountries)];
        const countries = row ? normalizeCountries(row.countries) : [];
        if (countries.length) {
          openDetailPreview(
            `${row.division} countries`,
            `<div class="detail-preview-countries">` + countries.map((country) => `
              <span class="country-chip color-${country.color}">${escapeHtml(country.name)}</span>
            `).join("") + `</div>`
          );
        }
      }
    });

    closeDetailPreviewModal.addEventListener("click", closeDetailPreview);
    detailPreviewModal.addEventListener("click", (event) => {
      if (event.target === detailPreviewModal) {
        closeDetailPreview();
      }
    });

    document.getElementById("editDetailButton").href = "#/edit/" + encodeURIComponent(proposal.id);
    document.getElementById("pdfButton").addEventListener("click", () => window.print());
    document.getElementById("deleteDetailButton").addEventListener("click", () => {
      if (confirm("Delete this proposal permanently?")) {
        proposals = proposals.filter((item) => item.id !== proposal.id);
        saveProposals();
        navigate("#/");
      }
    });
  }

  function renderNotFound() {
    app.innerHTML = `
      <section class="panel not-found">
        <p class="eyebrow">Not found</p>
        <h1>We could not find that proposal.</h1>
        <p>It may have been deleted or the link may be incorrect.</p>
        <a class="primary-button" href="#/">Back to Dashboard</a>
      </section>
    `;
  }

  function downloadBackup() {
    const payload = {
      exportedAt: todayISO(),
      app: "Proposal Manager",
      version: 1,
      proposals,
      divisionOptions
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "proposal-manager-backup.json";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const imported = Array.isArray(data) ? data : data.proposals;
        if (!Array.isArray(imported)) throw new Error("Invalid backup format");
        proposals = imported.map(normalizeProposal);
        divisionOptions = data && "divisionOptions" in data
          ? normalizeDivisionOptions(data.divisionOptions)
          : collectDivisionOptions(proposals);
        localStorage.removeItem(LEGACY_DRAFT_KEY);
        saveDivisionOptions();
        saveProposals();
        render();
        alert("Backup imported successfully.");
      } catch (error) {
        alert("That file does not look like a valid Proposal Manager backup.");
      } finally {
        importInput.value = "";
      }
    };
    reader.readAsText(file);
  }

  backupButton.addEventListener("click", downloadBackup);
  importInput.addEventListener("change", () => {
    const file = importInput.files && importInput.files[0];
    if (file && confirm("Importing will replace current proposals. Continue?")) {
      importBackup(file);
    } else {
      importInput.value = "";
    }
  });
  window.addEventListener("hashchange", render);

  render();
  initializeFirebase();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => {
        console.warn("Service worker registration failed", error);
      });
    });
  }

  function renderChoicePanel(container, values, config) {
    container.innerHTML = "";
    if (!values.length && config.emptyMessage) {
      const empty = document.createElement("span");
      empty.className = "choice-panel-empty";
      empty.textContent = config.emptyMessage;
      container.append(empty);
      return;
    }

    values.forEach((value) => {
      const button = document.createElement("button");
      const label = config.labelFor ? config.labelFor(value) : value;
      const selected = config.selectedValues.has(value);
      button.type = "button";
      button.className = "choice-chip" + (selected ? " selected" : "");
      button.textContent = label;
      button.title = config.titleFor ? config.titleFor(value) : label;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.addEventListener("click", () => config.onChange(value));
      container.append(button);
    });
  }

  function syncProposalDivisions(rows, selectedValues) {
    const rowMap = new Map();
    (rows || []).forEach((row) => {
      const division = String(row.division || "").trim();
      if (!division || rowMap.has(division)) return;
      rowMap.set(division, {
        division,
        commentsStatus: normalizeCommentStatus(row),
        comments: "",
        additionalPhoto: normalizeStoredImage(row.additionalPhoto),
        countries: normalizeCountries(row.countries)
      });
    });

    const selected = Array.from(selectedValues);
    return divisionOptions
      .filter((division) => selected.includes(division))
      .map((division) => rowMap.get(division) || {
        division,
        commentsStatus: "awaited",
        comments: "",
        additionalPhoto: null,
        countries: []
      });
  }
})();
