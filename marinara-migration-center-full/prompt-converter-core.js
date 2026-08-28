(() => {
  "use strict";

  const promptTemplates = globalThis.MarinaraPromptConversionPrompts;
  const repairPrompts = globalThis.MarinaraJsonRepairPrompts;
  if (!promptTemplates || !repairPrompts) {
    throw new Error("Prompt Converter prompt modules are unavailable");
  }
  const {
    ANALYSIS_SYSTEM_PROMPT,
    CHAT_DERIVED_SOURCE_INSTRUCTIONS,
    CORE_ANALYZER_INSTRUCTIONS,
    DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
    EXTERNAL_LOREBOOK_SOURCE_INSTRUCTIONS,
    FIXED_OUTPUT_INSTRUCTIONS,
  } = promptTemplates;

  const LOREBOOK_CATEGORIES = Object.freeze(["world", "character", "npc", "spellbook", "uncategorized"]);
  const CONVERSION_MODES = Object.freeze(["preserve", "normalize"]);
  const PRESET_CATEGORIES = Object.freeze(["style", "pov", "format", "system", "behavior", "other"]);
  const SOURCE_FIELDS = Object.freeze(["combined", "character", "worldLore", "systemStyle", "other"]);
  const PREVIOUS_DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS = "Do not apply any additional content or formatting preferences.";
  const LOREBOOK_WRITE_POLICY = Object.freeze({
    allowPartialSuccess: true,
    preserveSuccessfulItems: true,
    retryFailedItems: true,
    deleteExistingAssets: false,
    rollbackExistingAssets: false,
    cleanupOnlyIncompleteNewAssets: true,
    preventDuplicateSubmissions: true,
  });

  class DraftValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = "DraftValidationError";
    }
  }

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function requireRecord(value, path) {
    if (!isRecord(value)) throw new DraftValidationError(`${path} 객체가 필요합니다.`);
    return value;
  }

  function optionalString(record, key, path) {
    if (!hasOwn(record, key) || record[key] === null) return "";
    if (typeof record[key] !== "string") throw new DraftValidationError(`${path}.${key}는 문자열이어야 합니다.`);
    return record[key];
  }

  function optionalBoolean(record, key, path, fallback = false) {
    if (!hasOwn(record, key) || record[key] === null) return fallback;
    if (typeof record[key] !== "boolean") throw new DraftValidationError(`${path}.${key}는 참/거짓 값이어야 합니다.`);
    return record[key];
  }

  function optionalStringArray(record, key, path) {
    if (!hasOwn(record, key) || record[key] === null) return [];
    if (!Array.isArray(record[key]) || record[key].some((value) => typeof value !== "string")) {
      throw new DraftValidationError(`${path}.${key}는 문자열 배열이어야 합니다.`);
    }
    return record[key].map((value) => value.trim()).filter(Boolean);
  }

  function stripJsonCodeFence(value) {
    const text = String(value ?? "").trim().replace(/^\uFEFF/, "");
    const fenced = text.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
    return (fenced ? fenced[1] : text).trim();
  }

  function normalizeEntry(value, index) {
    const path = `lorebook.entries[${index}]`;
    const entry = requireRecord(value, path);
    return {
      name: optionalString(entry, "name", path),
      content: optionalString(entry, "content", path),
      keys: optionalStringArray(entry, "keys", path),
      secondaryKeys: optionalStringArray(entry, "secondaryKeys", path),
      constant: optionalBoolean(entry, "constant", path),
      selective: optionalBoolean(entry, "selective", path),
    };
  }

  function normalizePresetCandidate(value, index) {
    const path = `presetCandidates[${index}]`;
    const candidate = requireRecord(value, path);
    const category = optionalString(candidate, "category", path) || "other";
    if (!PRESET_CATEGORIES.includes(category)) {
      throw new DraftValidationError(`${path}.category는 ${PRESET_CATEGORIES.join(", ")} 중 하나여야 합니다.`);
    }
    return {
      name: optionalString(candidate, "name", path),
      category,
      content: optionalString(candidate, "content", path),
    };
  }

  function normalizeDraft(value, options = {}) {
    const root = requireRecord(value, "초안(draft)");
    const character = requireRecord(root.character, "character");
    const extensions = requireRecord(character.extensions, "character.extensions");
    const lorebook = requireRecord(root.lorebook, "lorebook");

    if (hasOwn(lorebook, "entries") && !Array.isArray(lorebook.entries)) {
      throw new DraftValidationError("로어북 항목(lorebook.entries)은 배열이어야 합니다.");
    }
    if (hasOwn(root, "presetCandidates") && !Array.isArray(root.presetCandidates)) {
      throw new DraftValidationError("프리셋 후보(presetCandidates)는 배열이어야 합니다.");
    }
    const category = hasOwn(lorebook, "category") ? lorebook.category : "world";
    if (typeof category !== "string" || !LOREBOOK_CATEGORIES.includes(category)) {
      throw new DraftValidationError(`로어북 분류(lorebook.category)는 ${LOREBOOK_CATEGORIES.join(", ")} 중 하나여야 합니다.`);
    }

    const draft = {
      character: {
        name: optionalString(character, "name", "character"),
        description: optionalString(character, "description", "character"),
        personality: optionalString(character, "personality", "character"),
        scenario: optionalString(character, "scenario", "character"),
        first_mes: optionalString(character, "first_mes", "character"),
        mes_example: optionalString(character, "mes_example", "character"),
        creator_notes: optionalString(character, "creator_notes", "character"),
        system_prompt: optionalString(character, "system_prompt", "character"),
        post_history_instructions: optionalString(character, "post_history_instructions", "character"),
        tags: optionalStringArray(character, "tags", "character"),
        extensions: {
          backstory: optionalString(extensions, "backstory", "character.extensions"),
          appearance: optionalString(extensions, "appearance", "character.extensions"),
        },
      },
      lorebook: {
        name: optionalString(lorebook, "name", "lorebook"),
        description: optionalString(lorebook, "description", "lorebook"),
        category,
        entries: (lorebook.entries ?? []).map(normalizeEntry),
      },
      presetCandidates: (root.presetCandidates ?? []).map(normalizePresetCandidate),
      residualInstructions: optionalString(root, "residualInstructions", "draft"),
      warnings: optionalStringArray(root, "warnings", "draft"),
    };

    const meaningfulCharacter = [
      draft.character.name,
      draft.character.description,
      draft.character.personality,
      draft.character.scenario,
      draft.character.system_prompt,
      draft.character.post_history_instructions,
      draft.character.first_mes,
      draft.character.mes_example,
      draft.character.creator_notes,
      draft.character.extensions.backstory,
      draft.character.extensions.appearance,
      ...draft.character.tags,
    ].some((item) => item.trim());
    const meaningfulLore =
      draft.lorebook.name.trim() ||
      draft.lorebook.description.trim() ||
      draft.lorebook.entries.some((entry) => entry.name.trim() || entry.content.trim());
    const meaningfulPreset = draft.presetCandidates.some((candidate) => candidate.name.trim() || candidate.content.trim());
    if (
      options.allowEmpty !== true &&
      !meaningfulCharacter &&
      !meaningfulLore &&
      !meaningfulPreset &&
      !draft.residualInstructions.trim()
    ) {
      throw new DraftValidationError("분석 결과가 지나치게 비어 있습니다. 원본 프롬프트를 확인하고 다시 시도하세요.");
    }
    return draft;
  }

  function parseDraftResponse(raw) {
    const jsonText = stripJsonCodeFence(raw);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "알 수 없는 JSON 오류";
      throw new DraftValidationError(`AI 응답을 JSON으로 해석하지 못했습니다: ${detail}`);
    }
    return normalizeDraft(parsed);
  }

  function normalizeSources(inputMode, sourceValues) {
    if (inputMode !== "combined" && inputMode !== "separated") {
      throw new Error("지원하지 않는 입력 모드입니다.");
    }
    const values = isRecord(sourceValues) ? sourceValues : {};
    const sources = {};
    for (const key of SOURCE_FIELDS) sources[key] = typeof values[key] === "string" ? values[key] : "";
    if (inputMode === "combined") {
      sources.character = "";
      sources.worldLore = "";
      sources.systemStyle = "";
      sources.other = "";
    } else {
      sources.combined = "";
    }
    return sources;
  }

  const DEFAULT_SETTINGS = Object.freeze({
    useConnectionDefaults: true,
    temperatureOverrideEnabled: false,
    temperature: 0.2,
    maxTokensOverrideEnabled: false,
    maxTokens: 8000,
    responseTimeoutSeconds: 0,
    jsonRepairRetries: 1,
    preserveLanguageSpecificExpressions: false,
    contentFormattingInstructions: DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
  });

  function normalizeSettings(value) {
    const input = isRecord(value) ? value : {};
    const finiteNumber = (key, fallback, min, max) => {
      const candidate = typeof input[key] === "number" ? input[key] : Number.NaN;
      return Number.isFinite(candidate) ? Math.min(max, Math.max(min, candidate)) : fallback;
    };
    const finiteInteger = (key, fallback, min, max) =>
      Math.round(finiteNumber(key, fallback, min, max));
    const contentFormattingInstructions = (() => {
      if (typeof input.contentFormattingInstructions === "string") {
        if (input.contentFormattingInstructions === PREVIOUS_DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS) {
          return DEFAULT_SETTINGS.contentFormattingInstructions;
        }
        return input.contentFormattingInstructions.trim()
          ? input.contentFormattingInstructions
          : DEFAULT_SETTINGS.contentFormattingInstructions;
      }
      if (
        typeof input.outputInstructions === "string" &&
        input.outputInstructions.trim() &&
        !input.outputInstructions.includes("Required draft schema:")
      ) {
        return input.outputInstructions;
      }
      return DEFAULT_SETTINGS.contentFormattingInstructions;
    })();
    return {
      useConnectionDefaults:
        typeof input.useConnectionDefaults === "boolean"
          ? input.useConnectionDefaults
          : DEFAULT_SETTINGS.useConnectionDefaults,
      temperatureOverrideEnabled:
        typeof input.temperatureOverrideEnabled === "boolean"
          ? input.temperatureOverrideEnabled
          : DEFAULT_SETTINGS.temperatureOverrideEnabled,
      temperature: finiteNumber("temperature", DEFAULT_SETTINGS.temperature, 0, 5),
      maxTokensOverrideEnabled:
        typeof input.maxTokensOverrideEnabled === "boolean"
          ? input.maxTokensOverrideEnabled
          : DEFAULT_SETTINGS.maxTokensOverrideEnabled,
      maxTokens: finiteInteger("maxTokens", DEFAULT_SETTINGS.maxTokens, 1, 200_000),
      responseTimeoutSeconds: finiteInteger("responseTimeoutSeconds", DEFAULT_SETTINGS.responseTimeoutSeconds, 0, 86_400),
      jsonRepairRetries: finiteInteger("jsonRepairRetries", DEFAULT_SETTINGS.jsonRepairRetries, 0, 5),
      preserveLanguageSpecificExpressions:
        typeof input.preserveLanguageSpecificExpressions === "boolean"
          ? input.preserveLanguageSpecificExpressions
          : DEFAULT_SETTINGS.preserveLanguageSpecificExpressions,
      contentFormattingInstructions,
    };
  }

  function buildGenerationParameters(value) {
    const settings = normalizeSettings(value);
    const parameters = {};
    if (!settings.useConnectionDefaults) {
      parameters.enabledParameters = {
        temperature: false,
        maxTokens: false,
        topP: false,
        topK: false,
        frequencyPenalty: false,
        presencePenalty: false,
        reasoningEffort: false,
        verbosity: false,
      };
    }
    if (settings.temperatureOverrideEnabled) {
      parameters.temperature = settings.temperature;
      if (parameters.enabledParameters) parameters.enabledParameters.temperature = true;
    }
    if (settings.maxTokensOverrideEnabled) {
      parameters.maxTokens = settings.maxTokens;
      if (parameters.enabledParameters) parameters.enabledParameters.maxTokens = true;
    }
    return Object.keys(parameters).length ? parameters : undefined;
  }

  function normalizeConversionMode(value) {
    return CONVERSION_MODES.includes(value) ? value : "preserve";
  }

  function savedDraftFingerprint(snapshot) {
    if (!isRecord(snapshot)) return "";
    return JSON.stringify({ ...snapshot, view: "", activeSavedDraftId: "" });
  }

  function isSavedDraftDirty(snapshot, baselineFingerprint) {
    const fingerprint = savedDraftFingerprint(snapshot);
    return !!fingerprint && (!baselineFingerprint || fingerprint !== baselineFingerprint);
  }

  function buildAnalysisMessages(inputMode, sourceValues, settingsValue, analysisOptions = {}) {
    const sources = normalizeSources(inputMode, sourceValues);
    const settings = normalizeSettings(settingsValue);
    const conversionMode = normalizeConversionMode(analysisOptions.conversionMode);
    const chatDerivedPrompt = typeof analysisOptions.chatDerivedPrompt === "string"
      ? analysisOptions.chatDerivedPrompt.trim()
      : "";
    const externalLorebookSource = typeof analysisOptions.externalLorebookSource === "string"
      ? analysisOptions.externalLorebookSource.trim()
      : "";
    return promptTemplates.buildAnalysisMessages({
      inputMode,
      sources,
      settings,
      conversionMode,
      chatDerivedPrompt,
      externalLorebookSource,
    });
  }

  function buildRepairMessages(rawResponse, validationMessage) {
    return repairPrompts.buildPromptConversionRepairMessages(rawResponse, validationMessage);
  }

  globalThis.MarinaraPromptConverterCore = Object.freeze({
    ANALYSIS_SYSTEM_PROMPT,
    CHAT_DERIVED_SOURCE_INSTRUCTIONS,
    CONVERSION_MODES,
    CORE_ANALYZER_INSTRUCTIONS,
    DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
    EXTERNAL_LOREBOOK_SOURCE_INSTRUCTIONS,
    DEFAULT_SETTINGS,
    DraftValidationError,
    LOREBOOK_CATEGORIES,
    LOREBOOK_WRITE_POLICY,
    PRESET_CATEGORIES,
    FIXED_OUTPUT_INSTRUCTIONS,
    buildAnalysisMessages,
    buildGenerationParameters,
    buildRepairMessages,
    normalizeSettings,
    normalizeDraft,
    normalizeConversionMode,
    normalizeSources,
    parseDraftResponse,
    savedDraftFingerprint,
    isSavedDraftDirty,
    stripJsonCodeFence,
  });
})();
