(() => {
  "use strict";

  const SAVE_STRATEGIES = Object.freeze(["new", "append", "merge"]);
  const SAVE_SCOPES = Object.freeze(["character", "lorebook", "all"]);
  const MERGE_ACTIONS = Object.freeze(["create", "append", "merge", "keep_separate", "conflict", "skip"]);

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const strings = (value) =>
    Array.from(new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean)));

  function compactRecord(value) {
    return Object.fromEntries(
      Object.entries(value).filter(([, item]) => {
        if (typeof item === "string") return item.trim().length > 0;
        if (Array.isArray(item)) return item.length > 0;
        if (isRecord(item)) return Object.keys(item).length > 0;
        return item !== undefined;
      }),
    );
  }

  function normalizeBaseEntry(value) {
    const entry = isRecord(value) ? value : {};
    return {
      name: text(entry.name),
      content: typeof entry.content === "string" ? entry.content.trim() : "",
      keys: strings(entry.keys),
      secondaryKeys: strings(entry.secondaryKeys),
      constant: entry.constant === true,
      selective: entry.selective === true,
    };
  }

  function buildCharacterPayload(draft) {
    const character = isRecord(draft?.character) ? draft.character : {};
    const extensions = isRecord(character.extensions) ? character.extensions : {};
    const extensionPayload = compactRecord({
      backstory: text(extensions.backstory),
      appearance: text(extensions.appearance),
    });
    const data = compactRecord({
      name: text(character.name),
      description: text(character.description),
      personality: text(character.personality),
      scenario: text(character.scenario),
      first_mes: text(character.first_mes),
      mes_example: text(character.mes_example),
      creator_notes: text(character.creator_notes),
      system_prompt: text(character.system_prompt),
      post_history_instructions: text(character.post_history_instructions),
      tags: strings(character.tags),
      extensions: extensionPayload,
    });
    return { data };
  }

  function buildLorebookPayload(draft, characterId) {
    const lorebook = isRecord(draft?.lorebook) ? draft.lorebook : {};
    return {
      name: text(lorebook.name),
      description: text(lorebook.description),
      category: "character",
      characterIds: characterId ? [characterId] : [],
      isGlobal: false,
    };
  }

  function buildEntryPayload(value) {
    return normalizeBaseEntry(value);
  }

  function mergeText(existing, incoming) {
    const left = typeof existing === "string" ? existing.trim() : "";
    const right = typeof incoming === "string" ? incoming.trim() : "";
    if (!left) return right;
    if (!right || left === right || left.includes(right)) return left;
    return `${left}\n\n${right}`;
  }

  function buildMergedEntry(existingValue, draftValue, action = "merge") {
    const existing = normalizeBaseEntry(existingValue);
    const draft = normalizeBaseEntry(draftValue);
    return {
      name: action === "append" ? existing.name : draft.name || existing.name,
      content: mergeText(existing.content, draft.content),
      keys: strings([...existing.keys, ...draft.keys]),
      secondaryKeys: strings([...existing.secondaryKeys, ...draft.secondaryKeys]),
      constant: existing.constant || draft.constant,
      selective: existing.selective || draft.selective,
    };
  }

  function canonicalEntry(value) {
    const entry = normalizeBaseEntry(value);
    return JSON.stringify({
      ...entry,
      keys: [...entry.keys].sort((a, b) => a.localeCompare(b)),
      secondaryKeys: [...entry.secondaryKeys].sort((a, b) => a.localeCompare(b)),
    });
  }

  function reviewFingerprint(value) {
    const input = JSON.stringify(value);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      first ^= code;
      first = Math.imul(first, 0x01000193);
      second ^= code + index;
      second = Math.imul(second, 0x85ebca6b);
    }
    return `v1-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}-${input.length}`;
  }

  function normalizeMergeAction(value) {
    if (value === "exclude") return "skip";
    return MERGE_ACTIONS.includes(value) ? value : "create";
  }

  function initialMergeDecision() {
    return {
      action: "create",
      targetEntryId: "",
      suggestedTargetId: "",
      confirmed: false,
      finalEntry: null,
      reason: "",
      warnings: [],
    };
  }

  function buildSavePlan({ draft, excludedEntries, strategy, selectedLorebookId, existingEntries, mergeDecisions, scope = "all" }) {
    const errors = [];
    const includeCharacter = scope === "character" || scope === "all";
    const includeLorebook = scope === "lorebook" || scope === "all";
    if (!SAVE_SCOPES.includes(scope)) errors.push("지원하지 않는 저장 범위입니다.");
    const characterPayload = buildCharacterPayload(draft);
    if (includeCharacter && !text(characterPayload.data.name)) errors.push("캐릭터 이름이 필요합니다.");
    if (includeLorebook && !SAVE_STRATEGIES.includes(strategy)) errors.push("지원하지 않는 로어북 저장 방식입니다.");
    if (includeLorebook && strategy === "new" && !text(draft?.lorebook?.name)) errors.push("새 로어북 이름이 필요합니다.");
    if (includeLorebook && strategy !== "new" && !text(selectedLorebookId)) errors.push("기존 로어북을 선택하세요.");

    const excluded = new Set(Array.isArray(excludedEntries) ? excludedEntries : []);
    const entries = Array.isArray(draft?.lorebook?.entries) ? draft.lorebook.entries : [];
    const existingById = new Map(
      (Array.isArray(existingEntries) ? existingEntries : [])
        .filter((entry) => typeof entry?.id === "string")
        .map((entry) => [entry.id, entry]),
    );
    const creates = [];
    const updates = [];
    const skips = [];

    if (includeLorebook) entries.forEach((entryValue, index) => {
      if (excluded.has(index)) {
        skips.push({ key: `skip:${index}`, index, name: text(entryValue?.name), reason: "review_excluded" });
        return;
      }
      const entry = buildEntryPayload(entryValue);
      if (!entry.name) {
        errors.push(`${index + 1}번 항목의 이름이 필요합니다.`);
        return;
      }
      if (strategy !== "merge") {
        creates.push({ key: `create:${index}`, index, name: entry.name, payload: entry });
        return;
      }

      const decision = isRecord(mergeDecisions?.[index]) ? mergeDecisions[index] : {};
      const action = normalizeMergeAction(decision.action);
      if (action === "conflict") {
        errors.push(`${index + 1}번 항목의 충돌을 해결하거나 제외하세요.`);
        return;
      }
      if (!decision.confirmed) {
        errors.push(`${index + 1}번 항목의 병합 결정을 확인하세요.`);
        return;
      }
      if (action === "skip") {
        skips.push({ key: `skip:${index}`, index, name: entry.name, reason: "merge_skip" });
        return;
      }
      if (action === "create" || action === "keep_separate") {
        const finalEntry = decision.finalEntry ? buildEntryPayload(decision.finalEntry) : entry;
        creates.push({ key: `create:${index}`, index, name: finalEntry.name || entry.name, payload: finalEntry });
        return;
      }
      const targetEntryId = text(decision.targetEntryId);
      const existing = existingById.get(targetEntryId);
      if (!existing) {
        errors.push(`${index + 1}번 항목에 연결할 기존 항목을 선택하세요.`);
        return;
      }
      const finalEntry = decision.finalEntry
        ? buildEntryPayload(decision.finalEntry)
        : buildMergedEntry(existing, entry, action);
      if (!finalEntry.name) {
        errors.push(`${index + 1}번 항목의 최종 병합 이름이 필요합니다.`);
        return;
      }
      updates.push({
        key: `update:${index}:${targetEntryId}`,
        index,
        name: finalEntry.name,
        targetEntryId,
        payload: finalEntry,
      });
    });

    return { errors, characterPayload, creates, updates, skips, includeCharacter, includeLorebook };
  }

  globalThis.MarinaraAssetSaveCore = Object.freeze({
    MERGE_ACTIONS,
    SAVE_SCOPES,
    SAVE_STRATEGIES,
    buildCharacterPayload,
    buildEntryPayload,
    buildLorebookPayload,
    buildMergedEntry,
    buildSavePlan,
    canonicalEntry,
    initialMergeDecision,
    normalizeMergeAction,
    reviewFingerprint,
  });
})();
