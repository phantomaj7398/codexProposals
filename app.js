(function () {
  "use strict";

  const STORAGE_KEY = "proposal-manager:proposals:v1";
  const DRAFT_KEY = "proposal-manager:draft:v1";
  const DIVISION_OPTIONS_KEY = "proposal-manager:division-options:v1";
  const STATUSES = ["Pending", "Completed", "For information only"];
  const SORT_OPTIONS = [
    { value: "date-desc", label: "Newest first" },
    { value: "date-asc", label: "Oldest first" },
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

  let proposals = loadProposals();
  let divisionOptions = loadDivisionOptions();

  function uid() {
    if (window.crypto && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return "proposal-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function todayISO() {
    return new Date().toISOString();
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    }).format(new Date(value));
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

  function normalizeProposal(proposal) {
    const now = todayISO();
    const divisions = Array.isArray(proposal.divisions) ? proposal.divisions : [];
    const rawImages = Array.isArray(proposal.images) ? proposal.images : (proposal.image ? [proposal.image] : []);
    const images = rawImages
      .filter((image) => image && image.dataUrl)
      .map((image) => ({
        name: String(image.name || "Uploaded image"),
        type: String(image.type || "image/*"),
        dataUrl: String(image.dataUrl)
      }));
    const image = images[0] || null;
    const legacyTimeline = String(proposal.timeline || "").trim();
    const inferredDate = /^\d{4}-\d{2}-\d{2}$/.test(legacyTimeline) ? legacyTimeline : "";
    const timelineType = proposal.timelineType === "date" || inferredDate ? "date" : "none";

    return {
      id: proposal.id || uid(),
      title: String(proposal.title || "").trim(),
      description: String(proposal.description || "").trim(),
      timelineType,
      timelineDate: timelineType === "date" ? String(proposal.timelineDate || inferredDate).trim() : "",
      notes: String(proposal.notes || "").trim(),
      divisions: divisions.map((row) => ({
        division: String(row.division || row.divisions || "").trim(),
        comments: String(row.comments || "").trim(),
        additionalComments: String(row.additionalComments || "").trim()
      })),
      images,
      image,
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
  }

  function syncStoredDivisionOptions() {
    divisionOptions = normalizeDivisionOptions(divisionOptions);
    saveDivisionOptions();
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
          proposal.timelineDate,
          proposal.notes,
          ...proposal.divisions.flatMap((row) => [
            row.division,
            row.comments,
            row.additionalComments
          ])
        ].join(" ").toLowerCase();
        return (!query || searchable.includes(query)) && activeStatuses.includes(proposal.status);
      });

      visible = visible.sort((a, b) => {
        if (sort === "date-asc") return new Date(a.updatedAt) - new Date(b.updatedAt);
        if (sort === "title-asc") return a.title.localeCompare(b.title);
        if (sort === "title-desc") return b.title.localeCompare(a.title);
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });

      proposalList.innerHTML = "";
      resultCount.textContent = visible.length + (visible.length === 1 ? " shown" : " shown");
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
            <span>${formatDate(proposal.updatedAt)}</span>
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
    const timelineDateField = document.getElementById("timelineDateField");
    const divisionRows = document.getElementById("divisionRows");
    const formDivisionPanel = document.getElementById("formDivisionPanel");
    const formDivisionEmpty = document.getElementById("formDivisionEmpty");
    const editFormDivisionsButton = document.getElementById("editFormDivisionsButton");
    const formDivisionModal = document.getElementById("formDivisionModal");
    const formDivisionOptionList = document.getElementById("formDivisionOptionList");
    const formNewDivisionInput = document.getElementById("formNewDivisionInput");
    const addFormDivisionOption = document.getElementById("addFormDivisionOption");
    const saveFormDivisionOptions = document.getElementById("saveFormDivisionOptions");
    const cancelFormDivisionModal = document.getElementById("cancelFormDivisionModal");
    const closeFormDivisionModal = document.getElementById("closeFormDivisionModal");
    const removeImageButton = document.getElementById("removeImageButton");
    const draft = !existing ? loadDraft() : null;
    const data = existing || draft || {};
    let currentImages = normalizeImages(data);

    document.getElementById("formMode").textContent = existing ? "Edit proposal" : "New proposal";
    document.getElementById("formTitle").textContent = existing ? "Edit Proposal" : "Create Proposal";
    deleteButton.hidden = !existing;

    form.elements.title.value = data.title || "";
    form.elements.description.value = data.description || "";
    form.elements.timelineType.value = data.timelineType || "none";
    form.elements.timelineDate.value = data.timelineDate || "";
    form.elements.notes.value = data.notes || "";
    form.elements.status.value = data.status || "Pending";
    syncTimelineDateVisibility(form, timelineDateField);
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
        } else {
          localStorage.setItem(DRAFT_KEY, JSON.stringify(formData));
        }
        autosaveState.textContent = "Autosaved";
      }, 350);
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = readForm(form, currentImages);
      if (!formData.title) {
        alert("Please add a proposal title.");
        return;
      }
      if (formData.timelineType === "date" && !formData.timelineDate) {
        alert("Please choose a timeline date or select no fixed date.");
        return;
      }

      if (existing) {
        Object.assign(existing, formData, { updatedAt: todayISO() });
      } else {
        const now = todayISO();
        proposals.unshift(normalizeProposal({
          ...formData,
          id: uid(),
          createdAt: now,
          updatedAt: now
        }));
        localStorage.removeItem(DRAFT_KEY);
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

    form.elements.timelineType.addEventListener("change", () => {
      syncTimelineDateVisibility(form, timelineDateField);
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

    editFormDivisionsButton.addEventListener("click", openFormDivisionModal);
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
    formDivisionModal.addEventListener("click", (event) => {
      if (event.target === formDivisionModal) {
        closeFormDivisionEditor();
      }
    });

    removeImageButton.addEventListener("click", () => {
      currentImages = [];
      updateImagePreview(currentImages);
      form.dispatchEvent(new Event("input", { bubbles: true }));
    });

    ocrUpload.addEventListener("change", async () => {
      const files = Array.from(ocrUpload.files || []);
      if (!files.length) return;

      try {
        const storedImages = await Promise.all(files.map(createStoredImage));
        currentImages = currentImages.concat(storedImages);
        updateImagePreview(currentImages);
        form.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) {
        alert("Could not save those images. Please try different files.");
        ocrUpload.value = "";
        return;
      }

      if (!window.Tesseract || !window.Tesseract.recognize) {
        const missingScriptNote = "\n\n[OCR unavailable: Tesseract.js could not be loaded. Check your internet connection, then try again.]";
        form.elements.description.value = (form.elements.description.value || "") + missingScriptNote;
        form.dispatchEvent(new Event("input", { bubbles: true }));
        ocrUpload.value = "";
        return;
      }

      ocrUpload.disabled = true;
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
      ocrUpload.value = "";
      if (autosaveState.textContent.startsWith("OCR") || autosaveState.textContent.includes("loading")) {
        autosaveState.textContent = "OCR complete";
      }
    });
  }

  function emptyDivisionRow() {
    return {
      division: "",
      comments: "",
      additionalComments: ""
    };
  }

  function renderDivisionRows(container, rows) {
    container.innerHTML = "";
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.className = "division-empty-row";
      tr.innerHTML = `<td colspan="3">No divisions selected yet.</td>`;
      container.append(tr);
      return;
    }
    rows.forEach((row) => appendDivisionRow(container, row));
  }

  function appendDivisionRow(container, row) {
    const tr = document.createElement("tr");
    tr.dataset.division = row.division;
    tr.innerHTML = `
      <td><span class="division-name">${escapeHtml(row.division)}</span></td>
      <td><textarea data-division-field="comments" rows="2" placeholder="Comments">${escapeHtml(row.comments)}</textarea></td>
      <td><textarea data-division-field="additionalComments" rows="2" placeholder="Additional comments">${escapeHtml(row.additionalComments)}</textarea></td>
    `;
    container.append(tr);
  }

  function readDivisions(form) {
    return Array.from(form.querySelectorAll("#divisionRows tr"))
      .filter((row) => row.dataset.division)
      .map((row) => ({
        division: String(row.dataset.division || "").trim(),
        comments: row.querySelector('[data-division-field="comments"]').value.trim(),
        additionalComments: row.querySelector('[data-division-field="additionalComments"]').value.trim()
      }))
      .filter((row) => row.division);
  }

  function syncTimelineDateVisibility(form, container) {
    const hasDate = form.elements.timelineType.value === "date";
    container.hidden = !hasDate;
    if (!hasDate) {
      form.elements.timelineDate.value = "";
    }
  }

  function createStoredImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name,
        type: file.type,
        dataUrl: reader.result
      });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function normalizeImages(source) {
    const rawImages = Array.isArray(source.images) ? source.images : (source.image ? [source.image] : []);
    return rawImages
      .filter((image) => image && image.dataUrl)
      .map((image) => ({
        name: String(image.name || "Uploaded image"),
        type: String(image.type || "image/*"),
        dataUrl: String(image.dataUrl)
      }));
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
    return {
      title: form.elements.title.value.trim(),
      description: form.elements.description.value.trim(),
      timelineType: form.elements.timelineType.value,
      timelineDate: form.elements.timelineType.value === "date" ? form.elements.timelineDate.value : "",
      notes: form.elements.notes.value.trim(),
      divisions: readDivisions(form),
      images: normalizedImages,
      image: normalizedImages[0] || null,
      status: form.elements.status.value
    };
  }

  function loadDraft() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    } catch (error) {
      return null;
    }
  }

  function textOrFallback(value, fallback) {
    return value && value.trim() ? value : fallback;
  }

  function getTimelineLabel(proposal) {
    if (proposal.timelineType === "date" && proposal.timelineDate) {
      return formatDate(proposal.timelineDate + "T00:00:00");
    }
    return "No fixed date";
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
    const detailDate = document.getElementById("detailDate");
    detailDate.textContent = formatDate(proposal.updatedAt);
    document.getElementById("detailTitle").textContent = textOrFallback(proposal.title, "Untitled Proposal");
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
      detailDate.textContent = formatDate(proposal.updatedAt);
      detailDivisionRows.innerHTML = selectedRows.map((row) => `
        <tr>
          <td>${escapeHtml(row.division)}</td>
          <td>${escapeHtml(row.comments)}</td>
          <td>${escapeHtml(row.additionalComments)}</td>
        </tr>
      `).join("");
      detailDivisionEmpty.hidden = selectedRows.length > 0;
    }

    renderDivisionTable();

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
        comments: String(row.comments || "").trim(),
        additionalComments: String(row.additionalComments || "").trim()
      });
    });

    const selected = Array.from(selectedValues);
    return divisionOptions
      .filter((division) => selected.includes(division))
      .map((division) => rowMap.get(division) || {
        division,
        comments: "",
        additionalComments: ""
      });
  }
})();
