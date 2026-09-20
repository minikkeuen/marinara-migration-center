(() => {
  "use strict";

  const promptTemplates = globalThis.MarinaraPromptConversionPrompts;
  const postprocessingPrompts = globalThis.MarinaraDraftPostprocessingPrompts;
  const repairPrompts = globalThis.MarinaraJsonRepairPrompts;
  if (!promptTemplates || !postprocessingPrompts || !repairPrompts) {
    throw new Error("Prompt Converter prompt modules are unavailable");
  }
  const {
    ANALYSIS_SYSTEM_PROMPT,
    CHAT_DERIVED_SOURCE_INSTRUCTIONS,
    CORE_ANALYZER_INSTRUCTIONS,
    DRAFT_CLASSIFICATION_INSTRUCTIONS,
    DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
    EXTERNAL_LOREBOOK_SOURCE_INSTRUCTIONS,
    FIXED_OUTPUT_INSTRUCTIONS,
  } = promptTemplates;
  const { DRAFT_REANALYSIS_INSTRUCTION_PRESETS } = postprocessingPrompts;

  const LOREBOOK_CATEGORIES = Object.freeze(["world", "character", "npc", "spellbook", "uncategorized"]);
  const CONVERSION_MODES = Object.freeze(["preserve", "normalize"]);
  const PRESET_CATEGORIES = Object.freeze(["style", "pov", "format", "system", "behavior", "other"]);
  const SOURCE_FIELDS = Object.freeze(["combined", "character", "worldLore", "systemStyle", "other"]);
  const KOREAN_NAME_COLLATOR = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
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

  function normalizeLorebook(value) {
    const lorebook = requireRecord(value, "lorebook");
    if (hasOwn(lorebook, "entries") && !Array.isArray(lorebook.entries)) {
      throw new DraftValidationError("로어북 항목(lorebook.entries)은 배열이어야 합니다.");
    }
    const category = hasOwn(lorebook, "category") ? lorebook.category : "world";
    if (typeof category !== "string" || !LOREBOOK_CATEGORIES.includes(category)) {
      throw new DraftValidationError(`로어북 분류(lorebook.category)는 ${LOREBOOK_CATEGORIES.join(", ")} 중 하나여야 합니다.`);
    }
    return {
      name: optionalString(lorebook, "name", "lorebook"),
      description: optionalString(lorebook, "description", "lorebook"),
      category,
      entries: (lorebook.entries ?? []).map(normalizeEntry),
    };
  }

  function parseMarinaraCharacterData(value) {
    let parsed = value;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new DraftValidationError("Marinara 봇카드 데이터를 해석하지 못했습니다.");
      }
    }
    if (!isRecord(parsed)) throw new DraftValidationError("Marinara 봇카드 데이터가 올바르지 않습니다.");
    return parsed;
  }

  function draftFromMarinaraCharacter(recordValue) {
    const record = requireRecord(recordValue, "Marinara 봇카드");
    const character = parseMarinaraCharacterData(record.data);
    const extensions = isRecord(character.extensions) ? character.extensions : {};
    const characterBook = isRecord(character.character_book) ? character.character_book : null;
    const rawEntries = characterBook && Array.isArray(characterBook.entries) ? characterBook.entries : [];
    let disabledEntries = 0;
    const entries = rawEntries.flatMap((entryValue) => {
      if (!isRecord(entryValue)) return [];
      if (entryValue.enabled === false) {
        disabledEntries += 1;
        return [];
      }
      const secondaryKeys = Array.isArray(entryValue.secondary_keys)
        ? entryValue.secondary_keys
        : entryValue.secondaryKeys;
      return [{
        name: typeof entryValue.name === "string"
          ? entryValue.name
          : typeof entryValue.comment === "string" ? entryValue.comment : "",
        content: typeof entryValue.content === "string" ? entryValue.content : "",
        keys: Array.isArray(entryValue.keys) ? entryValue.keys.filter((value) => typeof value === "string") : [],
        secondaryKeys: Array.isArray(secondaryKeys)
          ? secondaryKeys.filter((value) => typeof value === "string")
          : [],
        constant: entryValue.constant === true,
        selective: entryValue.selective === true,
      }];
    });
    const warnings = disabledEntries
      ? [`내장 로어북의 비활성화 항목 ${disabledEntries}개는 현재 Review에 포함하지 않았습니다.`]
      : [];
    const text = (value) => typeof value === "string" ? value : "";
    return normalizeDraft({
      character: {
        name: text(character.name),
        description: text(character.description),
        personality: text(character.personality),
        scenario: text(character.scenario),
        first_mes: text(character.first_mes),
        mes_example: text(character.mes_example),
        creator_notes: text(character.creator_notes),
        system_prompt: text(character.system_prompt),
        post_history_instructions: text(character.post_history_instructions),
        tags: Array.isArray(character.tags) ? character.tags.filter((value) => typeof value === "string") : [],
        extensions: {
          backstory: text(extensions.backstory),
          appearance: text(extensions.appearance),
        },
      },
      lorebook: {
        name: characterBook ? text(characterBook.name) : "",
        description: characterBook ? text(characterBook.description) : "",
        category: "character",
        entries,
      },
      presetCandidates: [],
      residualInstructions: "",
      warnings,
    }, { allowEmpty: true });
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
    const lorebook = normalizeLorebook(root.lorebook);
    if (hasOwn(root, "presetCandidates") && !Array.isArray(root.presetCandidates)) {
      throw new DraftValidationError("프리셋 후보(presetCandidates)는 배열이어야 합니다.");
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
      lorebook,
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

  function parseLorebookResponse(raw) {
    const jsonText = stripJsonCodeFence(raw);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "알 수 없는 JSON 오류";
      throw new DraftValidationError(`AI 응답을 JSON으로 해석하지 못했습니다: ${detail}`);
    }
    return normalizeLorebook(requireRecord(parsed, "결과").lorebook);
  }

  function applyLorebookResult(draftValue, lorebookValue, options = {}) {
    const draft = normalizeDraft(draftValue, { allowEmpty: true });
    const lorebook = normalizeLorebook(lorebookValue);
    if (!Number.isInteger(options.entryIndex)) return { ...draft, lorebook };
    const entryIndex = options.entryIndex;
    if (entryIndex < 0 || entryIndex >= draft.lorebook.entries.length) {
      throw new RangeError("교체할 로어북 항목 위치가 올바르지 않습니다.");
    }
    return {
      ...draft,
      lorebook: {
        ...draft.lorebook,
        entries: [
          ...draft.lorebook.entries.slice(0, entryIndex),
          ...lorebook.entries,
          ...draft.lorebook.entries.slice(entryIndex + 1),
        ],
      },
    };
  }

  function remapIndexesAfterEntryReplacement(indexes, entryIndex, replacementCount) {
    const shift = Math.max(0, Math.round(Number(replacementCount) || 0)) - 1;
    return [...(indexes || [])].flatMap((index) => {
      if (!Number.isInteger(index) || index === entryIndex) return [];
      return [index > entryIndex ? index + shift : index];
    });
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
    languageMode: "translate",
    targetLanguage: "English",
    preserveLanguageSpecificExpressions: false,
    contentFormattingInstructions: DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
    costPreset: "auto",
    costCurrency: "USD",
    costInputPerMillion: 0,
    costOutputPerMillion: 0,
    costUsdKrwRate: 0,
    costFxUpdatedAt: 0,
    costFxMarketDate: "",
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
      languageMode: ["source", "translate"].includes(input.languageMode)
        ? input.languageMode
        : DEFAULT_SETTINGS.languageMode,
      targetLanguage: ["English", "Korean", "Japanese", "Chinese"].includes(input.targetLanguage)
        ? input.targetLanguage
        : DEFAULT_SETTINGS.targetLanguage,
      preserveLanguageSpecificExpressions:
        typeof input.preserveLanguageSpecificExpressions === "boolean"
          ? input.preserveLanguageSpecificExpressions
          : DEFAULT_SETTINGS.preserveLanguageSpecificExpressions,
      contentFormattingInstructions,
      costPreset: ["auto", "deepseek-v4-pro", "glm-5.2", "custom"].includes(input.costPreset)
        ? input.costPreset
        : DEFAULT_SETTINGS.costPreset,
      costCurrency: typeof input.costCurrency === "string" && input.costCurrency.trim()
        ? input.costCurrency.trim().toUpperCase().slice(0, 8)
        : DEFAULT_SETTINGS.costCurrency,
      costInputPerMillion: finiteNumber("costInputPerMillion", DEFAULT_SETTINGS.costInputPerMillion, 0, 1_000_000),
      costOutputPerMillion: finiteNumber("costOutputPerMillion", DEFAULT_SETTINGS.costOutputPerMillion, 0, 1_000_000),
      costUsdKrwRate: finiteNumber("costUsdKrwRate", DEFAULT_SETTINGS.costUsdKrwRate, 0, 100_000),
      costFxUpdatedAt: finiteNumber("costFxUpdatedAt", DEFAULT_SETTINGS.costFxUpdatedAt, 0, Number.MAX_SAFE_INTEGER),
      costFxMarketDate: typeof input.costFxMarketDate === "string" ? input.costFxMarketDate.slice(0, 32) : "",
    };
  }

  function roundEstimatedTokensToHundred(value) {
    const tokens = Math.max(0, Math.ceil(Number(value) || 0));
    return tokens ? Math.ceil(tokens / 100) * 100 : 0;
  }

  function normalizeOptionalPositiveInteger(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.max(1, Math.round(number)) : null;
  }

  function isSelectableLorebookName(value) {
    return !String(value || "").trim().startsWith("기억 보관함");
  }

  function compareKoreanNames(left, right) {
    return KOREAN_NAME_COLLATOR.compare(String(left || ""), String(right || ""));
  }

  function deepSeekV4ProPeriod(timestamp = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
    const hour = Number(parts.hour);
    const peak = !weekend && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    return { period: peak ? "peak" : "off-peak", weekend };
  }

  function resolveCostRates(settingsValue, modelValue, timestamp = Date.now()) {
    const settings = normalizeSettings(settingsValue);
    const model = String(modelValue || "").toLowerCase();
    const preset = settings.costPreset === "auto"
      ? model.includes("deepseek-v4-pro")
        ? "deepseek-v4-pro"
        : model.includes("glm-5.2")
          ? "glm-5.2"
          : ""
      : settings.costPreset;
    if (preset === "deepseek-v4-pro") {
      const tier = deepSeekV4ProPeriod(timestamp);
      return {
        preset,
        label: `DeepSeek V4 Pro · ${tier.period === "peak" ? "피크" : "오프피크"}`,
        currency: "USD",
        inputPerMillion: tier.period === "peak" ? 1.32 : 0.66,
        outputPerMillion: tier.period === "peak" ? 3.96 : 1.98,
        period: tier.period,
        weekend: tier.weekend,
      };
    }
    if (preset === "glm-5.2") {
      return {
        preset,
        label: "GLM 5.2",
        currency: "USD",
        inputPerMillion: 1.4,
        outputPerMillion: 4.4,
        period: "fixed",
        weekend: false,
      };
    }
    if (preset === "custom" && (settings.costInputPerMillion > 0 || settings.costOutputPerMillion > 0)) {
      return {
        preset,
        label: "직접 입력",
        currency: settings.costCurrency,
        inputPerMillion: settings.costInputPerMillion,
        outputPerMillion: settings.costOutputPerMillion,
        period: "custom",
        weekend: false,
      };
    }
    return null;
  }

  function estimateGenerationCost({ inputTokens, referenceOutputTokens, maxOutputTokens, settings, model, timestamp }) {
    const input = Math.max(0, Math.ceil(Number(inputTokens) || 0));
    const maximum = Math.max(1, Math.ceil(Number(maxOutputTokens) || 0));
    const roundedMinimum = roundEstimatedTokensToHundred(referenceOutputTokens);
    const minimum = Math.min(maximum, roundedMinimum || Math.min(100, maximum));
    const rates = resolveCostRates(settings, model, timestamp);
    if (!rates) return { inputTokens: input, minimumOutputTokens: minimum, maximumOutputTokens: maximum, rates: null };
    const inputCost = input * rates.inputPerMillion / 1_000_000;
    return {
      inputTokens: input,
      minimumOutputTokens: minimum,
      maximumOutputTokens: maximum,
      rates,
      inputCost,
      minimumOutputCost: minimum * rates.outputPerMillion / 1_000_000,
      maximumOutputCost: maximum * rates.outputPerMillion / 1_000_000,
      minimumTotalCost: inputCost + minimum * rates.outputPerMillion / 1_000_000,
      maximumTotalCost: inputCost + maximum * rates.outputPerMillion / 1_000_000,
      outputMinimumClamped: roundedMinimum > maximum,
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

  function buildDraftReanalysisMessages(draftValue, settingsValue, options = {}) {
    return postprocessingPrompts.buildDraftReanalysisMessages({
      draft: normalizeDraft(draftValue, { allowEmpty: true }),
      settings: normalizeSettings(settingsValue),
      userInstructions: typeof options.userInstructions === "string" ? options.userInstructions : "",
      preserveLorebook: options.preserveLorebook === true,
    });
  }

  function buildLorebookResplitMessages(lorebookValue, settingsValue, options = {}) {
    const lorebook = normalizeLorebook(lorebookValue);
    const characterContext = options.characterContext
      ? normalizeDraft({
          character: options.characterContext,
          lorebook: { category: "world", entries: [] },
          presetCandidates: [],
          residualInstructions: "",
          warnings: [],
        }, { allowEmpty: true }).character
      : null;
    return postprocessingPrompts.buildLorebookResplitMessages({
      lorebook,
      characterContext,
      scope: options.scope,
      settings: normalizeSettings(settingsValue),
    });
  }

  const finiteTokenNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
  };

  function firstTokenNumber(...values) {
    for (const value of values) {
      const number = finiteTokenNumber(value);
      if (number !== null) return number;
    }
    return null;
  }

  function normalizeGenerationUsage(responseValue) {
    const response = isRecord(responseValue) ? responseValue : {};
    const meta = isRecord(response.meta) ? response.meta : {};
    const usage = [response.usage, response.generationInfo, meta.usage].find(isRecord);
    if (!usage) return null;
    const inputDetails = isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : isRecord(usage.prompt_tokens_details)
        ? usage.prompt_tokens_details
        : {};
    const inputTokens = firstTokenNumber(
      usage.promptTokens,
      usage.inputTokens,
      usage.tokensPrompt,
      usage.prompt_tokens,
      usage.input_tokens,
    );
    const outputTokens = firstTokenNumber(
      usage.completionTokens,
      usage.outputTokens,
      usage.tokensCompletion,
      usage.completion_tokens,
      usage.output_tokens,
    );
    const cachedInputTokens = firstTokenNumber(
      usage.cachedPromptTokens,
      usage.cachedInputTokens,
      usage.tokensCachedPrompt,
      usage.cacheReadInputTokens,
      usage.cache_read_input_tokens,
      inputDetails.cached_tokens,
    );
    const cacheWriteInputTokens = firstTokenNumber(
      usage.cacheWritePromptTokens,
      usage.cacheWriteInputTokens,
      usage.tokensCacheWritePrompt,
      usage.cacheCreationInputTokens,
      usage.cache_creation_input_tokens,
    );
    const reportedTotalTokens = firstTokenNumber(usage.totalTokens, usage.tokensTotal, usage.total_tokens);
    const totalTokens = reportedTotalTokens ?? (
      inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
    );
    if ([inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens, totalTokens].every((value) => value === null)) {
      return null;
    }
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      totalTokens,
      totalDerived: reportedTotalTokens === null && totalTokens !== null,
    };
  }

  function summarizeGenerationUsage(receiptsValue) {
    const receipts = Array.isArray(receiptsValue) ? receiptsValue : [];
    const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "totalTokens"];
    const totals = Object.fromEntries(fields.map((field) => [field, null]));
    const coverage = Object.fromEntries(fields.map((field) => [field, 0]));
    let providedRequestCount = 0;
    for (const receipt of receipts) {
      if (!isRecord(receipt) || !isRecord(receipt.usage)) continue;
      providedRequestCount += 1;
      for (const field of fields) {
        const value = finiteTokenNumber(receipt.usage[field]);
        if (value === null) continue;
        totals[field] = (totals[field] ?? 0) + value;
        coverage[field] += 1;
      }
    }
    return {
      requestCount: receipts.length,
      providedRequestCount,
      unavailableRequestCount: receipts.length - providedRequestCount,
      totals,
      coverage,
    };
  }

  function estimateStoredTextTokens(value, estimateTokens) {
    if (typeof estimateTokens !== "function") throw new TypeError("estimateTokens 함수가 필요합니다.");
    let total = 0;
    const visit = (candidate) => {
      if (typeof candidate === "string") {
        if (candidate) total += estimateTokens(candidate);
        return;
      }
      if (Array.isArray(candidate)) {
        for (const item of candidate) visit(item);
        return;
      }
      if (isRecord(candidate)) {
        for (const item of Object.values(candidate)) visit(item);
      }
    };
    visit(value);
    return total;
  }

  globalThis.MarinaraPromptConverterCore = Object.freeze({
    ANALYSIS_SYSTEM_PROMPT,
    CHAT_DERIVED_SOURCE_INSTRUCTIONS,
    CONVERSION_MODES,
    CORE_ANALYZER_INSTRUCTIONS,
    DRAFT_CLASSIFICATION_INSTRUCTIONS,
    DEFAULT_CONTENT_FORMATTING_INSTRUCTIONS,
    EXTERNAL_LOREBOOK_SOURCE_INSTRUCTIONS,
    DEFAULT_SETTINGS,
    DRAFT_REANALYSIS_INSTRUCTION_PRESETS,
    DraftValidationError,
    LOREBOOK_CATEGORIES,
    LOREBOOK_WRITE_POLICY,
    PRESET_CATEGORIES,
    FIXED_OUTPUT_INSTRUCTIONS,
    buildAnalysisMessages,
    buildDraftReanalysisMessages,
    buildGenerationParameters,
    buildLorebookResplitMessages,
    buildRepairMessages,
    draftFromMarinaraCharacter,
    applyLorebookResult,
    normalizeSettings,
    normalizeDraft,
    normalizeLorebook,
    normalizeConversionMode,
    normalizeSources,
    parseDraftResponse,
    parseLorebookResponse,
    remapIndexesAfterEntryReplacement,
    savedDraftFingerprint,
    isSavedDraftDirty,
    estimateStoredTextTokens,
    roundEstimatedTokensToHundred,
    normalizeOptionalPositiveInteger,
    isSelectableLorebookName,
    compareKoreanNames,
    deepSeekV4ProPeriod,
    resolveCostRates,
    estimateGenerationCost,
    normalizeGenerationUsage,
    summarizeGenerationUsage,
    stripJsonCodeFence,
  });
})();
