(() => {
  "use strict";

  const prompts = globalThis.MarinaraLorebookMergePrompts;
  if (!prompts) throw new Error("Lorebook Merge prompt module is unavailable");

  const ACTIONS = Object.freeze(["create", "append", "merge", "keep_separate", "conflict", "skip"]);

  class LorebookMergeValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = "LorebookMergeValidationError";
    }
  }

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const strings = (value, path) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new LorebookMergeValidationError(`${path}는 문자열 배열이어야 합니다.`);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  };

  function draftEntries(value) {
    return (Array.isArray(value) ? value : []).map((entry, index) => ({
      draftEntryId: `draft-${index + 1}`,
      name: text(entry?.name),
      content: typeof entry?.content === "string" ? entry.content : "",
      keys: Array.isArray(entry?.keys) ? entry.keys.filter((item) => typeof item === "string") : [],
      secondaryKeys: Array.isArray(entry?.secondaryKeys)
        ? entry.secondaryKeys.filter((item) => typeof item === "string")
        : [],
      constant: entry?.constant === true,
      selective: entry?.selective === true,
    }));
  }

  function existingEntries(value) {
    return (Array.isArray(value) ? value : []).flatMap((entry) => {
      const id = text(entry?.id);
      if (!id) return [];
      return [{
        id,
        name: text(entry?.name),
        content: typeof entry?.content === "string" ? entry.content : "",
        keys: Array.isArray(entry?.keys) ? entry.keys.filter((item) => typeof item === "string") : [],
        secondaryKeys: Array.isArray(entry?.secondaryKeys)
          ? entry.secondaryKeys.filter((item) => typeof item === "string")
          : [],
        constant: entry?.constant === true,
        selective: entry?.selective === true,
      }];
    });
  }

  function normalizeResult(value, draftRows, existingRows) {
    if (!isRecord(value) || !Array.isArray(value.proposals)) {
      throw new LorebookMergeValidationError("병합 분석 응답에 제안 목록(proposals) 배열이 필요합니다.");
    }
    const draftIds = new Set(draftRows.map((entry) => entry.draftEntryId));
    const existingIds = new Set(existingRows.map((entry) => entry.id));
    const seen = new Set();
    const proposals = value.proposals.map((proposal, index) => {
      const path = `proposals[${index}]`;
      if (!isRecord(proposal)) throw new LorebookMergeValidationError(`${path} 객체가 필요합니다.`);
      const draftEntryId = text(proposal.draftEntryId);
      const matchedExistingEntryId = text(proposal.matchedExistingEntryId);
      const action = text(proposal.action);
      if (!draftIds.has(draftEntryId)) throw new LorebookMergeValidationError(`${path}.draftEntryId가 유효하지 않습니다.`);
      if (seen.has(draftEntryId)) throw new LorebookMergeValidationError(`${draftEntryId} 제안이 중복되었습니다.`);
      if (!ACTIONS.includes(action)) throw new LorebookMergeValidationError(`${path}.action 값이 유효하지 않습니다.`);
      if (matchedExistingEntryId && !existingIds.has(matchedExistingEntryId)) {
        throw new LorebookMergeValidationError(`${path}.matchedExistingEntryId가 유효하지 않습니다.`);
      }
      if (["append", "merge"].includes(action) && !matchedExistingEntryId) {
        throw new LorebookMergeValidationError(`${path}.${action}에는 기존 항목 ID가 필요합니다.`);
      }
      seen.add(draftEntryId);
      return {
        draftEntryId,
        matchedExistingEntryId,
        action,
        reason: typeof proposal.reason === "string" ? proposal.reason : "",
        proposedName: typeof proposal.proposedName === "string" ? proposal.proposedName : "",
        proposedContent: typeof proposal.proposedContent === "string" ? proposal.proposedContent : "",
        proposedKeys: strings(proposal.proposedKeys, `${path}.proposedKeys`),
        proposedSecondaryKeys: strings(proposal.proposedSecondaryKeys, `${path}.proposedSecondaryKeys`),
        warnings: strings(proposal.warnings, `${path}.warnings`),
      };
    });
    const missing = draftRows.filter((entry) => !seen.has(entry.draftEntryId));
    if (missing.length) {
      throw new LorebookMergeValidationError(`병합 제안이 누락되었습니다: ${missing.map((entry) => entry.draftEntryId).join(", ")}`);
    }
    return { proposals, warnings: strings(value.warnings, "warnings") };
  }

  function parseResponse(raw, draftRows, existingRows) {
    const source = String(raw ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/gi, "");
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new LorebookMergeValidationError(`병합 분석 JSON을 해석하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    return normalizeResult(parsed, draftRows, existingRows);
  }

  function splitContent(entry, budget, estimateTokens) {
    if (estimateTokens(JSON.stringify(entry)) <= budget || !entry.content) return [entry];
    const pieces = [];
    let remaining = entry.content;
    while (remaining) {
      let low = 1;
      let high = remaining.length;
      let fit = 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = { ...entry, content: remaining.slice(0, middle) };
        if (estimateTokens(JSON.stringify(candidate)) <= budget) {
          fit = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      const floor = Math.floor(fit * 0.6);
      const newline = remaining.lastIndexOf("\n", fit);
      const space = remaining.lastIndexOf(" ", fit);
      const cut = newline >= floor ? newline : space >= floor ? space : fit;
      pieces.push({ ...entry, content: remaining.slice(0, Math.max(1, cut)).trim() });
      remaining = remaining.slice(Math.max(1, cut)).trim();
    }
    return pieces.map((piece, index) => ({
      ...piece,
      contentSegment: `${index + 1}/${pieces.length}`,
    }));
  }

  function chunkExistingEntries(value, budgetValue, estimateTokens) {
    const budget = Math.max(1_000, Math.round(Number(budgetValue) || 1_000));
    const rows = existingEntries(value).flatMap((entry) => splitContent(entry, budget, estimateTokens));
    if (!rows.length) return [[]];
    const chunks = [];
    let current = [];
    let tokens = 0;
    for (const row of rows) {
      const rowTokens = estimateTokens(JSON.stringify(row));
      if (current.length && tokens + rowTokens > budget) {
        chunks.push(current);
        current = [];
        tokens = 0;
      }
      current.push(row);
      tokens += rowTokens;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  globalThis.MarinaraLorebookMergeCore = Object.freeze({
    ACTIONS,
    LorebookMergeValidationError,
    buildAnalysisMessages: prompts.buildMergeAnalysisMessages,
    buildReduceMessages: prompts.buildMergeReduceMessages,
    buildRepairMessages: prompts.buildMergeRepairMessages,
    chunkExistingEntries,
    draftEntries,
    existingEntries,
    normalizeResult,
    parseResponse,
  });
})();
