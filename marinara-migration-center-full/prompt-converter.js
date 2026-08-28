(() => {
  "use strict";

  const hostMarinara = marinara;
  const core = globalThis.MarinaraPromptConverterCore;
  const chatCore = globalThis.MarinaraChatExtractionCore;
  const mergeCore = globalThis.MarinaraLorebookMergeCore;
  const assetCore = globalThis.MarinaraAssetSaveCore;
  const repairPrompts = globalThis.MarinaraJsonRepairPrompts;
  const SETTINGS_STORAGE_KEY = "promptConverterSettings";
  const SESSION_STORAGE_KEY = "promptConverterDraftSession";
  const SAVED_DRAFTS_STORAGE_KEY = "promptConverterSavedDrafts";
  const SESSION_SCHEMA_VERSION = 1;
  const SAVED_DRAFT_SCHEMA_VERSION = 1;
  const SESSION_SAVE_DEBOUNCE_MS = 600;
  const SESSION_STORAGE_BUDGET_BYTES = 900_000;
  const NON_TEXT_PROVIDERS = new Set(["image_generation", "video_generation", "audio"]);
  const migrationCenter = globalThis.MarinaraMigrationCenter || {};
  globalThis.MarinaraMigrationCenter = migrationCenter;
  let modalRoot = null;
  let modalCleanup = null;

  if (!core || !chatCore || !mergeCore || !assetCore || !repairPrompts) {
    hostMarinara.log.error("Prompt Converter core modules are unavailable");
    return;
  }

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const storedString = (value) => (typeof value === "string" ? value : "");
  const storedStringArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  const cloneJson = (value) => JSON.parse(JSON.stringify(value));
  const SAVE_STATUSES = new Set(["idle", "pending", "success", "failed", "skipped"]);

  function normalizeStoredMergeDecisions(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
      if (!isRecord(item)) return null;
      let finalEntry = null;
      if (isRecord(item.finalEntry)) {
        finalEntry = {
          name: storedString(item.finalEntry.name),
          content: storedString(item.finalEntry.content),
          keys: storedStringArray(item.finalEntry.keys),
          secondaryKeys: storedStringArray(item.finalEntry.secondaryKeys),
          constant: item.finalEntry.constant === true,
          selective: item.finalEntry.selective === true,
        };
      }
      return {
        action: assetCore.normalizeMergeAction(item.action),
        targetEntryId: storedString(item.targetEntryId),
        suggestedTargetId: storedString(item.suggestedTargetId),
        confirmed: item.confirmed === true,
        finalEntry,
        reason: storedString(item.reason),
        warnings: storedStringArray(item.warnings),
      };
    });
  }

  function normalizeStoredAssetResult(value) {
    if (!isRecord(value) || !storedString(value.fingerprint)) return null;
    const normalizePart = (item) => {
      const part = isRecord(item) ? item : {};
      const storedStatus = SAVE_STATUSES.has(part.status) ? part.status : "idle";
      const interrupted = storedStatus === "pending";
      return {
        status: interrupted ? "failed" : storedStatus,
        id: storedString(part.id),
        name: storedString(part.name),
        error: interrupted ? "이전 저장 실행이 완료되지 않았습니다. 재시도하세요." : storedString(part.error),
      };
    };
    const entryResults = Array.isArray(value.entryResults)
      ? value.entryResults.flatMap((item) => {
          if (!isRecord(item) || !storedString(item.key)) return [];
          return [{
            key: storedString(item.key),
            type: item.type === "update" ? "update" : item.type === "skip" ? "skip" : "create",
            name: storedString(item.name),
            targetEntryId: storedString(item.targetEntryId),
            id: storedString(item.id),
            status: item.status === "pending" ? "failed" : SAVE_STATUSES.has(item.status) ? item.status : "idle",
            error: item.status === "pending"
              ? "이전 저장 실행이 완료되지 않았습니다. 재시도하세요."
              : storedString(item.error),
          }];
        })
      : [];
    return {
      fingerprint: storedString(value.fingerprint),
      strategy: assetCore.SAVE_STRATEGIES.includes(value.strategy) ? value.strategy : "new",
      character: normalizePart(value.character),
      lorebook: normalizePart(value.lorebook),
      link: normalizePart(value.link),
      entryResults,
      completedAt: storedString(value.completedAt),
    };
  }

  function normalizeStoredSession(value) {
    if (!isRecord(value) || value.version !== SESSION_SCHEMA_VERSION) return null;
    let draft = null;
    const legacyIntegration = isRecord(value.draft?.lorebookIntegration) ? value.draft.lorebookIntegration : {};
    if (value.draft) {
      try {
        draft = core.normalizeDraft(value.draft, { allowEmpty: true });
      } catch {
        draft = null;
      }
    }
    const sources = isRecord(value.sources) ? value.sources : {};
    const importedReference = isRecord(value.importedReference)
      ? {
          name: storedString(value.importedReference.name),
          messageCount: Math.max(0, Math.round(Number(value.importedReference.messageCount) || 0)),
        }
      : null;
    return {
      version: SESSION_SCHEMA_VERSION,
      view: value.view === "review" && draft ? "review" : "input",
      inputMode: value.inputMode === "separated" ? "separated" : "combined",
      conversionMode: value.conversionMode === "normalize" ? "normalize" : "preserve",
      lorebookSourceEnabled: value.lorebookSourceEnabled === true,
      lorebookSource: storedString(value.lorebookSource),
      sources: {
        combined: storedString(sources.combined),
        character: storedString(sources.character),
        worldLore: storedString(sources.worldLore),
        systemStyle: storedString(sources.systemStyle),
        other: storedString(sources.other),
      },
      selectedConnectionId: storedString(value.selectedConnectionId),
      draft,
      excludedEntries: Array.isArray(value.excludedEntries)
        ? value.excludedEntries.filter((item) => Number.isInteger(item) && item >= 0)
        : [],
      excludedPresetCandidates: Array.isArray(value.excludedPresetCandidates)
        ? value.excludedPresetCandidates.filter((item) => Number.isInteger(item) && item >= 0)
        : [],
      chatReferenceEnabled: value.chatReferenceEnabled === true,
      chatSourceMode: value.chatSourceMode === "chat" ? "chat" : "import",
      selectedChatId: storedString(value.selectedChatId),
      chatRangeMode: value.chatRangeMode === "all" ? "all" : "recent",
      chatRecentTurns: Math.max(1, Math.round(Number(value.chatRecentTurns) || 1)),
      includeRelationshipDevelopment: value.includeRelationshipDevelopment !== false,
      chatDerivedPrompt: storedString(value.chatDerivedPrompt),
      chatDerivedDirty: value.chatDerivedDirty === true,
      chatAnalysisDone: value.chatAnalysisDone === true,
      chatAnalysisWarnings: storedStringArray(value.chatAnalysisWarnings),
      chatAnalysisMessage: storedString(value.chatAnalysisMessage),
      importedReference,
      lorebookSaveStrategy: assetCore.SAVE_STRATEGIES.includes(value.lorebookSaveStrategy)
        ? value.lorebookSaveStrategy
        : assetCore.SAVE_STRATEGIES.includes(legacyIntegration.strategy)
          ? legacyIntegration.strategy
          : "new",
      selectedLorebookId: storedString(value.selectedLorebookId),
      mergeDecisions: normalizeStoredMergeDecisions(value.mergeDecisions),
      mergeAnalysisStatus: ["success", "stale"].includes(value.mergeAnalysisStatus)
        ? value.mergeAnalysisStatus
        : "idle",
      mergeAnalysisFingerprint: storedString(value.mergeAnalysisFingerprint),
      mergeAnalysisMessage: storedString(value.mergeAnalysisMessage),
      mergeAnalysisWarnings: storedStringArray(value.mergeAnalysisWarnings),
      assetSaveResult: normalizeStoredAssetResult(value.assetSaveResult),
      analysisSettings: isRecord(value.analysisSettings) ? core.normalizeSettings(value.analysisSettings) : null,
      activeSavedDraftId: storedString(value.activeSavedDraftId),
    };
  }

  function normalizeSavedDrafts(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.flatMap((item) => {
      if (!isRecord(item) || item.version !== SAVED_DRAFT_SCHEMA_VERSION) return [];
      const id = storedString(item.id).trim();
      const snapshot = normalizeStoredSession(item.snapshot);
      if (!id || seen.has(id) || !snapshot) return [];
      seen.add(id);
      const storedCreatedAt = storedString(item.createdAt);
      const storedUpdatedAt = storedString(item.updatedAt);
      const createdAt = Number.isFinite(Date.parse(storedCreatedAt)) ? storedCreatedAt : new Date(0).toISOString();
      const updatedAt = Number.isFinite(Date.parse(storedUpdatedAt)) ? storedUpdatedAt : createdAt;
      return [{
        version: SAVED_DRAFT_SCHEMA_VERSION,
        id,
        name: storedString(item.name).trim() || "저장된 초안",
        createdAt,
        updatedAt,
        snapshot: { ...snapshot, activeSavedDraftId: "" },
      }];
    });
  }

  let cachedSettings = core.normalizeSettings();
  let cachedSession = null;
  let cachedSavedDrafts = [];
  const settingsReady = Promise.resolve(hostMarinara.storage?.get?.())
    .then(async (saved) => {
      const storedSettings = saved?.[SETTINGS_STORAGE_KEY];
      cachedSettings = core.normalizeSettings(storedSettings);
      if (isRecord(storedSettings) && JSON.stringify(storedSettings) !== JSON.stringify(cachedSettings)) {
        await hostMarinara.storage.patch({ [SETTINGS_STORAGE_KEY]: cachedSettings }).catch((error) => {
          hostMarinara.log.warn("Legacy Prompt Converter settings could not be migrated", error);
        });
      }
      cachedSession = normalizeStoredSession(saved?.[SESSION_STORAGE_KEY]);
      cachedSavedDrafts = normalizeSavedDrafts(saved?.[SAVED_DRAFTS_STORAGE_KEY]);
      return cachedSettings;
    })
    .catch((error) => {
      hostMarinara.log.warn("Prompt Converter settings could not be loaded", error);
      return cachedSettings;
    });

  function createElement(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = String(options.text);
    if (options.type) element.type = options.type;
    if (options.id) element.id = options.id;
    if (options.htmlFor) element.htmlFor = options.htmlFor;
    if (options.role) element.setAttribute("role", options.role);
    if (options.ariaLabel) element.setAttribute("aria-label", options.ariaLabel);
    return element;
  }

  function iconPath(pathValues, size = 16) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const value of pathValues) {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", value);
      svg.appendChild(path);
    }
    return svg;
  }

  function cloneSettings(value) {
    return core.normalizeSettings(value);
  }

  function createCenterNavigation(activeView, blocked, onNavigate) {
    const navigation = createElement("div", { className: "mc-navigation", role: "tablist", ariaLabel: "마리나라 이식 센터 기능" });
    for (const [view, label] of [
      ["import", "대화 가져오기"],
      ["prompt", "프롬프트 이식"],
      ["workspace", "작업소"],
      ["settings", "설정"],
    ]) {
      const button = createElement("button", { type: "button", text: label, role: "tab" });
      button.dataset.view = view;
      button.setAttribute("aria-selected", String(view === activeView));
      button.tabIndex = view === activeView ? 0 : -1;
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-selected") === "true" || blocked()) return;
        onNavigate(view);
      });
      navigation.append(button);
    }
    return navigation;
  }

  async function apiRequest(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const headers = new Headers(options.headers);
    let body = options.body;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== "string") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(body);
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) headers.set("x-marinara-csrf", "1");
    const fetcher = typeof hostMarinara.fetch === "function" ? hostMarinara.fetch.bind(hostMarinara) : fetch;
    const response = await fetcher(path, { ...options, method, headers, body, cache: "no-store" });
    const text = response.status === 204 ? "" : await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string"
          ? payload.error
          : `Marinara API 요청이 실패했습니다 (${response.status}).`;
      throw new Error(message);
    }
    return payload;
  }

  function isTrue(value) {
    return value === true || value === "true";
  }

  function normalizeConnections(value) {
    const rows = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
    return rows
      .filter(
        (row) =>
          row &&
          typeof row.id === "string" &&
          row.id.trim() &&
          typeof row.provider === "string" &&
          !NON_TEXT_PROVIDERS.has(row.provider) &&
          typeof row.model === "string" &&
          row.model.trim(),
      )
      .map((row) => ({
        id: row.id,
        name: String(row.name || row.id),
        model: row.model,
        provider: row.provider,
        maxContext: Number.isFinite(Number(row.maxContext))
          ? Math.max(4_096, Math.round(Number(row.maxContext)))
          : chatCore.DEFAULT_MAX_CONTEXT,
        preferred: isTrue(row.defaultForAgents) || isTrue(row.isDefault),
      }))
      .sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.name.localeCompare(right.name));
  }

  function createRunId() {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `prompt-converter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function closeModal() {
    const cleanup = modalCleanup;
    modalCleanup = null;
    cleanup?.();
    modalRoot?.remove();
    modalRoot = null;
  }

  function option(value, label) {
    const element = createElement("option", { text: label });
    element.value = value;
    return element;
  }

  function stringList(value) {
    return String(value ?? "")
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function makeField(labelText, control, hint) {
    const field = createElement("label", { className: "pc-field" });
    field.append(createElement("span", { className: "pc-label", text: labelText }), control);
    if (hint) field.append(createElement("small", { text: hint }));
    return field;
  }

  function makeTextInput(value, onInput, options = {}) {
    const input = createElement(options.multiline ? "textarea" : "input");
    if (!options.multiline) input.type = "text";
    input.value = value;
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.rows && input instanceof HTMLTextAreaElement) input.rows = options.rows;
    if (options.className) input.className = options.className;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function setButtonBusy(button, busyText, busy) {
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.idleText || button.textContent;
  }

  function openConverter(initialView = "input") {
    const importedConversationSource = migrationCenter.importedConversationSource || null;
    const restoredSession = cachedSession;
    migrationCenter.closeImport?.();
    closeModal();
    const state = {
      view:
        initialView === "settings"
          ? "settings"
          : initialView === "workspace"
            ? restoredSession?.draft ? "review" : "workspace"
            : "input",
      navigationView: initialView === "settings" ? "settings" : initialView === "workspace" ? "workspace" : "prompt",
      inputMode: restoredSession?.inputMode || "combined",
      conversionMode: restoredSession?.conversionMode || "preserve",
      lorebookSourceEnabled: restoredSession?.lorebookSourceEnabled || false,
      lorebookSource: restoredSession?.lorebookSource || "",
      sources: restoredSession ? { ...restoredSession.sources } : { combined: "", character: "", worldLore: "", systemStyle: "", other: "" },
      connections: [],
      selectedConnectionId: restoredSession?.selectedConnectionId || "",
      status: "loading_connections",
      statusMessage: "LLM 연결을 불러오는 중입니다.",
      draft: restoredSession?.draft ? core.normalizeDraft(restoredSession.draft, { allowEmpty: true }) : null,
      rawResponse: "",
      repairResponse: "",
      excludedEntries: new Set(restoredSession?.excludedEntries || []),
      excludedPresetCandidates: new Set(restoredSession?.excludedPresetCandidates || []),
      activeRunId: "",
      activeRequest: 0,
      abortRequested: false,
      settings: cloneSettings(cachedSettings),
      settingsDraft: initialView === "settings" ? cloneSettings(cachedSettings) : null,
      settingsLoaded: false,
      settingsReturnView: restoredSession?.view || "input",
      settingsReturnNavigationView: initialView === "workspace" ? "workspace" : "prompt",
      settingsMessage: "",
      settingsSaving: false,
      settingsEditorUnlocked: { contentFormattingInstructions: false },
      chatReferenceEnabled: restoredSession?.chatReferenceEnabled || false,
      chatSourceMode: restoredSession?.chatSourceMode || "import",
      importedConversationSource,
      importedReference: restoredSession?.importedReference || null,
      availableChats: [],
      selectedChatId: restoredSession?.selectedChatId || "",
      chatListStatus: "idle",
      chatId: "",
      chatName: "",
      chatTurns: [],
      chatLoadStatus: "loading",
      chatLoadMessage: "대화 내역 참조가 꺼져 있습니다.",
      chatRangeMode: restoredSession?.chatRangeMode || "recent",
      chatRecentTurns: restoredSession?.chatRecentTurns || 1,
      chatRecommendation: null,
      includeRelationshipDevelopment: restoredSession?.includeRelationshipDevelopment ?? true,
      chatDerivedPrompt: restoredSession?.chatDerivedPrompt || "",
      chatDerivedDirty: restoredSession?.chatDerivedDirty || false,
      chatAnalysisDone: restoredSession?.chatAnalysisDone || false,
      chatAnalysisWarnings: [...(restoredSession?.chatAnalysisWarnings || [])],
      chatAnalysisMessage: restoredSession?.chatAnalysisMessage || "",
      lorebookSaveStrategy: restoredSession?.lorebookSaveStrategy || "new",
      lorebooks: [],
      lorebooksStatus: "idle",
      lorebooksMessage: "",
      selectedLorebookId: restoredSession?.selectedLorebookId || "",
      existingEntries: [],
      existingEntriesStatus: "idle",
      existingEntriesMessage: "",
      mergeDecisions: [...(restoredSession?.mergeDecisions || [])],
      mergeAnalysisStatus: restoredSession?.mergeAnalysisStatus || "idle",
      mergeAnalysisFingerprint: restoredSession?.mergeAnalysisFingerprint || "",
      mergeAnalysisMessage: restoredSession?.mergeAnalysisMessage || "",
      mergeAnalysisWarnings: [...(restoredSession?.mergeAnalysisWarnings || [])],
      assetSaveConfirmed: false,
      assetSaving: false,
      assetSaveMessage: "",
      assetSaveResult: restoredSession?.assetSaveResult || null,
      savedDrafts: cloneJson(cachedSavedDrafts),
      savedDraftsOpen: false,
      savedDraftBusy: false,
      savedDraftMessage: "",
      activeSavedDraftId: restoredSession?.activeSavedDraftId || "",
      savedDraftBaselineFingerprint: "",
      sessionHydrated: !!restoredSession,
      sessionTouched: false,
      sessionSaveStatus: restoredSession ? "restored" : "idle",
      sessionSaveMessage: restoredSession ? "마지막 작업을 복원했습니다." : "",
      restoreRangePending: !!restoredSession,
    };

    const root = createElement("div", { className: "pc-overlay" });
    const dialog = createElement("section", { className: "pc-dialog mc-dialog", role: "dialog" });
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "pc-title");
    const header = createElement("header", { className: "pc-header" });
    const headerPrimary = createElement("div", { className: "mc-header-primary" });
    const headingGroup = createElement("div", { className: "pc-heading-group" });
    headingGroup.append(
      createElement("h2", { id: "pc-title", text: "마리나라 이식 센터" }),
      createElement("p", { text: "외부 프롬프트를 초안으로 분류하고 검토한 뒤 캐릭터와 로어북을 저장합니다." }),
    );
    const closeButton = createElement("button", {
      className: "pc-icon-button",
      type: "button",
      text: "×",
      ariaLabel: "마리나라 이식 센터 닫기",
    });
    const helpButton = createElement("button", {
      className: "pc-icon-button",
      type: "button",
      text: "?",
      ariaLabel: "사용법 열기",
    });
    helpButton.title = "사용법";
    helpButton.addEventListener("click", () => migrationCenter.openHelp?.());
    const headerActions = createElement("div", { className: "mc-header-actions" });
    headerActions.append(helpButton, closeButton);
    headerPrimary.append(headingGroup, headerActions);
    const navigation = createCenterNavigation(
      state.navigationView,
      () => isWorking(),
      (view) => {
        if (view === "settings") openSettings();
        else if (view === "prompt") {
          state.settingsDraft = null;
          state.view = "input";
          state.navigationView = "prompt";
          render();
        } else if (view === "workspace") {
          state.settingsDraft = null;
          state.view = state.draft ? "review" : "workspace";
          state.navigationView = "workspace";
          render();
          if (state.draft && state.lorebooksStatus === "idle") void loadLorebooks();
        } else migrationCenter.open?.(view);
      },
    );
    header.append(headerPrimary, navigation);
    const body = createElement("div", { className: "pc-body" });
    const footer = createElement("footer", { className: "pc-footer" });
    dialog.append(header, body, footer);
    root.appendChild(dialog);
    document.body.appendChild(root);
    modalRoot = root;

    const isWorking = () => state.assetSaving || ["analyzing", "analyzing_merge", "extracting_chat", "reducing_chat"].includes(state.status);
    const updateStatus = (status, message) => {
      state.status = status;
      state.statusMessage = message;
    };

    let sessionSaveTimer = null;
    let lastSavedSession = restoredSession ? JSON.stringify(restoredSession) : JSON.stringify(null);
    let lastScheduledSession = "";

    const sessionHasWork = () =>
      Object.values(state.sources).some((value) => value.trim()) ||
      !!state.lorebookSource.trim() ||
      state.lorebookSourceEnabled ||
      !!state.draft ||
      !!state.chatDerivedPrompt.trim() ||
      state.chatReferenceEnabled ||
      state.inputMode !== "combined" ||
      state.conversionMode !== "preserve";

    const buildSessionPayload = () => {
      if (!sessionHasWork()) return null;
      const liveImport = state.importedConversationSource;
      const importedReference = liveImport && Array.isArray(liveImport.messages)
        ? {
            name: typeof liveImport.name === "string" ? liveImport.name : "가져온 대화",
            messageCount: liveImport.messages.length,
          }
        : state.importedReference;
      return {
        version: SESSION_SCHEMA_VERSION,
        view:
          state.draft &&
          (state.navigationView === "workspace" ||
            (state.view === "settings" && state.settingsReturnNavigationView === "workspace"))
            ? "review"
            : "input",
        inputMode: state.inputMode,
        conversionMode: state.conversionMode,
        lorebookSourceEnabled: state.lorebookSourceEnabled,
        lorebookSource: state.lorebookSource,
        sources: { ...state.sources },
        selectedConnectionId: state.selectedConnectionId,
        draft: state.draft,
        excludedEntries: [...state.excludedEntries],
        excludedPresetCandidates: [...state.excludedPresetCandidates],
        chatReferenceEnabled: state.chatReferenceEnabled,
        chatSourceMode: state.chatSourceMode,
        selectedChatId: state.selectedChatId,
        chatRangeMode: state.chatRangeMode,
        chatRecentTurns: state.chatRecentTurns,
        includeRelationshipDevelopment: state.includeRelationshipDevelopment,
        chatDerivedPrompt: state.chatDerivedPrompt,
        chatDerivedDirty: state.chatDerivedDirty,
        chatAnalysisDone: state.chatAnalysisDone,
        chatAnalysisWarnings: [...state.chatAnalysisWarnings],
        chatAnalysisMessage: state.chatAnalysisMessage,
        importedReference,
        lorebookSaveStrategy: state.lorebookSaveStrategy,
        selectedLorebookId: state.selectedLorebookId,
        mergeDecisions: state.mergeDecisions,
        mergeAnalysisStatus: state.mergeAnalysisStatus,
        mergeAnalysisFingerprint: state.mergeAnalysisFingerprint,
        mergeAnalysisMessage: state.mergeAnalysisMessage,
        mergeAnalysisWarnings: [...state.mergeAnalysisWarnings],
        assetSaveResult: state.assetSaveResult,
        analysisSettings: cloneSettings(state.settings),
        activeSavedDraftId: state.activeSavedDraftId,
      };
    };

    const buildSavedDraftSnapshot = () => {
      const payload = buildSessionPayload();
      return payload ? cloneJson({ ...payload, activeSavedDraftId: "" }) : null;
    };

    const savedDraftFingerprint = (snapshot) => {
      return core.savedDraftFingerprint(snapshot);
    };

    const currentSavedDraftDirty = () => {
      const snapshot = buildSavedDraftSnapshot();
      if (!snapshot) return false;
      return core.isSavedDraftDirty(snapshot, state.savedDraftBaselineFingerprint);
    };

    const renderSessionStatus = () => {
      if (!state.sessionSaveMessage) return null;
      const status = createElement("span", { className: "pc-session-status", role: "status", text: state.sessionSaveMessage });
      status.dataset.state = state.sessionSaveStatus;
      return status;
    };

    const persistSession = async (payload, serialized) => {
      if (!state.sessionHydrated || serialized === lastSavedSession) return;
      const bytes = new TextEncoder().encode(serialized).length;
      if (bytes > SESSION_STORAGE_BUDGET_BYTES) {
        state.sessionSaveStatus = "error";
        state.sessionSaveMessage = "자동 저장 실패: 작업 데이터가 확장 저장공간 권장 한도(약 900KB)를 초과했습니다.";
        lastScheduledSession = serialized;
        renderFooter();
        return;
      }
      state.sessionSaveStatus = "saving";
      state.sessionSaveMessage = "작업 자동 저장 중…";
      renderFooter();
      try {
        await hostMarinara.storage.patch({ [SESSION_STORAGE_KEY]: payload });
        cachedSession = normalizeStoredSession(payload);
        lastSavedSession = serialized;
        if (lastScheduledSession === serialized) lastScheduledSession = "";
        state.sessionSaveStatus = payload ? "saved" : "idle";
        state.sessionSaveMessage = payload ? "작업 자동 저장됨" : "작업이 초기화되었습니다.";
      } catch (error) {
        state.sessionSaveStatus = "error";
        state.sessionSaveMessage = `작업 자동 저장 실패: ${error instanceof Error ? error.message : String(error)}`;
      }
      renderFooter();
    };

    const scheduleSessionSave = () => {
      if (!state.sessionHydrated) return;
      const payload = buildSessionPayload();
      const serialized = JSON.stringify(payload);
      if (serialized === lastSavedSession || serialized === lastScheduledSession) return;
      lastScheduledSession = serialized;
      if (sessionSaveTimer !== null) hostMarinara.clearTimeout(sessionSaveTimer);
      sessionSaveTimer = hostMarinara.setTimeout(() => {
        sessionSaveTimer = null;
        void persistSession(JSON.parse(serialized), serialized);
      }, SESSION_SAVE_DEBOUNCE_MS);
    };

    const suggestedSavedDraftName = () => {
      const characterName = state.draft?.character?.name?.trim();
      if (characterName) return characterName;
      return `초안 ${new Date().toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" })}`;
    };

    const promptSavedDraftName = (currentName = "") => {
      const suggestion = currentName || suggestedSavedDraftName();
      if (typeof globalThis.prompt !== "function") return suggestion;
      const value = globalThis.prompt("저장할 초안 이름", suggestion);
      if (value === null) return null;
      return value.trim() || suggestion;
    };

    const persistSavedDrafts = async (drafts) => {
      await hostMarinara.storage.patch({ [SAVED_DRAFTS_STORAGE_KEY]: drafts });
      cachedSavedDrafts = cloneJson(drafts);
      state.savedDrafts = cloneJson(cachedSavedDrafts);
    };

    const saveCurrentDraft = async ({ updateExisting = false } = {}) => {
      if (state.savedDraftBusy || isWorking()) return false;
      const snapshot = buildSavedDraftSnapshot();
      if (!snapshot) {
        state.savedDraftMessage = "저장할 프롬프트 이식 작업이 없습니다.";
        render();
        return false;
      }
      const existing = updateExisting
        ? state.savedDrafts.find((draft) => draft.id === state.activeSavedDraftId)
        : null;
      const name = existing?.name || promptSavedDraftName();
      if (!name) return false;
      const now = new Date().toISOString();
      const record = existing
        ? { ...existing, updatedAt: now, snapshot }
        : {
            version: SAVED_DRAFT_SCHEMA_VERSION,
            id: createRunId(),
            name,
            createdAt: now,
            updatedAt: now,
            snapshot,
          };
      const nextDrafts = existing
        ? state.savedDrafts.map((draft) => draft.id === existing.id ? record : draft)
        : [record, ...state.savedDrafts];
      state.savedDraftBusy = true;
      state.savedDraftMessage = existing ? "초안을 업데이트하는 중입니다." : "초안을 저장하는 중입니다.";
      render();
      try {
        await persistSavedDrafts(nextDrafts);
        state.activeSavedDraftId = record.id;
        state.savedDraftBaselineFingerprint = savedDraftFingerprint(snapshot);
        state.savedDraftMessage = existing ? `“${record.name}”을 업데이트했습니다.` : `“${record.name}”을 저장했습니다.`;
        state.sessionSaveStatus = "saved";
        state.sessionSaveMessage = state.savedDraftMessage;
        scheduleSessionSave();
        return true;
      } catch (error) {
        state.savedDraftMessage = `초안을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
        state.sessionSaveStatus = "error";
        state.sessionSaveMessage = state.savedDraftMessage;
        return false;
      } finally {
        state.savedDraftBusy = false;
        render();
      }
    };

    const renameSavedDraft = async (draftId) => {
      if (state.savedDraftBusy || isWorking()) return;
      const draft = state.savedDrafts.find((item) => item.id === draftId);
      if (!draft) return;
      const name = promptSavedDraftName(draft.name);
      if (!name || name === draft.name) return;
      const nextDrafts = state.savedDrafts.map((item) => item.id === draftId
        ? { ...item, name, updatedAt: new Date().toISOString() }
        : item);
      state.savedDraftBusy = true;
      try {
        await persistSavedDrafts(nextDrafts);
        state.savedDraftMessage = `저장된 초안 이름을 “${name}”(으)로 변경했습니다.`;
      } catch (error) {
        state.savedDraftMessage = `이름을 변경하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        state.savedDraftBusy = false;
        render();
      }
    };

    const deleteSavedDraft = async (draftId) => {
      if (state.savedDraftBusy || isWorking()) return;
      const draft = state.savedDrafts.find((item) => item.id === draftId);
      if (!draft) return;
      if (typeof globalThis.confirm === "function" && !globalThis.confirm(`저장된 초안 “${draft.name}”을 삭제하시겠습니까?`)) return;
      state.savedDraftBusy = true;
      try {
        await persistSavedDrafts(state.savedDrafts.filter((item) => item.id !== draftId));
        if (state.activeSavedDraftId === draftId) {
          state.activeSavedDraftId = "";
          state.savedDraftBaselineFingerprint = "";
          scheduleSessionSave();
        }
        state.savedDraftMessage = `“${draft.name}”을 삭제했습니다.`;
      } catch (error) {
        state.savedDraftMessage = `초안을 삭제하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        state.savedDraftBusy = false;
        render();
      }
    };

    let replacementDialog = null;
    const closeReplacementDialog = (proceed) => {
      if (!replacementDialog) return;
      const { element, resolve, previousFocus } = replacementDialog;
      replacementDialog = null;
      element.remove();
      if (!proceed && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(proceed);
    };

    const guardWorkingReplacement = ({ message, saveLabel, discardLabel }) => {
      if (!currentSavedDraftDirty()) return Promise.resolve(true);
      if (replacementDialog) return Promise.resolve(false);
      return new Promise((resolve) => {
        const overlay = createElement("div", { className: "pc-replace-overlay" });
        const panel = createElement("section", { className: "pc-replace-dialog", role: "alertdialog" });
        panel.setAttribute("aria-modal", "true");
        panel.setAttribute("aria-labelledby", "pc-replace-title");
        panel.setAttribute("aria-describedby", "pc-replace-copy");
        panel.append(
          createElement("h3", { id: "pc-replace-title", text: "현재 작업을 저장하시겠습니까?" }),
          createElement("p", { id: "pc-replace-copy", text: message }),
        );
        const actions = createElement("div", { className: "pc-replace-actions" });
        const cancel = createElement("button", { className: "pc-button pc-button-secondary", type: "button", text: "취소" });
        const discard = createElement("button", { className: "pc-button pc-button-secondary", type: "button", text: discardLabel });
        const save = createElement("button", { className: "pc-button pc-button-primary", type: "button", text: saveLabel });
        cancel.addEventListener("click", () => closeReplacementDialog(false));
        discard.addEventListener("click", () => closeReplacementDialog(true));
        save.addEventListener("click", async () => {
          for (const button of actions.querySelectorAll("button")) button.disabled = true;
          const saved = await saveCurrentDraft({ updateExisting: !!state.activeSavedDraftId });
          if (saved) closeReplacementDialog(true);
          else for (const button of actions.querySelectorAll("button")) button.disabled = false;
        });
        actions.append(cancel, discard, save);
        panel.append(actions);
        overlay.append(panel);
        root.append(overlay);
        replacementDialog = {
          element: overlay,
          resolve,
          previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        };
        save.focus();
      });
    };

    const applySavedDraft = (draft) => {
      const session = normalizeStoredSession(draft?.snapshot);
      if (!session) return;
      state.inputMode = session.inputMode;
      state.conversionMode = session.conversionMode;
      state.lorebookSourceEnabled = session.lorebookSourceEnabled;
      state.lorebookSource = session.lorebookSource;
      state.sources = { ...session.sources };
      state.selectedConnectionId = state.connections.some((connection) => connection.id === session.selectedConnectionId)
        ? session.selectedConnectionId
        : state.connections.find((connection) => connection.preferred)?.id || state.connections[0]?.id || "";
      state.draft = session.draft;
      state.rawResponse = "";
      state.repairResponse = "";
      state.excludedEntries = new Set(session.excludedEntries);
      state.excludedPresetCandidates = new Set(session.excludedPresetCandidates);
      state.chatReferenceEnabled = session.chatReferenceEnabled;
      state.chatSourceMode = session.chatSourceMode;
      state.selectedChatId = session.selectedChatId;
      state.chatRangeMode = session.chatRangeMode;
      state.chatRecentTurns = session.chatRecentTurns;
      state.includeRelationshipDevelopment = session.includeRelationshipDevelopment;
      state.chatDerivedPrompt = session.chatDerivedPrompt;
      state.chatDerivedDirty = session.chatDerivedDirty;
      state.chatAnalysisDone = session.chatAnalysisDone;
      state.chatAnalysisWarnings = [...session.chatAnalysisWarnings];
      state.chatAnalysisMessage = session.chatAnalysisMessage;
      state.importedReference = session.importedReference;
      state.lorebookSaveStrategy = session.lorebookSaveStrategy;
      state.selectedLorebookId = session.selectedLorebookId;
      state.mergeDecisions = [...session.mergeDecisions];
      state.mergeAnalysisStatus = session.mergeAnalysisStatus;
      state.mergeAnalysisFingerprint = session.mergeAnalysisFingerprint;
      state.mergeAnalysisMessage = session.mergeAnalysisMessage;
      state.mergeAnalysisWarnings = [...session.mergeAnalysisWarnings];
      state.assetSaveResult = session.assetSaveResult;
      state.settings = cloneSettings(session.analysisSettings || cachedSettings);
      state.settingsDraft = null;
      state.assetSaveConfirmed = false;
      state.assetSaving = false;
      state.assetSaveMessage = "";
      state.existingEntries = [];
      state.existingEntriesStatus = "idle";
      state.existingEntriesMessage = "";
      state.activeSavedDraftId = draft.id;
      state.savedDraftBaselineFingerprint = savedDraftFingerprint(session);
      state.savedDraftMessage = `“${draft.name}”을 열었습니다.`;
      state.view = session.draft ? "review" : "input";
      state.navigationView = session.draft ? "workspace" : "prompt";
      state.restoreRangePending = true;
      updateStatus("idle", "저장된 초안을 현재 작업으로 복원했습니다.");
      render();
      if (state.chatReferenceEnabled) void loadConversationSource();
      if (state.draft) void loadLorebooks();
    };

    const openSavedDraft = async (draftId) => {
      if (state.savedDraftBusy || isWorking()) return;
      const draft = state.savedDrafts.find((item) => item.id === draftId);
      if (!draft || draft.id === state.activeSavedDraftId && !currentSavedDraftDirty()) return;
      const proceed = await guardWorkingReplacement({
        message: "다른 초안을 열면 현재 작업 내용이 교체됩니다.",
        saveLabel: "저장 후 열기",
        discardLabel: "현재 작업 버리고 열기",
      });
      if (proceed) applySavedDraft(draft);
    };

    const resetSession = async () => {
      if (isWorking()) return;
      const proceed = await guardWorkingReplacement({
        message: "초기화하면 현재 작업 내용이 지워집니다.",
        saveLabel: "저장 후 초기화",
        discardLabel: "현재 작업 버리고 초기화",
      });
      if (!proceed) return;
      state.view = "input";
      state.navigationView = "prompt";
      state.inputMode = "combined";
      state.conversionMode = "preserve";
      state.lorebookSourceEnabled = false;
      state.lorebookSource = "";
      state.sources = { combined: "", character: "", worldLore: "", systemStyle: "", other: "" };
      state.draft = null;
      state.rawResponse = "";
      state.repairResponse = "";
      state.excludedEntries = new Set();
      state.excludedPresetCandidates = new Set();
      state.chatReferenceEnabled = false;
      state.chatSourceMode = "import";
      state.selectedChatId = "";
      state.chatRangeMode = "recent";
      state.chatRecentTurns = 1;
      state.includeRelationshipDevelopment = true;
      state.chatDerivedPrompt = "";
      state.chatDerivedDirty = false;
      state.chatAnalysisDone = false;
      state.chatAnalysisWarnings = [];
      state.chatAnalysisMessage = "";
      state.importedReference = null;
      state.lorebooks = [];
      state.lorebooksStatus = "idle";
      state.lorebooksMessage = "";
      state.lorebookSaveStrategy = "new";
      state.selectedLorebookId = "";
      state.existingEntries = [];
      state.existingEntriesStatus = "idle";
      state.existingEntriesMessage = "";
      state.mergeDecisions = [];
      state.mergeAnalysisStatus = "idle";
      state.mergeAnalysisFingerprint = "";
      state.mergeAnalysisMessage = "";
      state.mergeAnalysisWarnings = [];
      state.assetSaveConfirmed = false;
      state.assetSaving = false;
      state.assetSaveMessage = "";
      state.assetSaveResult = null;
      state.settings = cloneSettings(cachedSettings);
      state.activeSavedDraftId = "";
      state.savedDraftBaselineFingerprint = "";
      state.savedDraftMessage = "";
      state.chatTurns = [];
      state.chatRecommendation = null;
      state.chatLoadStatus = "idle";
      state.chatLoadMessage = "대화 내역 참조가 꺼져 있습니다.";
      updateStatus("idle", "프롬프트 이식 작업을 초기화했습니다.");
      const payload = null;
      const serialized = JSON.stringify(payload);
      lastScheduledSession = serialized;
      render();
      await persistSession(payload, serialized);
    };

    const applyRestoredSession = (session) => {
      if (!session) return;
      lastSavedSession = JSON.stringify(session);
      if (initialView === "settings") {
        state.settingsReturnView = session.view;
        state.settingsReturnNavigationView = session.view === "review" ? "workspace" : "prompt";
      } else if (initialView === "workspace") {
        state.view = session.draft ? "review" : "workspace";
        state.navigationView = "workspace";
      } else {
        state.view = "input";
        state.navigationView = "prompt";
      }
      state.inputMode = session.inputMode;
      state.conversionMode = session.conversionMode;
      state.lorebookSourceEnabled = session.lorebookSourceEnabled;
      state.lorebookSource = session.lorebookSource;
      state.sources = { ...session.sources };
      state.selectedConnectionId = session.selectedConnectionId;
      state.draft = session.draft;
      state.excludedEntries = new Set(session.excludedEntries);
      state.excludedPresetCandidates = new Set(session.excludedPresetCandidates);
      state.chatReferenceEnabled = session.chatReferenceEnabled;
      state.chatSourceMode = session.chatSourceMode;
      state.selectedChatId = session.selectedChatId;
      state.chatRangeMode = session.chatRangeMode;
      state.chatRecentTurns = session.chatRecentTurns;
      state.includeRelationshipDevelopment = session.includeRelationshipDevelopment;
      state.chatDerivedPrompt = session.chatDerivedPrompt;
      state.chatDerivedDirty = session.chatDerivedDirty;
      state.chatAnalysisDone = session.chatAnalysisDone;
      state.chatAnalysisWarnings = [...session.chatAnalysisWarnings];
      state.chatAnalysisMessage = session.chatAnalysisMessage;
      state.importedReference = session.importedReference;
      state.lorebookSaveStrategy = session.lorebookSaveStrategy;
      state.selectedLorebookId = session.selectedLorebookId;
      state.mergeDecisions = [...session.mergeDecisions];
      state.mergeAnalysisStatus = session.mergeAnalysisStatus;
      state.mergeAnalysisFingerprint = session.mergeAnalysisFingerprint;
      state.mergeAnalysisMessage = session.mergeAnalysisMessage;
      state.mergeAnalysisWarnings = [...session.mergeAnalysisWarnings];
      state.assetSaveResult = session.assetSaveResult;
      if (session.analysisSettings) state.settings = cloneSettings(session.analysisSettings);
      state.activeSavedDraftId = session.activeSavedDraftId;
      state.restoreRangePending = true;
      state.sessionSaveStatus = "restored";
      state.sessionSaveMessage = "마지막 작업을 복원했습니다.";
    };

    const originalPromptText = () => {
      const sources = core.normalizeSources(state.inputMode, state.sources);
      if (state.inputMode === "combined") return sources.combined.trim();
      return [
        ["Character", sources.character],
        ["World / Lore", sources.worldLore],
        ["System / Style", sources.systemStyle],
        ["Other", sources.other],
      ]
        .filter(([, value]) => value.trim())
        .map(([label, value]) => `[${label}]\n${value.trim()}`)
        .join("\n\n");
    };

    const selectedConnection = () =>
      state.connections.find((connection) => connection.id === state.selectedConnectionId) || null;

    const chatAnalysisPlan = () => {
      const turns = chatCore.selectedTurns(state.chatTurns, state.chatRangeMode, state.chatRecentTurns);
      const selectedTokens = turns.reduce((sum, turn) => sum + turn.estimatedTokens, 0);
      const referenceTokens = chatCore.estimateTokens(originalPromptText());
      const chunkBudget = chatCore.calculateChunkBudget(
        selectedConnection()?.maxContext || chatCore.DEFAULT_MAX_CONTEXT,
        referenceTokens,
      );
      const chunks = chatCore.chunkTurns(turns, chunkBudget);
      return {
        turns,
        selectedTokens,
        chunkBudget,
        chunks,
        requestCount: chunks.length,
      };
    };

    const abortRun = (runId) =>
      apiRequest("/api/generate/raw/abort", {
        method: "POST",
        body: { runId, connectionId: state.selectedConnectionId },
      });

    const generate = async (messages, runId) => {
      const controller = new AbortController();
      const timeoutSeconds = state.settings.responseTimeoutSeconds;
      let timedOut = false;
      const timeoutId = timeoutSeconds > 0
        ? hostMarinara.setTimeout(() => {
            timedOut = true;
            controller.abort();
            void abortRun(runId).catch(() => {});
          }, timeoutSeconds * 1000)
        : null;
      const parameters = core.buildGenerationParameters(state.settings);
      try {
        return await apiRequest("/api/generate/raw", {
          method: "POST",
          signal: controller.signal,
          body: {
            connectionId: state.selectedConnectionId,
            messages,
            ...(parameters ? { parameters } : {}),
            streaming: false,
            runId,
          },
        });
      } catch (error) {
        if (timedOut) throw new Error(`${timeoutSeconds}초 응답 제한을 초과해 분석을 중단했습니다.`);
        throw error;
      } finally {
        if (timeoutId !== null) hostMarinara.clearTimeout(timeoutId);
      }
    };

    const renderStatus = () => {
      const status = createElement("div", { className: "pc-status", role: "status" });
      status.dataset.state = state.status;
      const labelByState = {
        idle: "준비",
        loading_connections: "연결 불러오는 중",
        analyzing: state.abortRequested ? "취소 요청 중" : "AI 분석 중",
        analyzing_merge: state.abortRequested ? "취소 요청 중" : "AI 병합 분석 중",
        extracting_chat: state.abortRequested ? "취소 요청 중" : "대화 후보 추출 중",
        reducing_chat: state.abortRequested ? "취소 요청 중" : "대화 분석 통합 중",
        success: "분석 완료",
        validation_error: "JSON 검증 오류",
        generation_error: "생성 요청 오류",
        aborted: "분석 취소됨",
      };
      status.append(
        createElement("strong", { text: labelByState[state.status] || state.status }),
        createElement("span", { text: state.statusMessage }),
      );
      return status;
    };

    const renderRawError = () => {
      if (state.status !== "validation_error" || !state.rawResponse) return null;
      const details = createElement("details", { className: "pc-raw-error" });
      details.open = true;
      const summary = createElement("summary", { text: "원본 AI 응답 보기" });
      const original = createElement("pre", { text: state.rawResponse });
      details.append(summary, original);
      if (state.repairResponse) {
        details.append(
          createElement("div", { className: "pc-raw-label", text: "자동 교정 응답" }),
          createElement("pre", { text: state.repairResponse }),
        );
      }
      return details;
    };

    const analyze = async () => {
      const activeSources = core.normalizeSources(state.inputMode, state.sources);
      const activeLorebookSource = state.lorebookSourceEnabled ? state.lorebookSource.trim() : "";
      if (
        !Object.values(activeSources).some((value) => value.trim()) &&
        !activeLorebookSource &&
        !(state.chatReferenceEnabled && state.chatDerivedPrompt.trim())
      ) {
        updateStatus("validation_error", "원본 또는 대화 분석 기반 프롬프트를 하나 이상 입력하세요.");
        state.rawResponse = "";
        state.repairResponse = "";
        render();
        return;
      }
      if (!state.selectedConnectionId) {
        updateStatus("generation_error", "텍스트 생성용 LLM 연결을 선택하세요.");
        render();
        return;
      }
      const proceed = await guardWorkingReplacement({
        message: "새 분석을 시작하면 현재 작업 내용이 새 분석 결과로 교체됩니다.",
        saveLabel: "저장 후 새 분석",
        discardLabel: "저장하지 않고 새 분석",
      });
      if (!proceed) return;

      const requestNumber = state.activeRequest + 1;
      state.activeRequest = requestNumber;
      state.abortRequested = false;
      state.rawResponse = "";
      state.repairResponse = "";
      state.activeRunId = createRunId();
      updateStatus("analyzing", "원본을 명령이 아닌 데이터로 취급해 캐릭터, 로어북, 프리셋 후보 초안을 분류하고 있습니다.");
      render();

      try {
        const firstResult = await generate(
          core.buildAnalysisMessages(state.inputMode, activeSources, state.settings, {
            conversionMode: state.conversionMode,
            chatDerivedPrompt: state.chatReferenceEnabled ? state.chatDerivedPrompt : "",
            externalLorebookSource: activeLorebookSource,
          }),
          state.activeRunId,
        );
        if (requestNumber !== state.activeRequest) return;
        if (firstResult?.aborted || state.abortRequested) {
          updateStatus("aborted", "분석 요청을 취소했습니다.");
          state.activeRunId = "";
          render();
          return;
        }
        if (!firstResult || typeof firstResult.content !== "string") {
          throw new Error("생성 API가 내용(content) 문자열을 반환하지 않았습니다.");
        }
        state.rawResponse = firstResult.content;
        let candidateResponse = firstResult.content;
        let validationError = null;
        const repairRetries = state.settings.jsonRepairRetries;
        for (let attempt = 0; attempt <= repairRetries; attempt += 1) {
          try {
            state.draft = core.parseDraftResponse(candidateResponse);
            validationError = null;
            break;
          } catch (error) {
            validationError = error;
          }
          if (attempt >= repairRetries) break;
          updateStatus("analyzing", `JSON 자동 교정 중입니다 (${attempt + 1}/${repairRetries}).`);
          state.activeRunId = createRunId();
          render();
          const repairResult = await generate(
            core.buildRepairMessages(
              candidateResponse,
              validationError instanceof Error ? validationError.message : String(validationError),
            ),
            state.activeRunId,
          );
          if (requestNumber !== state.activeRequest) return;
          if (repairResult?.aborted || state.abortRequested) {
            updateStatus("aborted", "JSON 교정 요청을 취소했습니다.");
            state.activeRunId = "";
            render();
            return;
          }
          if (!repairResult || typeof repairResult.content !== "string") {
            throw new Error("JSON 교정 API가 내용(content) 문자열을 반환하지 않았습니다.");
          }
          state.repairResponse = repairResult.content;
          candidateResponse = repairResult.content;
        }
        if (validationError) {
          updateStatus(
            "validation_error",
            `${repairRetries ? `${repairRetries}회 자동 교정 후에도` : "자동 교정 없이"} 초안을 검증하지 못했습니다: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          );
          state.activeRunId = "";
          render();
          return;
        }
        state.view = "review";
        state.navigationView = "workspace";
        state.excludedEntries = new Set();
        state.excludedPresetCandidates = new Set();
        state.lorebookSaveStrategy = "new";
        state.selectedLorebookId = "";
        state.existingEntries = [];
        state.existingEntriesStatus = "idle";
        state.mergeDecisions = [];
        state.mergeAnalysisStatus = "idle";
        state.mergeAnalysisFingerprint = "";
        state.mergeAnalysisMessage = "";
        state.mergeAnalysisWarnings = [];
        state.assetSaveConfirmed = false;
        state.assetSaveMessage = "";
        state.assetSaveResult = null;
        state.activeRunId = "";
        updateStatus("success", "캐릭터, 로어북, 프리셋 후보 초안을 만들었습니다. 아래 내용을 검토하고 직접 수정할 수 있습니다.");
        render();
        void loadLorebooks();
      } catch (error) {
        if (requestNumber !== state.activeRequest) return;
        state.activeRunId = "";
        if (state.abortRequested || error?.name === "AbortError") {
          updateStatus("aborted", "분석 요청을 취소했습니다.");
        } else {
          updateStatus("generation_error", error instanceof Error ? error.message : String(error));
        }
        render();
      }
    };

    const entryPreview = (entry) => {
      if (!entry) return "대상을 선택하세요.";
      const lines = [];
      if (entry.name) lines.push(entry.name);
      if (entry.keys?.length) lines.push(`키워드: ${entry.keys.join(", ")}`);
      if (entry.secondaryKeys?.length) lines.push(`보조 키워드: ${entry.secondaryKeys.join(", ")}`);
      if (entry.content) lines.push(entry.content);
      return lines.join("\n\n") || "내용 없음";
    };

    const renderMergeReview = () => {
      const wrapper = createElement("div", { className: "pc-merge-review" });
      wrapper.append(
        createElement("h4", { text: "항목 병합 검토" }),
        createElement("p", {
          className: "pc-section-copy",
          text: "AI 제안은 참고용입니다. 기존 항목과 초안을 비교하고 각 결정을 직접 확인해야 저장할 수 있습니다.",
        }),
      );
      if (state.existingEntriesStatus !== "success") {
        wrapper.append(createElement("div", {
          className: "pc-empty",
          text: state.existingEntriesMessage || "기존 로어북을 선택하면 항목을 불러옵니다.",
        }));
        return wrapper;
      }
      const analysisActions = createElement("div", { className: "pc-chat-actions pc-merge-analysis-actions" });
      const analyzeButton = createElement("button", {
        className: "pc-button pc-button-secondary",
        type: "button",
        text: state.mergeAnalysisStatus === "success" ? "AI 병합 다시 분석" : "AI 병합 분석",
      });
      analyzeButton.dataset.mergeAnalyze = "true";
      analyzeButton.disabled = isWorking() || !state.selectedConnectionId || !state.selectedLorebookId;
      analyzeButton.addEventListener("click", () => void analyzeLorebookMerge());
      analysisActions.append(analyzeButton);
      if (state.status === "analyzing_merge") {
        const cancelButton = createElement("button", {
          className: "pc-button pc-button-secondary",
          type: "button",
          text: state.abortRequested ? "취소 요청 중…" : "분석 취소",
        });
        cancelButton.disabled = state.abortRequested;
        cancelButton.addEventListener("click", () => void abortAnalysis());
        analysisActions.append(cancelButton);
      }
      wrapper.append(analysisActions);
      const analysisStatus = createElement("div", {
        className: "pc-merge-analysis-status",
        role: "status",
        text: state.mergeAnalysisMessage || "기존 로어북과 초안 항목을 비교하려면 AI 병합 분석을 실행하세요.",
      });
      analysisStatus.dataset.mergeAnalysisStatus = "true";
      analysisStatus.dataset.state = state.mergeAnalysisStatus;
      wrapper.append(analysisStatus);
      if (state.mergeAnalysisWarnings.length) {
        const warnings = createElement("ul", { className: "pc-save-failures" });
        for (const warning of state.mergeAnalysisWarnings) warnings.append(createElement("li", { text: warning }));
        wrapper.append(warnings);
      }
      if (!mergeAnalysisReady()) return wrapper;
      const activeEntries = state.draft.lorebook.entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ index }) => !state.excludedEntries.has(index));
      if (activeEntries.length === 0) {
        wrapper.append(createElement("div", { className: "pc-empty", text: "저장할 초안 항목이 없습니다." }));
        return wrapper;
      }
      const allDecisionsConfirmable = activeEntries.every(({ index }) => {
        const decision = state.mergeDecisions[index];
        if (!isRecord(decision) || decision.action === "conflict") return false;
        return !["append", "merge"].includes(decision.action) || !!decision.targetEntryId;
      });
      const allDecisionsConfirmed = allDecisionsConfirmable && activeEntries.every(
        ({ index }) => state.mergeDecisions[index]?.confirmed === true,
      );
      const confirmAllButton = createElement("button", {
        className: "pc-button pc-button-secondary",
        type: "button",
        text: "전체 결정 확인",
      });
      confirmAllButton.disabled = isWorking() || !allDecisionsConfirmable || allDecisionsConfirmed;
      confirmAllButton.setAttribute(
        "title",
        allDecisionsConfirmable
          ? allDecisionsConfirmed
            ? "모든 병합 결정을 확인했습니다."
            : "현재 병합 결정을 모두 확인합니다."
          : "충돌을 해결하고 병합 대상 항목을 모두 선택한 뒤 사용할 수 있습니다.",
      );
      confirmAllButton.addEventListener("click", () => {
        if (!allDecisionsConfirmable) return;
        for (const { index } of activeEntries) state.mergeDecisions[index].confirmed = true;
        state.assetSaveConfirmed = false;
        state.assetSaveMessage = "";
        scheduleSessionSave();
        render();
      });
      analysisActions.append(confirmAllButton);
      for (const { entry, index } of activeEntries) {
        const decision = state.mergeDecisions[index];
        if (!isRecord(decision)) continue;
        const card = createElement("article", { className: "pc-entry pc-merge-decision" });
        const header = createElement("div", { className: "pc-entry-header" });
        header.append(createElement("strong", { text: entry.name || `항목 ${index + 1}` }));
        const confirmLabel = createElement("label", { className: "pc-entry-exclude" });
        const confirm = createElement("input");
        confirm.type = "checkbox";
        confirm.checked = decision.confirmed === true;
        const needsTarget = decision.action === "append" || decision.action === "merge";
        confirm.disabled = decision.action === "conflict" || (needsTarget && !decision.targetEntryId);
        confirm.addEventListener("change", () => {
          decision.confirmed = confirm.checked;
        });
        confirmLabel.append(confirm, createElement("span", { text: "결정 확인" }));
        header.append(confirmLabel);
        card.append(header);
        if (decision.reason) card.append(createElement("p", { className: "pc-section-copy", text: `제안 사유: ${decision.reason}` }));
        if (decision.warnings?.length) {
          const warningList = createElement("ul", { className: "pc-save-failures" });
          for (const warning of decision.warnings) warningList.append(createElement("li", { text: warning }));
          card.append(warningList);
        }

        const controls = createElement("div", { className: "pc-entry-grid pc-merge-controls" });
        const action = createElement("select");
        for (const [value, label] of [
          ["create", "신규 생성"],
          ["append", "기존 항목에 추가"],
          ["merge", "병합"],
          ["keep_separate", "별도 유지"],
          ["conflict", "충돌, 저장 보류"],
          ["skip", "제외"],
        ]) action.append(option(value, label));
        action.value = decision.action;
        action.addEventListener("change", () => {
          decision.action = assetCore.normalizeMergeAction(action.value);
          decision.confirmed = false;
          if (decision.action === "create" || decision.action === "keep_separate") {
            decision.targetEntryId = "";
            decision.finalEntry = assetCore.buildEntryPayload(entry);
          } else if (decision.action === "conflict" || decision.action === "skip") {
            decision.targetEntryId = "";
            decision.finalEntry = null;
          }
          render();
        });
        controls.append(makeField("최종 처리", action));

        if (needsTarget) {
          const target = createElement("select");
          target.append(option("", "기존 항목을 선택하세요"));
          for (const existing of state.existingEntries) {
            const keySummary = existing.keys.length ? ` · ${existing.keys.slice(0, 3).join(", ")}` : "";
            target.append(option(existing.id, `${existing.name || "이름 없음"}${keySummary}`));
          }
          target.value = decision.targetEntryId;
          target.addEventListener("change", () => {
            decision.targetEntryId = target.value;
            const existing = state.existingEntries.find((candidate) => candidate.id === target.value);
            decision.finalEntry = existing
              ? assetCore.buildMergedEntry(existing, entry, decision.action)
              : null;
            decision.confirmed = false;
            render();
          });
          const suggested = decision.suggestedTargetId
            ? `AI가 내용과 키워드를 비교해 제안한 대상: ${state.existingEntries.find((item) => item.id === decision.suggestedTargetId)?.name || "없음"}. 사용자가 변경할 수 있습니다.`
            : "내용, 키워드, 보조 키워드와 의미를 함께 비교한 뒤 선택하세요.";
          controls.append(makeField("대상 항목", target, suggested));
        }
        card.append(controls);

        if (needsTarget) {
          const existing = state.existingEntries.find((candidate) => candidate.id === decision.targetEntryId);
          const comparison = createElement("div", { className: "pc-merge-comparison" });
          for (const [label, value] of [["초안 항목", entry], ["기존 항목", existing]]) {
            const panel = createElement("section");
            panel.append(createElement("strong", { text: label }), createElement("pre", { text: entryPreview(value) }));
            comparison.append(panel);
          }
          card.append(comparison);
        }
        if (decision.finalEntry && !["skip", "conflict"].includes(decision.action)) {
          const finalGrid = createElement("div", { className: "pc-entry-grid pc-merge-final" });
          addReviewField(finalGrid, "최종 이름", decision.finalEntry.name, (value) => {
            decision.finalEntry.name = value;
            decision.confirmed = false;
          }, 1);
          addReviewField(finalGrid, "최종 키워드", decision.finalEntry.keys.join(", "), (value) => {
            decision.finalEntry.keys = stringList(value);
            decision.confirmed = false;
          }, 1);
          addReviewField(finalGrid, "최종 보조 키워드", decision.finalEntry.secondaryKeys.join(", "), (value) => {
            decision.finalEntry.secondaryKeys = stringList(value);
            decision.confirmed = false;
          }, 1);
          addReviewField(finalGrid, "최종 내용", decision.finalEntry.content, (value) => {
            decision.finalEntry.content = value;
            decision.confirmed = false;
          }, 6);
          const flags = createElement("div", { className: "pc-entry-flags" });
          for (const [label, key] of [["상시 활성", "constant"], ["선택 활성", "selective"]]) {
            const flag = createElement("label");
            const checkbox = createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = decision.finalEntry[key];
            checkbox.addEventListener("change", () => {
              decision.finalEntry[key] = checkbox.checked;
              decision.confirmed = false;
              confirm.checked = false;
            });
            flag.append(checkbox, createElement("span", { text: label }));
            flags.append(flag);
          }
          finalGrid.append(flags);
          card.append(createElement("h5", { text: "최종 저장 값" }), finalGrid);
        }
        wrapper.append(card);
      }
      return wrapper;
    };

    const renderAssetSaveResult = () => {
      const result = state.assetSaveResult;
      if (!result) return null;
      const wrapper = createElement("div", { className: "pc-save-result" });
      const stale = result.fingerprint !== currentSaveFingerprint();
      const createdCount = result.entryResults.filter((item) => item.type === "create" && item.status === "success").length;
      const updatedCount = result.entryResults.filter((item) => item.type === "update" && item.status === "success").length;
      const failures = saveResultFailures(result);
      const statusLabel = (status) => ({
        idle: "대기",
        pending: "저장 중",
        success: "성공",
        failed: "실패",
        skipped: "제외",
      })[status] || status;
      wrapper.dataset.state = failures.length ? "partial" : saveResultComplete(result) ? "success" : "pending";
      wrapper.append(createElement("h4", { text: failures.length ? "부분 저장 결과" : "저장 결과" }));
      const summary = createElement("dl", { className: "pc-save-summary" });
      for (const [label, value] of [
        ["캐릭터", result.character.status === "success" ? `${result.character.name} · ${result.character.id}` : statusLabel(result.character.status)],
        ["로어북", result.lorebook.status === "success" ? `${result.lorebook.name} · ${result.lorebook.id}` : statusLabel(result.lorebook.status)],
        ["연결", result.link.status === "skipped" ? "해당 없음" : statusLabel(result.link.status)],
        ["신규 항목", `${createdCount}개`],
        ["수정 항목", `${updatedCount}개`],
      ]) {
        summary.append(createElement("dt", { text: label }), createElement("dd", { text: value }));
      }
      wrapper.append(summary);
      if (result.link.status === "skipped" && result.link.error) {
        wrapper.append(createElement("p", { className: "pc-section-copy", text: result.link.error }));
      }
      if (stale) {
        wrapper.append(createElement("p", {
          className: "pc-save-stale",
          text: "저장 후 검토 내용이 변경되었습니다. 이 결과는 이전 검토 상태에 대한 기록입니다.",
        }));
      }
      if (failures.length) {
        const failureList = createElement("ul", { className: "pc-save-failures" });
        for (const failure of failures) {
          failureList.append(createElement("li", { text: `${failure.name}: ${failure.error || "알 수 없는 오류"}` }));
        }
        wrapper.append(failureList);
      }
      return wrapper;
    };

    const abortAnalysis = async () => {
      if (!state.activeRunId || !isWorking() || state.abortRequested) return;
      state.abortRequested = true;
      const runId = state.activeRunId;
      render();
      try {
        await abortRun(runId);
      } catch (error) {
        if (["analyzing", "analyzing_merge"].includes(state.status)) {
          state.abortRequested = false;
          updateStatus("generation_error", `취소 요청에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
          render();
        }
      }
    };

    const applyConversationMessages = (messages, { id = "", name = "", emptyMessage }) => {
      const turns = chatCore.groupMessagesIntoTurns(messages);
      const recommendation = chatCore.calculateRecommendation(turns);
      state.chatId = id;
      state.chatName = name;
      state.chatTurns = turns;
      state.chatRecommendation = recommendation;
      const recentTurns = state.restoreRangePending ? state.chatRecentTurns : recommendation.recommendedTurns;
      state.restoreRangePending = false;
      state.chatRecentTurns = Math.max(1, Math.min(turns.length || 1, recentTurns || 1));
      state.chatLoadStatus = turns.length ? "ready" : "empty";
      state.chatLoadMessage = turns.length
        ? `${name || "대화"} · ${turns.length.toLocaleString()}턴을 불러왔습니다.`
        : emptyMessage;
    };

    const loadImportedConversation = async () => {
      state.chatLoadStatus = "loading";
      state.chatLoadMessage = "대화 가져오기 내용을 불러오는 중입니다.";
      render();
      try {
        state.importedConversationSource = migrationCenter.importedConversationSource || state.importedConversationSource;
        const source = state.importedConversationSource;
        if (!source || !Array.isArray(source.messages)) {
          const reference = state.importedReference;
          applyConversationMessages([], {
            name: "대화 가져오기",
            emptyMessage: reference?.name
              ? `이전 참조: ${reference.name} · ${reference.messageCount.toLocaleString()}개 메시지. 원문은 session에 중복 저장하지 않으므로 다시 분석하려면 파일을 다시 선택하세요.`
              : "대화 가져오기에서 파일을 먼저 선택하세요.",
          });
        } else {
          state.importedReference = {
            name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : "가져온 대화",
            messageCount: source.messages.length,
          };
          applyConversationMessages(source.messages, {
            name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : "가져온 대화",
            emptyMessage: "대화 가져오기에서 선택된 메시지가 없습니다.",
          });
        }
      } catch (error) {
        state.chatId = "";
        state.chatName = "";
        state.chatTurns = [];
        state.chatRecommendation = null;
        state.chatLoadStatus = "error";
        state.chatLoadMessage = `가져오기 대화를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      }
      render();
    };

    const loadSelectedChat = async (chatId = state.selectedChatId) => {
      if (!chatId) {
        applyConversationMessages([], { name: "채팅방", emptyMessage: "선택할 수 있는 채팅방이 없습니다." });
        render();
        return;
      }
      state.chatLoadStatus = "loading";
      state.chatLoadMessage = "선택한 채팅방을 불러오는 중입니다.";
      render();
      try {
        const chat = state.availableChats.find((item) => item.id === chatId);
        const messages = await apiRequest(`/api/chats/${encodeURIComponent(chatId)}/messages`);
        applyConversationMessages(messages, {
          id: chatId,
          name: chat ? chatCore.availableChatLabel(chat) : "선택한 채팅방",
          emptyMessage: "선택한 채팅방에 분석 가능한 User/Assistant 대화가 없습니다.",
        });
      } catch (error) {
        state.chatId = "";
        state.chatName = "";
        state.chatTurns = [];
        state.chatRecommendation = null;
        state.chatLoadStatus = "error";
        state.chatLoadMessage = `채팅방을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      }
      render();
    };

    const loadChatList = async ({ loadSelection = true } = {}) => {
      state.chatListStatus = "loading";
      render();
      try {
        const value = await apiRequest("/api/chats");
        state.availableChats = chatCore.normalizeAvailableChats(value);
        state.selectedChatId = state.availableChats.some((chat) => chat.id === state.selectedChatId)
          ? state.selectedChatId
          : state.availableChats[0]?.id || "";
        state.chatListStatus = "ready";
        if (loadSelection && state.chatSourceMode === "chat") await loadSelectedChat();
      } catch (error) {
        state.availableChats = [];
        state.selectedChatId = "";
        state.chatListStatus = "error";
        state.chatLoadStatus = "error";
        state.chatLoadMessage = `채팅방 목록을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      }
      render();
    };

    const loadConversationSource = () =>
      state.chatSourceMode === "chat" ? loadChatList() : loadImportedConversation();

    const generateValidatedChatJson = async (messages, parser, label, requestNumber) => {
      let requestMessages = messages;
      let lastError = null;
      for (let attempt = 0; attempt <= state.settings.jsonRepairRetries; attempt += 1) {
        state.activeRunId = createRunId();
        const result = await generate(requestMessages, state.activeRunId);
        if (requestNumber !== state.activeRequest) throw new DOMException("Superseded", "AbortError");
        if (result?.aborted || state.abortRequested) throw new DOMException("Aborted", "AbortError");
        if (!result || typeof result.content !== "string") throw new Error(`${label} API가 내용(content) 문자열을 반환하지 않았습니다.`);
        try {
          return parser(result.content);
        } catch (error) {
          lastError = error;
          if (attempt >= state.settings.jsonRepairRetries) break;
          requestMessages = [
            ...messages,
            { role: "assistant", content: result.content },
            {
              role: "user",
              content: repairPrompts.buildChatJsonRepairUserMessage(
                error instanceof Error ? error.message : String(error),
              ),
            },
          ];
        }
      }
      throw lastError || new Error(`${label} 결과를 검증하지 못했습니다.`);
    };

    const analyzeConversation = async () => {
      if (isWorking()) return;
      if (!state.selectedConnectionId) {
        updateStatus("generation_error", "대화 분석에 사용할 LLM 연결을 선택하세요.");
        render();
        return;
      }
      const plan = chatAnalysisPlan();
      if (!plan.turns.length) {
        updateStatus("generation_error", "분석할 대화 범위가 없습니다.");
        render();
        return;
      }
      if (state.chatAnalysisDone && currentSavedDraftDirty()) {
        const proceed = await guardWorkingReplacement({
          message: "대화를 다시 분석하면 현재 대화 분석 프롬프트가 교체됩니다.",
          saveLabel: "저장 후 재분석",
          discardLabel: "저장하지 않고 재분석",
        });
        if (!proceed) return;
      }

      const requestNumber = state.activeRequest + 1;
      state.activeRequest = requestNumber;
      state.abortRequested = false;
      state.chatAnalysisWarnings = [];
      const extractionResults = [];
      try {
        for (const [index, chunk] of plan.chunks.entries()) {
          updateStatus("extracting_chat", `대화 구간 ${index + 1}/${plan.chunks.length}에서 재사용 가능한 정보를 추출하고 있습니다.`);
          render();
          const extracted = await generateValidatedChatJson(
            chatCore.buildExtractionMessages({
              originalPrompt: originalPromptText(),
              chunk: chunk.text,
              chunkIndex: index + 1,
              totalChunks: plan.chunks.length,
            }),
            chatCore.parseExtractionResponse,
            "대화 구간 추출",
            requestNumber,
          );
          extractionResults.push({ chunkIndex: index + 1, ...extracted });
        }
        let reduceInputs = extractionResults;
        const intermediateWarnings = [];
        let reduceLevel = 0;
        while (
          reduceLevel < 4 &&
          reduceInputs.length > 1 &&
          chatCore.estimateTokens(JSON.stringify(reduceInputs)) > plan.chunkBudget
        ) {
          reduceLevel += 1;
          const groups = chatCore.partitionReduceInputs(reduceInputs, plan.chunkBudget);
          const nextInputs = [];
          for (const [index, group] of groups.entries()) {
            updateStatus("reducing_chat", `대화 분석 중간 통합 ${index + 1}/${groups.length}을 처리하고 있습니다.`);
            render();
            const intermediate = await generateValidatedChatJson(
              chatCore.buildReduceMessages({
                originalPrompt: originalPromptText(),
                extractionResults: group,
                includeRelationshipDevelopment: state.includeRelationshipDevelopment,
              }),
              chatCore.parseReduceResponse,
              "Intermediate Reduce",
              requestNumber,
            );
            intermediateWarnings.push(...intermediate.warnings);
            nextInputs.push({
              reduceLevel,
              chatDerivedPrompt: intermediate.chatDerivedPrompt,
              warnings: intermediate.warnings,
            });
          }
          reduceInputs = nextInputs;
          if (groups.length === 1) break;
        }
        if (
          reduceInputs.length > 1 &&
          chatCore.estimateTokens(JSON.stringify(reduceInputs)) > plan.chunkBudget
        ) {
          intermediateWarnings.push("단계별 통합의 안전 한도에 도달했습니다. 더 큰 컨텍스트의 LLM 연결을 사용하거나 대화 범위를 줄이세요.");
        }
        updateStatus("reducing_chat", "대화 구간 결과를 편집 가능한 대화 분석 프롬프트로 통합하고 있습니다.");
        render();
        const reduced = await generateValidatedChatJson(
          chatCore.buildReduceMessages({
            originalPrompt: originalPromptText(),
            extractionResults: reduceInputs,
            includeRelationshipDevelopment: state.includeRelationshipDevelopment,
          }),
          chatCore.parseReduceResponse,
          "Reduce",
          requestNumber,
        );
        if (requestNumber !== state.activeRequest) return;
        state.chatDerivedPrompt = reduced.chatDerivedPrompt;
        state.chatDerivedDirty = false;
        state.chatAnalysisDone = true;
        state.chatAnalysisWarnings = [
          ...extractionResults.flatMap((result) => result.warnings || []),
          ...intermediateWarnings,
          ...reduced.warnings,
        ];
        state.chatAnalysisMessage = `${plan.turns.length.toLocaleString()}턴을 ${plan.chunks.length.toLocaleString()}개 구간으로 분석했습니다.`;
        state.activeRunId = "";
        updateStatus("idle", "대화 분석 프롬프트를 검토하고 필요하면 수정하세요.");
        render();
      } catch (error) {
        if (requestNumber !== state.activeRequest) return;
        state.activeRunId = "";
        if (state.abortRequested || error?.name === "AbortError") {
          updateStatus("aborted", "대화 분석을 취소했습니다.");
        } else {
          updateStatus("generation_error", `대화 분석에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
        }
        render();
      }
    };

    const openSettings = () => {
      if (isWorking() || !state.settingsLoaded) return;
      state.settingsReturnView = state.view === "review" ? "review" : state.view === "workspace" ? "workspace" : "input";
      state.settingsReturnNavigationView = state.navigationView;
      state.settingsDraft = cloneSettings(state.settings);
      state.settingsMessage = "";
      state.settingsEditorUnlocked = { contentFormattingInstructions: false };
      state.view = "settings";
      state.navigationView = "settings";
      render();
      body.querySelector("input, textarea, button")?.focus();
    };

    const closeSettings = () => {
      state.settingsDraft = null;
      state.settingsMessage = "";
      state.view = state.settingsReturnView;
      state.navigationView = state.settingsReturnNavigationView;
      render();
      navigation.querySelector(`[data-view="${state.navigationView}"]`)?.focus();
    };

    const saveSettings = async () => {
      if (!state.settingsDraft || state.settingsSaving) return;
      const normalized = core.normalizeSettings(state.settingsDraft);
      state.settingsSaving = true;
      state.settingsMessage = "설정을 저장하는 중입니다.";
      render();
      try {
        await hostMarinara.storage.patch({ [SETTINGS_STORAGE_KEY]: normalized });
        cachedSettings = normalized;
        state.settings = cloneSettings(normalized);
        state.settingsDraft = cloneSettings(normalized);
        state.settingsMessage = "AI 분석 설정을 저장했습니다.";
      } catch (error) {
        state.settingsMessage = `설정을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        state.settingsSaving = false;
        render();
      }
    };

    const makeToggle = (labelText, checked, onChange, hint) => {
      const wrapper = createElement("label", { className: "pc-setting-toggle" });
      const input = createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      input.disabled = state.settingsSaving;
      input.addEventListener("change", () => onChange(input.checked));
      const copy = createElement("span");
      copy.append(createElement("strong", { text: labelText }));
      if (hint) copy.append(createElement("small", { text: hint }));
      wrapper.append(input, copy);
      return wrapper;
    };

    const makeNumberSetting = (labelText, value, onInput, options = {}) => {
      const input = createElement("input");
      input.type = "number";
      input.value = String(value);
      if (options.min !== undefined) input.min = String(options.min);
      if (options.max !== undefined) input.max = String(options.max);
      if (options.step !== undefined) input.step = String(options.step);
      input.disabled = !!options.disabled || state.settingsSaving;
      input.addEventListener("input", () => onInput(input.value));
      return makeField(labelText, input, options.hint);
    };

    const renderSettings = () => {
      const settings = state.settingsDraft || cloneSettings(state.settings);
      const container = createElement("div", { className: "pc-settings-view" });

      const generation = createElement("section", { className: "pc-settings-section" });
      generation.append(createElement("h3", { text: "생성 설정" }));
      generation.append(
        makeToggle(
          "연결의 기본 생성 설정 사용",
          settings.useConnectionDefaults,
          (checked) => {
            settings.useConnectionDefaults = checked;
            render();
          },
          "켜면 아래에서 재정의한 값 외에는 연결에 저장된 설정을 사용합니다.",
        ),
      );
      const generationGrid = createElement("div", { className: "pc-settings-grid" });
      const temperature = createElement("div", { className: "pc-setting-override" });
      temperature.append(
        makeToggle("생성 온도 재정의", settings.temperatureOverrideEnabled, (checked) => {
          settings.temperatureOverrideEnabled = checked;
          render();
        }),
        makeNumberSetting("생성 온도 (Temperature)", settings.temperature, (value) => {
          settings.temperature = Number(value);
        }, { min: 0, max: 5, step: 0.05, disabled: !settings.temperatureOverrideEnabled }),
      );
      const maxTokens = createElement("div", { className: "pc-setting-override" });
      maxTokens.append(
        makeToggle("최대 출력 토큰 재정의", settings.maxTokensOverrideEnabled, (checked) => {
          settings.maxTokensOverrideEnabled = checked;
          render();
        }),
        makeNumberSetting("최대 출력 토큰", settings.maxTokens, (value) => {
          settings.maxTokens = Number(value);
        }, { min: 1, max: 200000, step: 1, disabled: !settings.maxTokensOverrideEnabled }),
      );
      generationGrid.append(
        temperature,
        maxTokens,
        makeNumberSetting("응답 제한 시간 (초)", settings.responseTimeoutSeconds, (value) => {
          settings.responseTimeoutSeconds = Number(value);
        }, { min: 0, max: 86400, step: 1, hint: "0은 제한 없음" }),
        makeNumberSetting("JSON 교정 재시도", settings.jsonRepairRetries, (value) => {
          settings.jsonRepairRetries = Number(value);
        }, { min: 0, max: 5, step: 1, hint: "0~5회, 기본값 1" }),
      );
      generation.append(generationGrid);
      container.append(generation);

      const language = createElement("section", { className: "pc-settings-section" });
      language.append(
        createElement("h3", { text: "언어" }),
        makeToggle(
          "언어 고유 표현 보존",
          settings.preserveLanguageSpecificExpressions,
          (checked) => {
            settings.preserveLanguageSpecificExpressions = checked;
            render();
          },
          "OFF가 기본입니다. ON이면 번역으로 의미가 손실되는 말투·호칭·언어 고유 표현만 영어 설명과 원어를 함께 보존합니다.",
        ),
      );
      container.append(language);

      const promptEditor = (title, key, defaultValue) => {
        const section = createElement("section", { className: "pc-settings-section" });
        const heading = createElement("div", { className: "pc-settings-heading" });
        const actions = createElement("div", { className: "pc-settings-heading-actions" });
        const restore = createElement("button", { className: "pc-button pc-button-secondary pc-button-small", type: "button", text: "기본값 복원" });
        restore.disabled = state.settingsSaving;
        restore.addEventListener("click", () => {
          settings[key] = defaultValue;
          render();
        });
        const edit = createElement("button", {
          className: "pc-button pc-button-secondary pc-button-small",
          type: "button",
          text: state.settingsEditorUnlocked[key] ? "잠금" : "수정",
        });
        edit.disabled = state.settingsSaving;
        edit.addEventListener("click", () => {
          state.settingsEditorUnlocked[key] = !state.settingsEditorUnlocked[key];
          render();
        });
        actions.append(restore, edit);
        heading.append(createElement("h3", { text: title }), actions);
        const editor = makeTextInput(settings[key], (value) => {
          settings[key] = value;
        }, { multiline: true, rows: 12, className: "pc-settings-editor" });
        editor.readOnly = !state.settingsEditorUnlocked[key];
        editor.disabled = state.settingsSaving;
        editor.dataset.locked = String(editor.readOnly);
        editor.setAttribute("aria-label", title);
        section.append(heading, editor);
        return section;
      };
      container.append(
        promptEditor(
          "내용 및 형식 지침",
          "contentFormattingInstructions",
          core.DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
        ),
      );
      if (state.settingsMessage) {
        const message = createElement("div", { className: "pc-settings-message", role: "status", text: state.settingsMessage });
        container.append(message);
      }
      return container;
    };

    const renderChatReference = () => {
      const section = createElement("section", { className: "pc-section pc-chat-reference" });
      const heading = createElement("div", { className: "pc-section-heading" });
      const enabledToggle = createElement("div", {
        className: "pc-segmented pc-segmented-inline pc-chat-enabled-toggle",
        role: "group",
        ariaLabel: "대화 내역 참조 사용 여부",
      });
      for (const [value, label] of [[false, "OFF"], [true, "ON"]]) {
        const button = createElement("button", { type: "button", text: label });
        button.dataset.selected = String(state.chatReferenceEnabled === value);
        button.setAttribute("aria-pressed", String(state.chatReferenceEnabled === value));
        button.disabled = isWorking();
        button.addEventListener("click", () => {
          if (state.chatReferenceEnabled === value) return;
          state.chatReferenceEnabled = value;
          if (value) void loadConversationSource();
          else {
            state.chatLoadMessage = "대화 내역 참조가 꺼져 있습니다.";
            render();
          }
        });
        enabledToggle.append(button);
      }
      heading.append(createElement("h3", { text: "2. 대화 내역 참조" }), enabledToggle);
      section.append(heading);

      if (!state.chatReferenceEnabled) {
        section.append(createElement("p", {
          className: "pc-section-copy",
          text: state.chatDerivedPrompt
            ? "기존 대화 분석 기반 프롬프트는 유지되지만 최종 변환 입력에서는 제외됩니다."
            : "켜면 대화 가져오기 내용 또는 선택한 Marinara 채팅방을 분석할 수 있습니다.",
        }));
        return section;
      }

      const sourceRow = createElement("div", { className: "pc-chat-source-row" });
      const sourceMode = createElement("div", { className: "pc-segmented pc-chat-source-toggle", role: "group", ariaLabel: "참조 대화 출처" });
      for (const [value, label] of [["import", "대화 가져오기"], ["chat", "채팅방 선택"]]) {
        const button = createElement("button", { type: "button", text: label });
        button.dataset.selected = String(state.chatSourceMode === value);
        button.setAttribute("aria-pressed", String(state.chatSourceMode === value));
        button.disabled = isWorking();
        button.addEventListener("click", () => {
          if (state.chatSourceMode === value) return;
          state.chatSourceMode = value;
          if (state.chatDerivedPrompt) state.chatAnalysisMessage = "참조 대상이 변경되었습니다. 기존 결과를 유지하려면 그대로 두고, 새 대상으로 바꾸려면 다시 분석하세요.";
          void loadConversationSource();
        });
        sourceMode.append(button);
      }
      sourceRow.append(sourceMode);

      if (state.chatSourceMode === "chat") {
        const chatSelect = createElement("select");
        chatSelect.setAttribute("aria-label", "참조할 Marinara 채팅방");
        if (state.availableChats.length === 0) {
          chatSelect.append(option("", state.chatListStatus === "loading" ? "채팅방 불러오는 중…" : "선택 가능한 채팅방 없음"));
        } else {
          for (const chat of state.availableChats) chatSelect.append(option(chat.id, chatCore.availableChatLabel(chat)));
        }
        chatSelect.value = state.selectedChatId;
        chatSelect.disabled = isWorking() || state.chatListStatus === "loading" || state.availableChats.length === 0;
        chatSelect.addEventListener("change", () => {
          state.selectedChatId = chatSelect.value;
          if (state.chatDerivedPrompt) state.chatAnalysisMessage = "참조 채팅방이 변경되었습니다. 새 대상으로 바꾸려면 다시 분석하세요.";
          void loadSelectedChat();
        });
        sourceRow.append(chatSelect);
      }

      const refresh = createElement("button", { className: "pc-button pc-button-secondary pc-button-small", type: "button", text: "새로고침" });
      refresh.disabled = isWorking() || state.chatLoadStatus === "loading" || state.chatListStatus === "loading";
      refresh.addEventListener("click", () => void loadConversationSource());
      sourceRow.append(refresh);
      section.append(sourceRow);

      const loadMessage = createElement("p", { className: "pc-section-copy", text: state.chatLoadMessage });
      section.append(loadMessage);
      if (state.chatLoadStatus !== "ready") return section;

      const plan = chatAnalysisPlan();
      const recommendation = state.chatRecommendation;
      const rangeControls = createElement("div", { className: "pc-chat-range" });
      const recentGroup = createElement("div", { className: "pc-chat-recent-group" });
      const recentButton = createElement("button", { type: "button", text: "최근" });
      recentButton.dataset.selected = String(state.chatRangeMode === "recent");
      recentButton.setAttribute("aria-pressed", String(state.chatRangeMode === "recent"));
      recentButton.disabled = isWorking();
      recentButton.addEventListener("click", () => {
        state.chatRangeMode = "recent";
        render();
      });
      const recentInput = createElement("input");
      recentInput.type = "number";
      recentInput.min = "1";
      recentInput.max = String(state.chatTurns.length);
      recentInput.value = String(state.chatRecentTurns);
      recentInput.disabled = isWorking() || state.chatRangeMode !== "recent";
      recentInput.setAttribute("aria-label", "최근 참조 턴 수");
      recentInput.addEventListener("change", () => {
        state.chatRecentTurns = Math.max(1, Math.min(state.chatTurns.length, Math.round(Number(recentInput.value) || 1)));
        render();
      });
      recentGroup.append(recentButton, recentInput, createElement("span", { text: "턴" }));
      const allButton = createElement("button", { type: "button", text: "전체 대화" });
      allButton.dataset.selected = String(state.chatRangeMode === "all");
      allButton.setAttribute("aria-pressed", String(state.chatRangeMode === "all"));
      allButton.disabled = isWorking();
      allButton.addEventListener("click", () => {
        state.chatRangeMode = "all";
        render();
      });
      rangeControls.append(recentGroup, allButton);
      section.append(rangeControls);

      const recommendedTurns = recommendation?.recommendedTurns || state.chatTurns.length;
      section.append(
        createElement("p", {
          className: "pc-chat-estimate",
          text: `예상 토큰 ${plan.selectedTokens.toLocaleString()} · 권장 최근 약 ${recommendedTurns.toLocaleString()}턴 / 예상 토큰 약 ${Math.round(recommendation?.recommendedTokens || 0).toLocaleString()} · ${plan.requestCount.toLocaleString()}회 나눠서 분석`,
        }),
      );
      if (plan.selectedTokens > chatCore.RECOMMENDED_ANALYSIS_TOKENS) {
        section.append(createElement("p", {
          className: "pc-chat-cost-warning",
          text: "권장 분석량을 초과했습니다. 실행할 수 있지만 비용과 처리 시간이 증가할 수 있습니다.",
        }));
      }

      const relationshipOption = createElement("label", { className: "pc-setting-toggle pc-chat-relationship-option" });
      const relationshipInput = createElement("input");
      relationshipInput.type = "checkbox";
      relationshipInput.checked = state.includeRelationshipDevelopment;
      relationshipInput.disabled = isWorking();
      relationshipInput.addEventListener("change", () => {
        state.includeRelationshipDevelopment = relationshipInput.checked;
      });
      const relationshipCopy = createElement("span");
      relationshipCopy.append(
        createElement("strong", { text: "관계 변화 과정 포함" }),
        createElement("small", { text: "끄면 중요한 발전 과정 대신 현재 관계 상태를 우선합니다." }),
      );
      relationshipOption.append(relationshipInput, relationshipCopy);

      const analyzeChatButton = createElement("button", {
        className: "pc-button pc-button-secondary",
        type: "button",
        text: state.chatAnalysisDone ? "대화 다시 분석" : "대화 분석",
      });
      analyzeChatButton.disabled = isWorking() || !state.selectedConnectionId || !plan.turns.length;
      analyzeChatButton.addEventListener("click", analyzeConversation);
      const actions = createElement("div", { className: "pc-chat-actions" });
      actions.append(relationshipOption, analyzeChatButton);
      section.append(actions);

      if (state.chatAnalysisDone || state.chatDerivedPrompt) {
        const derivedHeading = createElement("div", { className: "pc-settings-heading" });
        const clearButton = createElement("button", { className: "pc-button pc-button-secondary pc-button-small", type: "button", text: "내용 삭제" });
        clearButton.disabled = isWorking();
        clearButton.addEventListener("click", () => {
          state.chatDerivedPrompt = "";
          state.chatDerivedDirty = true;
          state.chatAnalysisMessage = "대화 분석 프롬프트를 비웠습니다. 기존 프롬프트만 변환됩니다.";
          render();
        });
        derivedHeading.append(createElement("h3", { text: "대화 분석 기반 프롬프트" }), clearButton);
        const editor = makeTextInput(state.chatDerivedPrompt, (value) => {
          state.chatDerivedPrompt = value;
          state.chatDerivedDirty = true;
        }, { multiline: true, rows: 12, className: "pc-chat-derived-editor" });
        editor.disabled = isWorking();
        editor.setAttribute("aria-label", "대화 분석 기반 프롬프트");
        section.append(derivedHeading, editor);
        if (state.chatAnalysisMessage) section.append(createElement("p", { className: "pc-chat-estimate", text: state.chatAnalysisMessage }));
        if (state.chatAnalysisWarnings.length) {
          const warnings = createElement("details", { className: "pc-chat-warnings" });
          warnings.append(
            createElement("summary", { text: `분석 경고 ${state.chatAnalysisWarnings.length.toLocaleString()}개` }),
            createElement("pre", { text: state.chatAnalysisWarnings.join("\n") }),
          );
          section.append(warnings);
        }
      }
      return section;
    };

    const renderInput = () => {
      const container = createElement("div", { className: "pc-input-view" });
      const modeSection = createElement("section", { className: "pc-section" });
      const promptHeading = createElement("div", { className: "pc-section-heading" });
      const mode = createElement("div", { className: "pc-segmented pc-segmented-inline", role: "group", ariaLabel: "프롬프트 입력 모드" });
      for (const [value, label] of [
        ["combined", "통짜"],
        ["separated", "분할"],
      ]) {
        const button = createElement("button", { type: "button", text: label });
        button.dataset.selected = String(state.inputMode === value);
        button.setAttribute("aria-pressed", String(state.inputMode === value));
        button.disabled = isWorking();
        button.addEventListener("click", () => {
          state.inputMode = value;
          if (state.status === "validation_error") updateStatus("idle", "입력 모드를 변경했습니다.");
          render();
        });
        mode.append(button);
      }
      promptHeading.append(createElement("h3", { text: "1. 프롬프트 입력" }), mode);
      modeSection.append(
        promptHeading,
        createElement("p", { className: "pc-section-copy", text: "원본은 명령이 아닌 분석 대상으로 전달됩니다." }),
      );

      const sourceFields = createElement("div", { className: "pc-source-fields" });
      if (state.inputMode === "combined") {
        sourceFields.append(
          makeField(
            "전체 프롬프트",
            makeTextInput(
              state.sources.combined,
              (value) => {
                state.sources.combined = value;
              },
              { multiline: true, rows: 15, placeholder: "외부 플랫폼의 전체 프롬프트를 붙여 넣으세요." },
            ),
          ),
        );
      } else {
        const separated = [
          ["캐릭터", "character", "캐릭터의 정체성, 성격, 외모, 말투, 배경 등"],
          ["세계관 / 로어", "worldLore", "세계관, 장소, 조직, NPC, 용어, 사건 등"],
          ["시스템 / 문체", "systemStyle", "시스템 규칙, 문체, 출력 형식, 행동 지침 등"],
          ["기타", "other", "분류가 불분명하거나 추가로 보존할 내용"],
        ];
        for (const [label, key, placeholder] of separated) {
          sourceFields.append(
            makeField(
              label,
              makeTextInput(
                state.sources[key],
                (value) => {
                  state.sources[key] = value;
                },
                { multiline: true, rows: 5, placeholder },
              ),
            ),
          );
        }
      }
      for (const control of sourceFields.querySelectorAll("textarea")) control.disabled = isWorking();
      modeSection.append(sourceFields);

      const lorebookSourceToggle = createElement("label", { className: "pc-setting-toggle pc-lorebook-source-toggle" });
      const lorebookSourceCheckbox = createElement("input");
      lorebookSourceCheckbox.type = "checkbox";
      lorebookSourceCheckbox.checked = state.lorebookSourceEnabled;
      lorebookSourceCheckbox.disabled = isWorking();
      lorebookSourceCheckbox.setAttribute("aria-controls", "pc-lorebook-source-field");
      lorebookSourceCheckbox.setAttribute("aria-expanded", String(state.lorebookSourceEnabled));
      lorebookSourceCheckbox.addEventListener("change", () => {
        state.lorebookSourceEnabled = lorebookSourceCheckbox.checked;
        render();
      });
      const lorebookSourceCopy = createElement("span");
      lorebookSourceCopy.append(
        createElement("strong", { text: "로어북 입력 추가" }),
        createElement("small", { text: "외부 플랫폼에서 별도로 관리하던 로어북을 독립 입력 자료로 전달합니다." }),
      );
      lorebookSourceToggle.append(lorebookSourceCheckbox, lorebookSourceCopy);
      modeSection.append(lorebookSourceToggle);

      if (state.lorebookSourceEnabled) {
        const lorebookSourceEditor = makeTextInput(
          state.lorebookSource,
          (value) => {
            state.lorebookSource = value;
          },
          {
            multiline: true,
            rows: 10,
            placeholder: "외부 플랫폼의 별도 로어북 내용을 붙여 넣으세요.",
          },
        );
        lorebookSourceEditor.disabled = isWorking();
        const lorebookSourceField = makeField("외부 로어북", lorebookSourceEditor);
        lorebookSourceField.id = "pc-lorebook-source-field";
        modeSection.append(lorebookSourceField);
      }

      const conversionSection = createElement("section", { className: "pc-section" });
      conversionSection.append(createElement("h3", { text: "3. 변환 방식" }));
      const conversionMode = createElement("div", { className: "pc-segmented", role: "group", ariaLabel: "프롬프트 이식 변환 방식" });
      for (const [value, label] of [
        ["preserve", "원본 보존 (Preserve)"],
        ["normalize", "자연어 최적화 (Normalize)"],
      ]) {
        const button = createElement("button", { type: "button", text: label });
        button.dataset.selected = String(state.conversionMode === value);
        button.setAttribute("aria-pressed", String(state.conversionMode === value));
        button.disabled = isWorking();
        button.addEventListener("click", () => {
          state.conversionMode = value;
          render();
        });
        conversionMode.append(button);
      }
      conversionSection.append(
        conversionMode,
        createElement("p", {
          className: "pc-mode-copy",
          text:
            state.conversionMode === "preserve"
              ? "번역·분류 과정에서 표현 변경과 확장을 최소화합니다."
              : "정보를 보존하면서 자연스러운 영어 프롬프트로 재작성합니다.",
        }),
      );

      const connectionSection = createElement("section", { className: "pc-section" });
      connectionSection.append(createElement("h3", { text: "4. LLM 연결" }));
      const connectionRow = createElement("div", { className: "pc-connection-row" });
      const connectionSelect = createElement("select");
      connectionSelect.setAttribute("aria-label", "LLM 연결");
      if (state.connections.length === 0) {
        connectionSelect.append(option("", state.status === "loading_connections" ? "불러오는 중…" : "사용 가능한 연결 없음"));
      } else {
        for (const connection of state.connections) {
          const suffix = connection.preferred ? " · 기본" : "";
          connectionSelect.append(option(connection.id, `${connection.name} · ${connection.model}${suffix}`));
        }
      }
      connectionSelect.value = state.selectedConnectionId;
      connectionSelect.disabled = isWorking() || state.status === "loading_connections" || state.connections.length === 0;
      connectionSelect.addEventListener("change", () => {
        state.selectedConnectionId = connectionSelect.value;
        render();
      });
      const refreshButton = createElement("button", { className: "pc-button pc-button-secondary", type: "button", text: "새로고침" });
      refreshButton.disabled = isWorking() || state.status === "loading_connections";
      refreshButton.addEventListener("click", loadConnections);
      connectionRow.append(connectionSelect, refreshButton);
      connectionSection.append(connectionRow);
      container.append(modeSection, renderChatReference(), conversionSection, connectionSection);
      if (state.status !== "idle") container.append(renderStatus());
      const raw = renderRawError();
      if (raw) container.append(raw);
      return container;
    };

    const addReviewField = (parent, label, value, assign, rows = 4, hint) => {
      const input = makeTextInput(value, assign, { multiline: rows > 1, rows });
      parent.append(makeField(label, input, hint));
    };

    const eligibleLorebook = (value) =>
      isRecord(value) && typeof value.id === "string" && !!value.id.trim();

    const normalizeLorebookRows = (value) => {
      const rows = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
      return rows.filter(eligibleLorebook).map((row) => ({
        id: row.id,
        name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : "이름 없는 로어북",
        description: typeof row.description === "string" ? row.description : "",
        category: typeof row.category === "string" ? row.category : "uncategorized",
        isGlobal: row.isGlobal === true,
        characterIds: Array.isArray(row.characterIds) ? row.characterIds.filter((id) => typeof id === "string") : [],
        personaIds: Array.isArray(row.personaIds) ? row.personaIds.filter((id) => typeof id === "string") : [],
        personaId: typeof row.personaId === "string" ? row.personaId : "",
      }));
    };

    const normalizeExistingEntries = (value) => (Array.isArray(value) ? value : []).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) return [];
      return [{
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : "",
        content: typeof entry.content === "string" ? entry.content : "",
        keys: Array.isArray(entry.keys) ? entry.keys.filter((item) => typeof item === "string") : [],
        secondaryKeys: Array.isArray(entry.secondaryKeys)
          ? entry.secondaryKeys.filter((item) => typeof item === "string")
          : [],
        constant: entry.constant === true,
        selective: entry.selective === true,
      }];
    });

    const loadLorebooks = async () => {
      if (state.lorebooksStatus === "loading") return;
      state.lorebooksStatus = "loading";
      state.lorebooksMessage = "기존 로어북을 불러오는 중입니다.";
      render();
      try {
        state.lorebooks = normalizeLorebookRows(await apiRequest("/api/lorebooks"));
        if (state.selectedLorebookId && !state.lorebooks.some((book) => book.id === state.selectedLorebookId)) {
          state.selectedLorebookId = "";
          state.existingEntries = [];
          state.mergeAnalysisStatus = "stale";
          state.mergeAnalysisFingerprint = "";
          state.mergeAnalysisMessage = "선택했던 로어북을 찾을 수 없어 병합 분석 결과를 사용할 수 없습니다.";
          state.mergeAnalysisWarnings = [];
          state.mergeDecisions = [];
        }
        state.lorebooksStatus = "success";
        state.lorebooksMessage = state.lorebooks.length
          ? `${state.lorebooks.length}개의 로어북을 불러왔습니다.`
          : "사용 가능한 로어북이 없습니다.";
        render();
        if (state.selectedLorebookId) await loadExistingEntries(state.selectedLorebookId);
      } catch (error) {
        state.lorebooksStatus = "error";
        state.lorebooksMessage = `로어북 목록을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
        render();
      }
    };

    const loadExistingEntries = async (lorebookId) => {
      if (!lorebookId) return;
      const restoredMergeFingerprint = state.mergeAnalysisStatus === "success"
        ? state.mergeAnalysisFingerprint
        : "";
      state.existingEntriesStatus = "loading";
      state.existingEntriesMessage = "기존 항목을 불러오는 중입니다.";
      render();
      try {
        const entries = normalizeExistingEntries(await apiRequest(`/api/lorebooks/${encodeURIComponent(lorebookId)}/entries`));
        if (state.selectedLorebookId !== lorebookId) return;
        state.existingEntries = entries;
        state.existingEntriesStatus = "success";
        state.existingEntriesMessage = `${entries.length}개의 기존 항목을 불러왔습니다.`;
        if (restoredMergeFingerprint && restoredMergeFingerprint !== mergeAnalysisFingerprint()) {
          state.mergeAnalysisStatus = "stale";
          state.mergeAnalysisFingerprint = "";
          state.mergeAnalysisMessage = "초안 또는 대상 로어북이 변경되어 저장된 병합 분석 결과를 사용할 수 없습니다.";
          state.mergeAnalysisWarnings = [];
          state.mergeDecisions = [];
        }
        render();
      } catch (error) {
        if (state.selectedLorebookId !== lorebookId) return;
        state.existingEntries = [];
        state.existingEntriesStatus = "error";
        state.existingEntriesMessage = `기존 항목을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
        render();
      }
    };

    const activeMergeDraftRows = () => mergeCore.draftEntries(state.draft?.lorebook?.entries)
      .filter((entry, index) => !state.excludedEntries.has(index));

    const selectedLorebookMetadata = () => {
      const selected = state.lorebooks.find((book) => book.id === state.selectedLorebookId);
      return selected
        ? {
            id: selected.id,
            name: selected.name,
            description: selected.description,
            category: selected.category,
            isGlobal: selected.isGlobal,
            characterIds: selected.characterIds,
            personaIds: selected.personaIds,
            personaId: selected.personaId,
          }
        : null;
    };

    const mergeAnalysisFingerprint = () => assetCore.reviewFingerprint({
      strategy: state.lorebookSaveStrategy,
      selectedLorebook: selectedLorebookMetadata(),
      draftEntries: activeMergeDraftRows(),
      existingEntries: mergeCore.existingEntries(state.existingEntries),
    });

    const mergeAnalysisReady = () => {
      const decisionsReady = (state.draft?.lorebook?.entries || []).every((entry, index) =>
        state.excludedEntries.has(index) || isRecord(state.mergeDecisions[index]),
      );
      return state.lorebookSaveStrategy === "merge" &&
        state.mergeAnalysisStatus === "success" &&
        !!state.mergeAnalysisFingerprint &&
        decisionsReady &&
        state.mergeAnalysisFingerprint === mergeAnalysisFingerprint();
    };

    const updateMergeAnalysisStatusElement = () => {
      const element = body.querySelector("[data-merge-analysis-status]");
      if (!(element instanceof HTMLElement)) return;
      element.dataset.state = state.mergeAnalysisStatus;
      element.textContent = state.mergeAnalysisMessage;
    };

    const invalidateMergeAnalysis = (message) => {
      if (!state.mergeAnalysisFingerprint && state.mergeAnalysisStatus !== "success") return;
      state.mergeAnalysisStatus = "stale";
      state.mergeAnalysisFingerprint = "";
      state.mergeAnalysisMessage = message;
      state.mergeAnalysisWarnings = [];
      state.mergeDecisions = [];
      state.assetSaveConfirmed = false;
      updateMergeAnalysisStatusElement();
      for (const decision of body.querySelectorAll(".pc-merge-decision")) decision.remove();
      const analyzeButton = body.querySelector("[data-merge-analyze]");
      if (analyzeButton instanceof HTMLButtonElement) analyzeButton.textContent = "AI 병합 분석";
      renderFooter();
    };

    const markMergeAnalysisStaleIfNeeded = () => {
      if (state.lorebookSaveStrategy !== "merge" || state.mergeAnalysisStatus !== "success") return;
      if (state.mergeAnalysisFingerprint !== mergeAnalysisFingerprint()) {
        invalidateMergeAnalysis("초안 항목 또는 기존 항목이 변경되어 AI 병합 분석을 다시 실행해야 합니다.");
      }
    };

    const mergeAnalysisPlan = () => {
      const draftRows = activeMergeDraftRows();
      const existingRows = mergeCore.existingEntries(state.existingEntries);
      const lorebook = selectedLorebookMetadata();
      const referenceTokens = chatCore.estimateTokens(JSON.stringify({
        lorebook,
        draftLorebook: {
          name: state.draft?.lorebook?.name || "",
          description: state.draft?.lorebook?.description || "",
          category: state.draft?.lorebook?.category || "world",
          entries: draftRows,
        },
      }));
      const chunkBudget = chatCore.calculateChunkBudget(
        selectedConnection()?.maxContext || chatCore.DEFAULT_MAX_CONTEXT,
        referenceTokens,
      );
      const existingBudget = Math.max(2_000, chunkBudget - referenceTokens - 2_000);
      const chunks = mergeCore.chunkExistingEntries(existingRows, existingBudget, chatCore.estimateTokens);
      return {
        draftRows,
        existingRows,
        lorebook,
        chunkBudget,
        chunks,
        requestCount: chunks.length > 1 ? chunks.length + 1 : 1,
      };
    };

    const generateValidatedMergeJson = async (messages, plan, requestNumber, label) => {
      let requestMessages = messages;
      let lastError = null;
      for (let attempt = 0; attempt <= state.settings.jsonRepairRetries; attempt += 1) {
        state.activeRunId = createRunId();
        const result = await generate(requestMessages, state.activeRunId);
        if (requestNumber !== state.activeRequest) throw new DOMException("Superseded", "AbortError");
        if (result?.aborted || state.abortRequested) throw new DOMException("Aborted", "AbortError");
        if (!result || typeof result.content !== "string") throw new Error(`${label} API가 내용(content) 문자열을 반환하지 않았습니다.`);
        try {
          return mergeCore.parseResponse(result.content, plan.draftRows, plan.existingRows);
        } catch (error) {
          lastError = error;
          if (attempt >= state.settings.jsonRepairRetries) break;
          requestMessages = mergeCore.buildRepairMessages(
            result.content,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      throw lastError || new Error(`${label} 결과를 검증하지 못했습니다.`);
    };

    const analyzeLorebookMerge = async () => {
      if (isWorking() || state.lorebookSaveStrategy !== "merge") return;
      if (!state.selectedConnectionId) {
        state.mergeAnalysisStatus = "error";
        state.mergeAnalysisMessage = "AI 병합 분석에 사용할 LLM 연결을 선택하세요.";
        render();
        return;
      }
      if (!state.selectedLorebookId || state.existingEntriesStatus !== "success") {
        state.mergeAnalysisStatus = "error";
        state.mergeAnalysisMessage = "기존 로어북과 항목을 먼저 불러오세요.";
        render();
        return;
      }
      const plan = mergeAnalysisPlan();
      if (!plan.draftRows.length) {
        state.mergeAnalysisStatus = "error";
        state.mergeAnalysisMessage = "병합 분석할 초안 항목이 없습니다.";
        render();
        return;
      }
      const fingerprint = mergeAnalysisFingerprint();
      const requestNumber = state.activeRequest + 1;
      state.activeRequest = requestNumber;
      state.abortRequested = false;
      state.mergeAnalysisStatus = "loading";
      state.mergeAnalysisMessage = `${plan.draftRows.length}개의 초안 항목과 ${plan.existingRows.length}개의 기존 항목을 비교하고 있습니다.`;
      state.mergeAnalysisWarnings = [];
      state.mergeDecisions = [];
      updateStatus("analyzing_merge", "기존 로어북과 초안 항목을 의미 단위로 비교하고 있습니다.");
      render();

      try {
        const results = [];
        for (let index = 0; index < plan.chunks.length; index += 1) {
          state.mergeAnalysisMessage = `AI 병합 분석 중 ${index + 1}/${plan.chunks.length}`;
          render();
          results.push(await generateValidatedMergeJson(
            mergeCore.buildAnalysisMessages({
              analysisStage: "compare",
              chunkIndex: index + 1,
              totalChunks: plan.chunks.length,
              selectedLorebook: plan.lorebook,
              draftLorebook: {
                name: state.draft.lorebook.name,
                description: state.draft.lorebook.description,
                category: state.draft.lorebook.category,
              },
              draftEntries: plan.draftRows,
              existingEntries: plan.chunks[index],
            }),
            plan,
            requestNumber,
            "로어북 병합 분석",
          ));
        }
        const finalResult = results.length === 1
          ? results[0]
          : await generateValidatedMergeJson(
              mergeCore.buildReduceMessages({
                analysisStage: "reduce",
                selectedLorebook: plan.lorebook,
                draftEntries: plan.draftRows,
                candidateResults: results,
              }),
              plan,
              requestNumber,
              "로어북 병합 통합",
            );
        if (fingerprint !== mergeAnalysisFingerprint()) {
          state.mergeAnalysisStatus = "stale";
          state.mergeAnalysisMessage = "분석 중 초안 또는 기존 항목이 변경되어 결과를 적용하지 않았습니다.";
          state.mergeAnalysisFingerprint = "";
          state.mergeDecisions = [];
          return;
        }
        const proposals = new Map(finalResult.proposals.map((proposal) => [proposal.draftEntryId, proposal]));
        const allDraftRows = mergeCore.draftEntries(state.draft.lorebook.entries);
        state.mergeDecisions = allDraftRows.map((draftRow) => {
          const proposal = proposals.get(draftRow.draftEntryId);
          if (!proposal) return null;
          const existing = plan.existingRows.find((entry) => entry.id === proposal.matchedExistingEntryId);
          const base = existing
            ? assetCore.buildMergedEntry(existing, draftRow, proposal.action)
            : assetCore.buildEntryPayload(draftRow);
          return {
            action: assetCore.normalizeMergeAction(proposal.action),
            targetEntryId: proposal.matchedExistingEntryId,
            suggestedTargetId: proposal.matchedExistingEntryId,
            confirmed: false,
            reason: proposal.reason,
            warnings: [...proposal.warnings],
            finalEntry: {
              ...base,
              name: proposal.proposedName || base.name,
              content: proposal.proposedContent || base.content,
              keys: proposal.proposedKeys.length ? proposal.proposedKeys : base.keys,
              secondaryKeys: proposal.proposedSecondaryKeys.length
                ? proposal.proposedSecondaryKeys
                : base.secondaryKeys,
            },
          };
        });
        state.mergeAnalysisStatus = "success";
        state.mergeAnalysisFingerprint = fingerprint;
        state.mergeAnalysisWarnings = [...finalResult.warnings];
        state.mergeAnalysisMessage = `${plan.draftRows.length}개 초안 항목의 AI 병합 제안을 만들었습니다.`;
        updateStatus("success", "AI 병합 분석을 완료했습니다. 각 항목의 결정을 검토하고 확인하세요.");
      } catch (error) {
        if (requestNumber !== state.activeRequest) return;
        state.mergeAnalysisFingerprint = "";
        state.mergeDecisions = [];
        if (state.abortRequested || error?.name === "AbortError") {
          state.mergeAnalysisStatus = "aborted";
          state.mergeAnalysisMessage = "AI 병합 분석을 취소했습니다.";
          updateStatus("aborted", state.mergeAnalysisMessage);
        } else {
          state.mergeAnalysisStatus = "error";
          state.mergeAnalysisMessage = `AI 병합 분석에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`;
          updateStatus("generation_error", state.mergeAnalysisMessage);
        }
      } finally {
        state.activeRunId = "";
        render();
      }
    };

    const currentSaveFingerprint = () => {
      const strategy = state.lorebookSaveStrategy;
      const activeEntries = (state.draft?.lorebook?.entries || []).flatMap((entry, index) =>
        state.excludedEntries.has(index)
          ? []
          : [{
              index,
              entry: assetCore.buildEntryPayload(entry),
              decision: strategy === "merge" && state.mergeDecisions[index]
                ? {
                    action: state.mergeDecisions[index].action,
                    targetEntryId: state.mergeDecisions[index].targetEntryId,
                    confirmed: state.mergeDecisions[index].confirmed,
                    finalEntry: state.mergeDecisions[index].finalEntry,
                  }
                : null,
            }],
      );
      return assetCore.reviewFingerprint({
        character: assetCore.buildCharacterPayload(state.draft),
        lorebook: strategy === "new"
          ? {
              name: state.draft?.lorebook?.name || "",
              description: state.draft?.lorebook?.description || "",
              category: "character",
              isGlobal: false,
            }
          : { id: state.selectedLorebookId },
        strategy,
        activeEntries,
      });
    };

    const emptySavePart = (name = "") => ({ status: "idle", id: "", name, error: "" });
    const createSaveResult = (fingerprint, strategy) => ({
      fingerprint,
      strategy,
      character: emptySavePart(state.draft?.character?.name || ""),
      lorebook: emptySavePart(state.draft?.lorebook?.name || ""),
      link: emptySavePart(),
      entryResults: [],
      completedAt: "",
    });

    const resultForOperation = (result, operation, type) => {
      let item = result.entryResults.find((candidate) => candidate.key === operation.key);
      if (!item) {
        item = {
          key: operation.key,
          type,
          name: operation.name,
          targetEntryId: operation.targetEntryId || "",
          id: "",
          status: "idle",
          error: "",
        };
        result.entryResults.push(item);
      }
      return item;
    };

    const saveResultFailures = (result) => {
      if (!result) return [];
      const failures = [];
      for (const [label, part] of [["캐릭터", result.character], ["로어북", result.lorebook], ["캐릭터-로어북 연결", result.link]]) {
        if (part?.status === "failed") failures.push({ name: label, error: part.error });
      }
      for (const entry of result.entryResults) {
        if (entry.status === "failed") failures.push({ name: entry.name || entry.key, error: entry.error });
      }
      return failures;
    };

    const saveResultComplete = (result) =>
      !!result &&
      result.character.status === "success" &&
      result.lorebook.status === "success" &&
      (result.link.status === "success" || result.link.status === "skipped") &&
      result.entryResults.every((item) => item.status === "success" || item.status === "skipped") &&
      saveResultFailures(result).length === 0;

    const reconcileBulkCreateFailure = async (lorebookId, baselineIds, operations, errorMessage, result) => {
      let currentEntries = [];
      try {
        currentEntries = normalizeExistingEntries(await apiRequest(`/api/lorebooks/${encodeURIComponent(lorebookId)}/entries`));
      } catch {
        currentEntries = [];
      }
      const candidates = currentEntries.filter((entry) => !baselineIds.has(entry.id));
      const claimed = new Set();
      for (const operation of operations) {
        const match = candidates.find((entry) => !claimed.has(entry.id) && assetCore.canonicalEntry(entry) === assetCore.canonicalEntry(operation.payload));
        const item = resultForOperation(result, operation, "create");
        if (match) {
          claimed.add(match.id);
          item.id = match.id;
          item.status = "success";
          item.error = "";
        } else {
          item.status = "failed";
          item.error = errorMessage;
        }
      }
      state.existingEntries = currentEntries;
    };

    const executeAssetSave = async () => {
      if (state.assetSaving || !state.draft || !state.assetSaveConfirmed) return;
      const strategy = state.lorebookSaveStrategy;
      if (strategy === "merge" && !mergeAnalysisReady()) {
        state.assetSaveMessage = "현재 초안과 기존 로어북에 대한 AI 병합 분석을 먼저 완료하세요.";
        state.assetSaveConfirmed = false;
        render();
        return;
      }
      if (strategy !== "new") {
        if (state.lorebooksStatus !== "success") {
          state.assetSaveMessage = "기존 로어북 목록을 먼저 불러오세요.";
          render();
          return;
        }
        if (!state.lorebooks.some((book) => book.id === state.selectedLorebookId)) {
          state.assetSaveMessage = "사용 가능한 기존 로어북을 선택하세요.";
          render();
          return;
        }
        if (strategy === "merge" && state.existingEntriesStatus !== "success") {
          state.assetSaveMessage = "병합할 기존 항목을 먼저 불러오세요.";
          render();
          return;
        }
      }
      const plan = assetCore.buildSavePlan({
        draft: state.draft,
        excludedEntries: [...state.excludedEntries],
        strategy,
        selectedLorebookId: state.selectedLorebookId,
        existingEntries: state.existingEntries,
        mergeDecisions: state.mergeDecisions,
      });
      if (plan.errors.length) {
        state.assetSaveMessage = plan.errors.join(" ");
        render();
        return;
      }

      const fingerprint = currentSaveFingerprint();
      if (state.assetSaveResult?.fingerprint === fingerprint && saveResultComplete(state.assetSaveResult)) {
        state.assetSaveMessage = "이 검토 상태는 이미 저장되었습니다. 새로 저장하려면 검토 내용을 변경하고 다시 확인하세요.";
        state.assetSaveConfirmed = false;
        render();
        return;
      }
      const result = state.assetSaveResult?.fingerprint === fingerprint
        ? state.assetSaveResult
        : createSaveResult(fingerprint, strategy);
      state.assetSaveResult = result;
      state.assetSaving = true;
      state.assetSaveMessage = "Marinara 자산을 저장하는 중입니다.";
      render();

      try {
        if (result.character.status !== "success" || !result.character.id) {
          result.character.status = "pending";
          result.character.error = "";
          render();
          try {
            const createdCharacter = await apiRequest("/api/characters", { method: "POST", body: plan.characterPayload });
            if (!createdCharacter || typeof createdCharacter.id !== "string" || !createdCharacter.id) {
              throw new Error("캐릭터 생성 API가 ID를 반환하지 않았습니다.");
            }
            result.character = {
              status: "success",
              id: createdCharacter.id,
              name: state.draft.character.name.trim(),
              error: "",
            };
          } catch (error) {
            result.character.status = "failed";
            result.character.error = error instanceof Error ? error.message : String(error);
            return;
          }
        }

        if (strategy === "new") {
          if (result.lorebook.status !== "success" || !result.lorebook.id) {
            result.lorebook.status = "pending";
            result.lorebook.error = "";
            render();
            try {
              const createdLorebook = await apiRequest("/api/lorebooks", {
                method: "POST",
                body: assetCore.buildLorebookPayload(state.draft, result.character.id),
              });
              if (!createdLorebook || typeof createdLorebook.id !== "string" || !createdLorebook.id) {
                throw new Error("로어북 생성 API가 ID를 반환하지 않았습니다.");
              }
              result.lorebook = {
                status: "success",
                id: createdLorebook.id,
                name: typeof createdLorebook.name === "string" ? createdLorebook.name : state.draft.lorebook.name.trim(),
                error: "",
              };
            } catch (error) {
              result.lorebook.status = "failed";
              result.lorebook.error = error instanceof Error ? error.message : String(error);
              return;
            }
          }
        } else {
          const selected = state.lorebooks.find((book) => book.id === state.selectedLorebookId);
          result.lorebook = {
            status: "success",
            id: state.selectedLorebookId,
            name: selected?.name || result.lorebook.name || "기존 로어북",
            error: "",
          };
        }

        const selectedLorebook = strategy === "new"
          ? { category: "character", personaIds: [], personaId: "" }
          : state.lorebooks.find((book) => book.id === state.selectedLorebookId);
        const canEmbedLorebook = selectedLorebook?.category === "character" &&
          !selectedLorebook.personaId && !(selectedLorebook.personaIds?.length);
        if (!canEmbedLorebook) {
          result.link = {
            status: "skipped",
            id: result.lorebook.id,
            name: result.lorebook.name,
            error: "선택한 로어북 종류는 캐릭터 카드에 연결할 수 없어 항목 저장만 진행했습니다.",
          };
        } else if (result.link.status !== "success") {
          result.link.status = "pending";
          result.link.error = "";
          render();
          try {
            await apiRequest(`/api/characters/${encodeURIComponent(result.character.id)}/embedded-lorebook/embed`, {
              method: "POST",
              body: { lorebookId: result.lorebook.id },
            });
            result.link = { status: "success", id: result.lorebook.id, name: result.lorebook.name, error: "" };
          } catch (error) {
            result.link.status = "failed";
            result.link.error = error instanceof Error ? error.message : String(error);
          }
        }

        for (const skipped of plan.skips) {
          const item = resultForOperation(result, skipped, "skip");
          item.status = "skipped";
          item.error = "";
        }

        const pendingCreates = plan.creates.filter((operation) => resultForOperation(result, operation, "create").status !== "success");
        if (pendingCreates.length > 1) {
          const baselineEntries = normalizeExistingEntries(
            await apiRequest(`/api/lorebooks/${encodeURIComponent(result.lorebook.id)}/entries`),
          );
          const baselineIds = new Set(baselineEntries.map((entry) => entry.id));
          for (const operation of pendingCreates) {
            const item = resultForOperation(result, operation, "create");
            item.status = "pending";
            item.error = "";
          }
          render();
          try {
            const createdEntries = await apiRequest(`/api/lorebooks/${encodeURIComponent(result.lorebook.id)}/entries/bulk`, {
              method: "POST",
              body: { entries: pendingCreates.map((operation) => operation.payload) },
            });
            if (!Array.isArray(createdEntries) || createdEntries.length !== pendingCreates.length) {
              throw new Error("항목 일괄 생성 API가 예상한 결과 수를 반환하지 않았습니다.");
            }
            pendingCreates.forEach((operation, index) => {
              const created = createdEntries[index];
              const item = resultForOperation(result, operation, "create");
              item.id = typeof created?.id === "string" ? created.id : "";
              item.status = "success";
              item.error = "";
            });
          } catch (error) {
            await reconcileBulkCreateFailure(
              result.lorebook.id,
              baselineIds,
              pendingCreates,
              error instanceof Error ? error.message : String(error),
              result,
            );
          }
        } else if (pendingCreates.length === 1) {
          const operation = pendingCreates[0];
          const item = resultForOperation(result, operation, "create");
          item.status = "pending";
          item.error = "";
          render();
          try {
            const created = await apiRequest(`/api/lorebooks/${encodeURIComponent(result.lorebook.id)}/entries`, {
              method: "POST",
              body: operation.payload,
            });
            item.id = typeof created?.id === "string" ? created.id : "";
            item.status = "success";
          } catch (error) {
            item.status = "failed";
            item.error = error instanceof Error ? error.message : String(error);
          }
        }

        for (const operation of plan.updates) {
          const item = resultForOperation(result, operation, "update");
          if (item.status === "success") continue;
          item.status = "pending";
          item.error = "";
          render();
          try {
            const updated = await apiRequest(
              `/api/lorebooks/${encodeURIComponent(result.lorebook.id)}/entries/${encodeURIComponent(operation.targetEntryId)}`,
              { method: "PATCH", body: operation.payload },
            );
            item.id = typeof updated?.id === "string" ? updated.id : operation.targetEntryId;
            item.status = "success";
          } catch (error) {
            item.status = "failed";
            item.error = error instanceof Error ? error.message : String(error);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const part of [result.character, result.lorebook, result.link]) {
          if (part.status === "pending") {
            part.status = "failed";
            part.error = message;
          }
        }
        for (const operation of [...plan.creates, ...plan.updates]) {
          const item = resultForOperation(result, operation, operation.targetEntryId ? "update" : "create");
          if (item.status !== "success" && item.status !== "skipped") {
            item.status = "failed";
            item.error = message;
          }
        }
      } finally {
        state.assetSaving = false;
        state.assetSaveConfirmed = false;
        result.completedAt = new Date().toISOString();
        const failures = saveResultFailures(result);
        const successfulEntries = result.entryResults.filter((item) => item.status === "success").length;
        state.assetSaveMessage = failures.length
          ? `${successfulEntries}개 항목 저장 완료, ${failures.length}개 항목 실패. 실패 항목만 재시도할 수 있습니다.`
          : `${successfulEntries}개 항목과 캐릭터·로어북 저장을 완료했습니다.`;
        render();
      }
    };

    const savedDraftStatus = (draft) => {
      const result = draft.snapshot?.assetSaveResult;
      if (saveResultComplete(result)) return "Marinara 저장 완료";
      const hasSuccess = (
        !!result && [result.character, result.lorebook, result.link]
          .some((part) => part?.status === "success")
      ) || !!result?.entryResults?.some((entry) => entry.status === "success");
      return hasSuccess ? "일부 저장" : "초안";
    };

    const renderSavedDraftsPanel = () => {
      const section = createElement("section", { className: "pc-saved-drafts" });
      const dirty = currentSavedDraftDirty();
      const header = createElement("button", { className: "pc-saved-drafts-header", type: "button" });
      const title = createElement("span", { className: "pc-saved-drafts-title" });
      title.append(
        createElement("span", { className: "pc-saved-drafts-label", text: "저장된 초안" }),
        createElement("span", { text: `${state.savedDrafts.length.toLocaleString()}개` }),
      );
      if (dirty) title.append(createElement("span", { className: "pc-dirty-badge", text: "미저장 변경" }));
      const indicator = createElement("span", { className: "pc-saved-drafts-indicator" });
      indicator.setAttribute("aria-hidden", "true");
      header.setAttribute("aria-label", state.savedDraftsOpen ? "저장된 초안 목록 닫기" : "저장된 초안 목록 열기");
      header.setAttribute("aria-expanded", String(state.savedDraftsOpen));
      header.setAttribute("aria-controls", "pc-saved-draft-list");
      header.addEventListener("click", () => {
        state.savedDraftsOpen = !state.savedDraftsOpen;
        render();
      });
      header.append(title, indicator);
      section.append(header);
      if (state.savedDraftMessage) {
        section.append(createElement("p", { className: "pc-saved-drafts-message", role: "status", text: state.savedDraftMessage }));
      }
      if (!state.savedDraftsOpen) return section;
      const list = createElement("div", { className: "pc-saved-draft-list", id: "pc-saved-draft-list" });
      if (!state.savedDrafts.length) {
        list.append(createElement("div", { className: "pc-saved-drafts-empty", text: "저장된 초안이 없습니다." }));
      }
      const drafts = [...state.savedDrafts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const draft of drafts) {
        const row = createElement("article", { className: "pc-saved-draft-row" });
        row.dataset.active = String(draft.id === state.activeSavedDraftId);
        const summary = createElement("div", { className: "pc-saved-draft-summary" });
        const nameRow = createElement("div", { className: "pc-saved-draft-name" });
        nameRow.append(createElement("strong", { text: draft.name }));
        if (draft.id === state.activeSavedDraftId) nameRow.append(createElement("span", { text: "현재 작업" }));
        summary.append(
          nameRow,
          createElement("span", {
            className: "pc-saved-draft-meta",
            text: `${savedDraftStatus(draft)} · ${new Date(draft.updatedAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}`,
          }),
        );
        const actions = createElement("div", { className: "pc-saved-draft-actions" });
        const open = createElement("button", { className: "pc-button pc-button-secondary pc-button-small", type: "button", text: "열기" });
        open.disabled = state.savedDraftBusy || isWorking() || draft.id === state.activeSavedDraftId && !dirty;
        open.addEventListener("click", () => void openSavedDraft(draft.id));
        const rename = createElement("button", { className: "pc-button pc-button-secondary pc-button-small", type: "button", text: "이름 변경" });
        rename.disabled = state.savedDraftBusy || isWorking();
        rename.addEventListener("click", () => void renameSavedDraft(draft.id));
        const remove = createElement("button", { className: "pc-button pc-button-secondary pc-button-small pc-button-danger", type: "button", text: "삭제" });
        remove.disabled = state.savedDraftBusy || isWorking();
        remove.addEventListener("click", () => void deleteSavedDraft(draft.id));
        actions.append(open, rename, remove);
        row.append(summary, actions);
        list.append(row);
      }
      section.append(list);
      return section;
    };

    const renderWorkspace = () => {
      const container = createElement("div", { className: "pc-workspace-view" });
      container.append(renderSavedDraftsPanel());
      const empty = createElement("section", { className: "pc-workspace-empty" });
      empty.append(
        createElement("h3", { text: "현재 분석 결과가 없습니다" }),
        createElement("p", {
          text: "프롬프트 이식에서 분석하거나 위 목록에서 저장된 초안을 여세요.",
        }),
      );
      const move = createElement("button", { className: "pc-button pc-button-primary", type: "button", text: "프롬프트 이식으로 이동" });
      move.addEventListener("click", () => {
        state.view = "input";
        state.navigationView = "prompt";
        render();
      });
      empty.append(move);
      container.append(empty);
      return container;
    };

    const renderReview = () => {
      const draft = state.draft;
      const container = createElement("div", { className: "pc-review-view" });
      container.append(renderSavedDraftsPanel());

      const character = createElement("section", { className: "pc-review-section" });
      character.append(createElement("h3", { text: "캐릭터" }));
      const characterGrid = createElement("div", { className: "pc-review-grid" });
      addReviewField(characterGrid, "이름", draft.character.name, (value) => {
        draft.character.name = value;
      }, 1);
      addReviewField(characterGrid, "태그", draft.character.tags.join(", "), (value) => {
        draft.character.tags = stringList(value);
      }, 1, "쉼표 또는 줄바꿈으로 구분");
      addReviewField(characterGrid, "설명", draft.character.description, (value) => {
        draft.character.description = value;
      });
      addReviewField(characterGrid, "성격", draft.character.personality, (value) => {
        draft.character.personality = value;
      });
      addReviewField(characterGrid, "상황", draft.character.scenario, (value) => {
        draft.character.scenario = value;
      });
      addReviewField(characterGrid, "외모", draft.character.extensions.appearance, (value) => {
        draft.character.extensions.appearance = value;
      });
      addReviewField(characterGrid, "배경", draft.character.extensions.backstory, (value) => {
        draft.character.extensions.backstory = value;
      });
      addReviewField(characterGrid, "캐릭터 시스템 프롬프트", draft.character.system_prompt, (value) => {
        draft.character.system_prompt = value;
      });
      addReviewField(characterGrid, "후속 지침", draft.character.post_history_instructions, (value) => {
        draft.character.post_history_instructions = value;
      });
      addReviewField(characterGrid, "첫 메시지", draft.character.first_mes, (value) => {
        draft.character.first_mes = value;
      });
      addReviewField(characterGrid, "대화 예시", draft.character.mes_example, (value) => {
        draft.character.mes_example = value;
      });
      addReviewField(characterGrid, "제작자 메모 (AI에게 전달 안됨)", draft.character.creator_notes, (value) => {
        draft.character.creator_notes = value;
      });
      character.append(characterGrid);
      container.append(character);

      const lorebook = createElement("section", { className: "pc-review-section" });
      const loreHeader = createElement("div", { className: "pc-review-heading" });
      loreHeader.append(
        createElement("h3", { text: "로어북" }),
        createElement("span", { text: `${draft.lorebook.entries.length}개 항목` }),
      );
      lorebook.append(loreHeader);
      const loreGrid = createElement("div", { className: "pc-review-grid pc-review-grid-compact" });
      addReviewField(loreGrid, "이름", draft.lorebook.name, (value) => {
        draft.lorebook.name = value;
      }, 1);
      const categorySelect = createElement("select");
      const lorebookCategoryLabels = {
        world: "세계관",
        character: "캐릭터",
        npc: "NPC",
        spellbook: "주문서",
        uncategorized: "미분류",
      };
      for (const category of core.LOREBOOK_CATEGORIES) categorySelect.append(option(category, lorebookCategoryLabels[category] || category));
      categorySelect.value = draft.lorebook.category;
      categorySelect.addEventListener("change", () => {
        draft.lorebook.category = categorySelect.value;
      });
      loreGrid.append(makeField("분류", categorySelect));
      addReviewField(loreGrid, "설명", draft.lorebook.description, (value) => {
        draft.lorebook.description = value;
      });
      lorebook.append(loreGrid);

      const entries = createElement("div", { className: "pc-entry-list" });
      if (draft.lorebook.entries.length === 0) {
        entries.append(createElement("div", { className: "pc-empty", text: "분류된 로어북 항목이 없습니다." }));
      }
      draft.lorebook.entries.forEach((entry, index) => {
        const card = createElement("article", { className: "pc-entry" });
        card.dataset.excluded = String(state.excludedEntries.has(index));
        const entryHeader = createElement("div", { className: "pc-entry-header" });
        entryHeader.append(createElement("strong", { text: `항목 ${index + 1}` }));
        const excludeLabel = createElement("label", { className: "pc-entry-exclude" });
        const exclude = createElement("input");
        const setEntryControlsDisabled = (disabled) => {
          for (const control of card.querySelectorAll("input, textarea")) {
            if (control !== exclude) control.disabled = disabled;
          }
        };
        exclude.type = "checkbox";
        exclude.checked = state.excludedEntries.has(index);
        exclude.addEventListener("change", () => {
          if (exclude.checked) state.excludedEntries.add(index);
          else state.excludedEntries.delete(index);
          card.dataset.excluded = String(exclude.checked);
          setEntryControlsDisabled(exclude.checked);
        });
        excludeLabel.append(exclude, createElement("span", { text: "항목 제외" }));
        entryHeader.append(excludeLabel);
        card.append(entryHeader);
        const grid = createElement("div", { className: "pc-entry-grid" });
        addReviewField(grid, "이름", entry.name, (value) => {
          entry.name = value;
        }, 1);
        addReviewField(grid, "키워드", entry.keys.join(", "), (value) => {
          entry.keys = stringList(value);
        }, 1, "쉼표 또는 줄바꿈으로 구분");
        addReviewField(grid, "보조 키워드", entry.secondaryKeys.join(", "), (value) => {
          entry.secondaryKeys = stringList(value);
        }, 1, "쉼표 또는 줄바꿈으로 구분");
        addReviewField(grid, "내용", entry.content, (value) => {
          entry.content = value;
        }, 5);
        const flags = createElement("div", { className: "pc-entry-flags" });
        for (const [label, key] of [
          ["상시 활성", "constant"],
          ["선택 활성", "selective"],
        ]) {
          const flag = createElement("label");
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = entry[key];
          checkbox.addEventListener("change", () => {
            entry[key] = checkbox.checked;
          });
          flag.append(checkbox, createElement("span", { text: label }));
          flags.append(flag);
        }
        grid.append(flags);
        card.append(grid);
        if (state.excludedEntries.has(index)) setEntryControlsDisabled(true);
        entries.append(card);
      });
      lorebook.append(entries);
      container.append(lorebook);

      const integration = createElement("section", { className: "pc-review-section" });
      integration.append(
        createElement("h3", { text: "로어북 저장 방식" }),
        createElement("p", {
          className: "pc-section-copy",
          text: "새 캐릭터를 만든 뒤 선택한 로어북을 공식 연결 API로 캐릭터 카드에 연결합니다. 새 로어북은 캐릭터 전용 비전역 로어북으로 저장됩니다.",
        }),
      );
      const strategySelect = createElement("select");
      for (const [value, label] of [
        ["new", "새 로어북 생성"],
        ["append", "기존 로어북에 신규 항목 추가"],
        ["merge", "기존 로어북과 항목 단위 병합"],
      ]) strategySelect.append(option(value, label));
      strategySelect.value = state.lorebookSaveStrategy;
      strategySelect.addEventListener("change", () => {
        state.lorebookSaveStrategy = strategySelect.value;
        state.assetSaveConfirmed = false;
        state.assetSaveMessage = "";
        state.mergeAnalysisStatus = "idle";
        state.mergeAnalysisFingerprint = "";
        state.mergeAnalysisMessage = "";
        state.mergeAnalysisWarnings = [];
        state.mergeDecisions = [];
        if (strategySelect.value !== "new" && state.lorebooksStatus === "idle") void loadLorebooks();
        render();
      });
      const integrationGrid = createElement("div", { className: "pc-review-grid" });
      integrationGrid.append(makeField("저장 방식", strategySelect, "프리셋 후보와 잔여 지침은 저장하지 않습니다."));
      if (state.lorebookSaveStrategy !== "new") {
        const lorebookSelect = createElement("select");
        lorebookSelect.append(option("", state.lorebooksStatus === "loading" ? "불러오는 중…" : "기존 로어북 선택"));
        for (const book of state.lorebooks) {
          const scope = book.isGlobal ? "전역" : book.category || "미분류";
          lorebookSelect.append(option(book.id, `${book.name} · ${scope}`));
        }
        lorebookSelect.value = state.selectedLorebookId;
        lorebookSelect.disabled = state.assetSaving || state.lorebooksStatus === "loading";
        lorebookSelect.addEventListener("change", () => {
          state.selectedLorebookId = lorebookSelect.value;
          state.existingEntries = [];
          state.existingEntriesStatus = lorebookSelect.value ? "loading" : "idle";
          state.existingEntriesMessage = "";
          state.mergeDecisions = [];
          state.mergeAnalysisStatus = "idle";
          state.mergeAnalysisFingerprint = "";
          state.mergeAnalysisMessage = "";
          state.mergeAnalysisWarnings = [];
          state.assetSaveConfirmed = false;
          render();
          if (lorebookSelect.value) void loadExistingEntries(lorebookSelect.value);
        });
        integrationGrid.append(makeField("기존 로어북", lorebookSelect, state.lorebooksMessage));
        const refresh = createElement("button", {
          className: "pc-button pc-button-secondary pc-button-small pc-lorebook-refresh",
          type: "button",
          text: "로어북 목록 새로고침",
        });
        refresh.disabled = state.assetSaving || state.lorebooksStatus === "loading";
        refresh.addEventListener("click", () => void loadLorebooks());
        integrationGrid.append(refresh);
      }
      integration.append(integrationGrid);
      if (state.lorebookSaveStrategy === "merge") integration.append(renderMergeReview());
      container.append(integration);

      const presets = createElement("details", { className: "pc-review-section pc-collapsible-review pc-preset-section" });
      presets.append(createElement("summary", { text: "프리셋 후보" }));
      const presetBody = createElement("div", { className: "pc-collapsible-review-body" });
      presetBody.append(
        createElement("p", {
          className: "pc-section-copy",
          text: "전체 RP 문체, 시점, 출력 형식, 전역 생성 규칙 후보입니다. 실제 Marinara 프리셋은 생성하지 않습니다.",
        }),
      );
      const presetList = createElement("div", { className: "pc-entry-list" });
      if (draft.presetCandidates.length === 0) {
        presetList.append(createElement("div", { className: "pc-empty", text: "분류된 프리셋 후보가 없습니다." }));
      }
      draft.presetCandidates.forEach((candidate, index) => {
        const card = createElement("article", { className: "pc-entry pc-preset-candidate" });
        card.dataset.excluded = String(state.excludedPresetCandidates.has(index));
        const heading = createElement("div", { className: "pc-entry-header" });
        heading.append(createElement("strong", { text: `프리셋 후보 ${index + 1}` }));
        const excludeLabel = createElement("label", { className: "pc-entry-exclude" });
        const exclude = createElement("input");
        const setCandidateControlsDisabled = (disabled) => {
          for (const control of card.querySelectorAll("input, textarea, select")) {
            if (control !== exclude) control.disabled = disabled;
          }
        };
        exclude.type = "checkbox";
        exclude.checked = state.excludedPresetCandidates.has(index);
        exclude.addEventListener("change", () => {
          if (exclude.checked) state.excludedPresetCandidates.add(index);
          else state.excludedPresetCandidates.delete(index);
          card.dataset.excluded = String(exclude.checked);
          setCandidateControlsDisabled(exclude.checked);
        });
        excludeLabel.append(exclude, createElement("span", { text: "후보 제외" }));
        heading.append(excludeLabel);
        card.append(heading);
        const grid = createElement("div", { className: "pc-entry-grid pc-preset-grid" });
        addReviewField(grid, "이름", candidate.name, (value) => {
          candidate.name = value;
        }, 1);
        const presetCategory = createElement("select");
        const presetCategoryLabels = {
          system: "시스템",
          style: "문체",
          format: "출력 형식",
          pov: "시점",
          other: "기타",
        };
        for (const category of core.PRESET_CATEGORIES) presetCategory.append(option(category, presetCategoryLabels[category] || category));
        presetCategory.value = candidate.category;
        presetCategory.addEventListener("change", () => {
          candidate.category = presetCategory.value;
        });
        grid.append(makeField("분류", presetCategory));
        addReviewField(grid, "내용", candidate.content, (value) => {
          candidate.content = value;
        }, 6);
        card.append(grid);
        if (state.excludedPresetCandidates.has(index)) setCandidateControlsDisabled(true);
        presetList.append(card);
      });
      presetBody.append(presetList);
      presets.append(presetBody);
      container.append(presets);

      const residual = createElement("section", { className: "pc-review-section" });
      residual.append(createElement("h3", { text: "잔여 지침 / 경고" }));
      const residualGrid = createElement("div", { className: "pc-review-grid" });
      addReviewField(residualGrid, "잔여 지침", draft.residualInstructions, (value) => {
        draft.residualInstructions = value;
      }, 6, "적용 범위가 불명확해 캐릭터, 로어북, 프리셋 후보로 안전하게 분류하지 못한 지침");
      addReviewField(residualGrid, "경고", draft.warnings.join("\n"), (value) => {
        draft.warnings = String(value)
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean);
      }, 5, "한 줄에 하나씩 수정할 수 있습니다.");
      residual.append(residualGrid);
      container.append(residual);

      const saveSection = createElement("section", { className: "pc-review-section pc-save-section" });
      saveSection.append(
        createElement("h3", { text: "Marinara 카드로 저장" }),
        createElement("p", {
          className: "pc-section-copy",
          text: "캐릭터와 로어북 항목만 저장합니다. 프리셋 후보와 잔여 지침은 검토 화면에 남습니다.",
        }),
      );
      const confirmation = createElement("label", { className: "pc-save-confirmation" });
      const confirmationInput = createElement("input");
      confirmationInput.type = "checkbox";
      confirmationInput.checked = state.assetSaveConfirmed;
      confirmationInput.disabled = state.assetSaving || (state.lorebookSaveStrategy === "merge" && !mergeAnalysisReady());
      confirmationInput.addEventListener("change", () => {
        state.assetSaveConfirmed = confirmationInput.checked;
        renderFooter();
      });
      confirmation.append(
        confirmationInput,
        createElement("span", { text: "검토 값을 확인했으며 실제 캐릭터와 로어북을 생성·수정합니다." }),
      );
      saveSection.append(confirmation);
      if (state.assetSaveMessage) {
        saveSection.append(createElement("div", {
          className: "pc-save-message",
          role: "status",
          text: state.assetSaveMessage,
        }));
      }
      const saveResult = renderAssetSaveResult();
      if (saveResult) saveSection.append(saveResult);
      container.append(saveSection);
      if (state.assetSaving) {
        container.dataset.saving = "true";
        for (const control of container.querySelectorAll("input, textarea, select, button")) control.disabled = true;
      }
      return container;
    };

    const renderFooter = () => {
      footer.textContent = "";
      footer.dataset.view = state.view;
      const sessionControls = () => {
        const controls = createElement("div", { className: "pc-session-controls" });
        const reset = createElement("button", {
          className: "pc-button pc-button-secondary pc-button-small",
          type: "button",
          text: "작업 초기화",
        });
        reset.disabled = isWorking() || state.savedDraftBusy;
        reset.addEventListener("click", () => void resetSession());
        controls.append(reset);
        if (sessionHasWork()) {
          const saveDraft = createElement("button", {
            className: "pc-button pc-button-secondary pc-button-small",
            type: "button",
            text: "초안 저장",
          });
          saveDraft.disabled = isWorking() || state.savedDraftBusy;
          saveDraft.addEventListener("click", () => void saveCurrentDraft());
          controls.append(saveDraft);
          if (state.activeSavedDraftId) {
            const updateDraft = createElement("button", {
              className: "pc-button pc-button-secondary pc-button-small",
              type: "button",
              text: "초안 업데이트",
            });
            updateDraft.disabled = isWorking() || state.savedDraftBusy || !currentSavedDraftDirty();
            updateDraft.addEventListener("click", () => void saveCurrentDraft({ updateExisting: true }));
            controls.append(updateDraft);
          }
        }
        const status = renderSessionStatus();
        if (status) controls.append(status);
        return controls;
      };
      if (state.view === "settings") {
        const resetAll = createElement("button", { className: "pc-button pc-button-secondary pc-reset-all", type: "button", text: "전체 기본값 복원" });
        resetAll.disabled = state.settingsSaving;
        resetAll.addEventListener("click", () => {
          state.settingsDraft = cloneSettings(core.DEFAULT_SETTINGS);
          state.settingsMessage = "전체 설정을 기본값으로 되돌렸습니다. 저장해야 적용됩니다.";
          render();
        });
        const saveButton = createElement("button", { className: "pc-button pc-button-primary", type: "button", text: state.settingsSaving ? "저장 중…" : "설정 저장" });
        saveButton.disabled = state.settingsSaving;
        saveButton.addEventListener("click", saveSettings);
        const actions = createElement("div", { className: "pc-footer-actions" });
        actions.append(saveButton);
        footer.append(resetAll, actions);
        return;
      }
      if (state.view === "workspace") {
        footer.append(sessionControls());
        return;
      }
      if (state.view === "review") {
        const back = createElement("button", { className: "pc-button pc-button-secondary", type: "button", text: "입력으로 돌아가기" });
        back.disabled = isWorking();
        back.addEventListener("click", () => {
          state.view = "input";
          state.navigationView = "prompt";
          updateStatus("idle", "기존 입력과 LLM 연결 선택을 유지했습니다.");
          render();
        });
        const right = createElement("div", { className: "pc-footer-actions" });
        const fingerprint = currentSaveFingerprint();
        const completed = state.assetSaveResult?.fingerprint === fingerprint && saveResultComplete(state.assetSaveResult);
        const failures = state.assetSaveResult?.fingerprint === fingerprint
          ? saveResultFailures(state.assetSaveResult)
          : [];
        const strategy = state.lorebookSaveStrategy;
        const targetReady = strategy === "new" || (
          state.lorebooksStatus === "success" &&
          state.lorebooks.some((book) => book.id === state.selectedLorebookId) &&
          (strategy !== "merge" || (state.existingEntriesStatus === "success" && mergeAnalysisReady()))
        );
        const saveButton = createElement("button", {
          className: "pc-button pc-button-primary",
          type: "button",
          text: state.assetSaving
            ? "저장 중…"
            : failures.length
              ? "실패 항목 재시도"
              : completed
                ? "저장 완료"
                : "캐릭터 + 로어북 저장",
        });
        saveButton.disabled = state.assetSaving || !state.assetSaveConfirmed || !targetReady || completed;
        saveButton.addEventListener("click", () => void executeAssetSave());
        right.append(
          createElement("span", { className: "pc-footer-note", text: "프리셋·잔여 지침 미저장" }),
          back,
          saveButton,
        );
        footer.append(sessionControls(), right);
        return;
      }
      const analyzeButton = createElement("button", { className: "pc-button pc-button-primary", type: "button", text: "AI 분석" });
      analyzeButton.dataset.idleText = "AI 분석";
      setButtonBusy(analyzeButton, "분석 중…", state.status === "analyzing");
      analyzeButton.disabled =
        state.status === "analyzing" ||
        state.status === "loading_connections" ||
        !state.selectedConnectionId ||
        state.connections.length === 0;
      analyzeButton.addEventListener("click", analyze);
      footer.append(sessionControls(), analyzeButton);
    };

    function render() {
      body.textContent = "";
      const activeNavigationView = state.navigationView;
      for (const button of navigation.querySelectorAll("button")) {
        const selected = button.dataset.view === activeNavigationView;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (button.dataset.view === "settings") button.disabled = isWorking() || !state.settingsLoaded;
      }
      body.append(
        state.view === "settings"
          ? renderSettings()
          : state.view === "workspace"
            ? renderWorkspace()
          : state.view === "review" && state.draft
            ? renderReview()
            : renderInput(),
      );
      renderFooter();
      scheduleSessionSave();
    }

    async function loadConnections() {
      const previousSelection = state.selectedConnectionId;
      updateStatus("loading_connections", "Marinara의 LLM 연결 목록을 불러오는 중입니다.");
      render();
      try {
        state.connections = normalizeConnections(await apiRequest("/api/connections"));
        state.selectedConnectionId = state.connections.some((connection) => connection.id === previousSelection)
          ? previousSelection
          : state.connections.find((connection) => connection.preferred)?.id || state.connections[0]?.id || "";
        if (state.connections.length === 0) {
          updateStatus("generation_error", "모델이 설정된 텍스트 생성용 연결이 없습니다.");
        } else {
          updateStatus("idle", `${state.connections.length}개의 텍스트 생성용 연결을 불러왔습니다.`);
        }
      } catch (error) {
        state.connections = [];
        state.selectedConnectionId = "";
        updateStatus("generation_error", `연결 목록을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
      render();
    }

    const requestClose = () => {
      if (isWorking()) {
        void abortAnalysis();
        return;
      }
      closeModal();
    };
    const keydown = (event) => {
      if (replacementDialog && event.key === "Tab") {
        const buttons = [...replacementDialog.element.querySelectorAll("button:not(:disabled)")];
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement);
        const next = event.shiftKey
          ? current <= 0 ? buttons.length - 1 : current - 1
          : current >= buttons.length - 1 ? 0 : current + 1;
        event.preventDefault();
        buttons[next].focus();
        return;
      }
      if (event.key === "Escape") {
        if (replacementDialog) closeReplacementDialog(false);
        else requestClose();
      }
    };
    closeButton.addEventListener("click", requestClose);
    const markSessionTouched = (event) => {
      state.sessionTouched = true;
      if (
        state.view === "review" &&
        event?.target instanceof Element &&
        !event.target.closest(".pc-save-confirmation")
      ) {
        state.assetSaveConfirmed = false;
        const confirmation = root.querySelector(".pc-save-confirmation input");
        if (confirmation instanceof HTMLInputElement) confirmation.checked = false;
        renderFooter();
      }
      markMergeAnalysisStaleIfNeeded();
      scheduleSessionSave();
    };
    root.addEventListener("input", markSessionTouched);
    root.addEventListener("change", markSessionTouched);
    root.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) state.sessionTouched = true;
      if (event.target === root) requestClose();
    });
    document.addEventListener("keydown", keydown);
    modalCleanup = () => {
      document.removeEventListener("keydown", keydown);
      closeReplacementDialog(false);
      if (sessionSaveTimer !== null) {
        hostMarinara.clearTimeout(sessionSaveTimer);
        sessionSaveTimer = null;
      }
      if (state.sessionHydrated) {
        const payload = buildSessionPayload();
        const serialized = JSON.stringify(payload);
        if (serialized !== lastSavedSession && new TextEncoder().encode(serialized).length <= SESSION_STORAGE_BUDGET_BYTES) {
          cachedSession = normalizeStoredSession(payload);
          void hostMarinara.storage.patch({ [SESSION_STORAGE_KEY]: payload }).catch((error) => {
            hostMarinara.log.warn("Prompt Converter session could not be saved on close", error);
          });
        }
      }
      if (state.activeRunId && isWorking()) {
        void abortRun(state.activeRunId).catch(() => {});
      }
      state.activeRequest += 1;
    };

    render();
    closeButton.focus();
    void settingsReady.then((settings) => {
      if (modalRoot !== root) return;
      if (!state.sessionHydrated && cachedSession && !state.sessionTouched) applyRestoredSession(cachedSession);
      state.sessionHydrated = true;
      state.savedDrafts = cloneJson(cachedSavedDrafts);
      state.settings = cloneSettings(cachedSession?.analysisSettings || settings);
      if (state.view === "settings") state.settingsDraft = cloneSettings(state.settings);
      const activeSavedDraft = state.savedDrafts.find((draft) => draft.id === state.activeSavedDraftId);
      state.savedDraftBaselineFingerprint = activeSavedDraft
        ? savedDraftFingerprint(activeSavedDraft.snapshot)
        : "";
      state.settingsLoaded = true;
      render();
      return Promise.all([
        loadConnections(),
        state.chatReferenceEnabled ? loadConversationSource() : Promise.resolve(),
        state.draft ? loadLorebooks() : Promise.resolve(),
      ]);
    });
  }

  migrationCenter.openPrompt = () => openConverter("input");
  migrationCenter.openWorkspace = () => openConverter("workspace");
  migrationCenter.openSettings = () => openConverter("settings");
  migrationCenter.closePrompt = closeModal;

  hostMarinara.onCleanup(() => {
    closeModal();
    delete migrationCenter.openPrompt;
    delete migrationCenter.openWorkspace;
    delete migrationCenter.openSettings;
    delete migrationCenter.closePrompt;
    if (!migrationCenter.openImport) delete globalThis.MarinaraMigrationCenter;
    delete globalThis.MarinaraPromptConverterCore;
    delete globalThis.MarinaraChatExtractionCore;
    delete globalThis.MarinaraAssetSaveCore;
  });

  hostMarinara.log.info("Prompt Converter loaded");
})();
