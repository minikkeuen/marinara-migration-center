(() => {
  "use strict";

  const promptTemplates = globalThis.MarinaraChatExtractionPrompts;
  if (!promptTemplates) throw new Error("Chat Extraction prompt module is unavailable");
  const {
    EXTRACTION_SYSTEM_PROMPT,
    REDUCE_SYSTEM_PROMPT,
    buildExtractionMessages,
    buildReduceMessages,
  } = promptTemplates;

  const RECOMMENDED_ANALYSIS_TOKENS = 100_000;
  const DEFAULT_MAX_CONTEXT = 128_000;
  const MIN_CHUNK_TOKENS = 2_000;
  const TOKEN_ESTIMATOR_CONFIG = Object.freeze({
    latinCharsPerToken: 4,
    hangulCharsPerToken: 2,
    hanCharsPerToken: 1.5,
    kanaCharsPerToken: 1.5,
    whitespaceCharsPerToken: 4,
    otherCharsPerToken: 1,
    safetyMultiplier: 1.1,
  });
  const RELATIONS = Object.freeze(["new", "confirms", "elaborates", "develops", "conflicts"]);
  const EVIDENCE_TYPES = Object.freeze(["explicit", "repeated_behavior"]);
  const SCOPES = Object.freeze(["character", "relationship", "world", "other"]);

  class ChatExtractionValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = "ChatExtractionValidationError";
    }
  }

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const stringValue = (value) => (typeof value === "string" ? value.trim() : "");

  function characterClass(codePoint) {
    if (
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a) ||
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x00c0 && codePoint <= 0x024f) ||
      (codePoint >= 0x1e00 && codePoint <= 0x1eff) ||
      (codePoint >= 0xa720 && codePoint <= 0xa7ff) ||
      (codePoint >= 0xab30 && codePoint <= 0xab6f)
    ) return "latin";
    if (
      (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
      (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
      (codePoint >= 0x3130 && codePoint <= 0x318f) ||
      (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
      (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
    ) return "hangul";
    if (
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x2ebef) ||
      (codePoint >= 0x30000 && codePoint <= 0x323af)
    ) return "han";
    if (
      (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
      (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
      (codePoint >= 0xff66 && codePoint <= 0xff9d) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b16f)
    ) return "kana";
    if (codePoint === 0x20 || (codePoint >= 0x09 && codePoint <= 0x0d) || codePoint === 0x3000) return "whitespace";
    return "other";
  }

  function estimateTokens(textValue) {
    const counts = { latin: 0, hangul: 0, han: 0, kana: 0, whitespace: 0, other: 0 };
    for (const character of String(textValue ?? "")) counts[characterClass(character.codePointAt(0))] += 1;
    const raw =
      counts.latin / TOKEN_ESTIMATOR_CONFIG.latinCharsPerToken +
      counts.hangul / TOKEN_ESTIMATOR_CONFIG.hangulCharsPerToken +
      counts.han / TOKEN_ESTIMATOR_CONFIG.hanCharsPerToken +
      counts.kana / TOKEN_ESTIMATOR_CONFIG.kanaCharsPerToken +
      counts.whitespace / TOKEN_ESTIMATOR_CONFIG.whitespaceCharsPerToken +
      counts.other / TOKEN_ESTIMATOR_CONFIG.otherCharsPerToken;
    return Math.max(0, Math.ceil(raw * TOKEN_ESTIMATOR_CONFIG.safetyMultiplier - Number.EPSILON));
  }

  function messageExtra(value) {
    if (isRecord(value)) return value;
    if (typeof value !== "string" || !value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function normalizeAvailableChats(value) {
    const rows = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
    const chats = rows
      .filter((row) => isRecord(row) && typeof row.id === "string" && row.id.trim())
      .map((row) => {
        const metadata = messageExtra(row.metadata);
        const branchName = typeof metadata.branchName === "string" ? metadata.branchName.trim() : "";
        return {
          id: row.id,
          name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : "이름 없는 채팅",
          mode: row.mode === "conversation" ? "CONVO" : row.mode === "roleplay" ? "RP" : row.mode === "game" ? "GAME" : "CHAT",
          groupId: typeof row.groupId === "string" && row.groupId.trim() ? row.groupId.trim() : "",
          branchName: branchName === "New Branch" ? "새 분기" : branchName,
          branchParentChatId:
            typeof metadata.branchParentChatId === "string" && metadata.branchParentChatId.trim()
              ? metadata.branchParentChatId.trim()
              : "",
          createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
          updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
          branchLabel: "",
        };
      });
    const groups = new Map();
    for (const chat of chats) {
      if (!chat.groupId) continue;
      const group = groups.get(chat.groupId) || [];
      group.push(chat);
      groups.set(chat.groupId, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort(
        (left, right) =>
          (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0) || left.id.localeCompare(right.id),
      );
      const root = ordered.find((chat) => !chat.branchName && !chat.branchParentChatId) || null;
      let branchNumber = 0;
      for (const chat of ordered) {
        if (root && chat.id === root.id) {
          chat.branchLabel = "원본";
          continue;
        }
        branchNumber += 1;
        chat.branchLabel = `분기 ${branchNumber}${chat.branchName ? `: ${chat.branchName}` : ""}`;
      }
    }
    return chats.sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0));
  }

  const availableChatLabel = (chat) => [chat?.mode, chat?.name, chat?.branchLabel].filter(Boolean).join(" · ");

  function normalizeVisibleMessages(value) {
    if (!Array.isArray(value)) throw new ChatExtractionValidationError("대화 메시지 배열이 필요합니다.");
    return value.flatMap((row, sourceIndex) => {
      if (!isRecord(row)) return [];
      const role = stringValue(row.role).toLowerCase();
      const content = stringValue(row.content);
      const extra = messageExtra(row.extra);
      if (!content || !["user", "assistant"].includes(role)) return [];
      // hiddenFromAI only removes a visible message from future generation context.
      // Automatic summaries use it on older transcript history, which must still be
      // available when the user explicitly requests full-conversation extraction.
      if (extra.hiddenFromUser === true) return [];
      return [{
        id: stringValue(row.id) || `message-${sourceIndex + 1}`,
        role,
        content,
        createdAt: stringValue(row.createdAt),
        estimatedTokens: estimateTokens(content),
      }];
    });
  }

  function formatTurn(turn, displayIndex = turn.index) {
    const lines = [`[Turn ${displayIndex}]`];
    for (const message of turn.messages) {
      lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${message.content}`);
    }
    return lines.join("\n");
  }

  function groupMessagesIntoTurns(messagesValue) {
    const messages = normalizeVisibleMessages(messagesValue);
    const turns = [];
    let current = null;
    for (const message of messages) {
      if (message.role === "user" || !current) {
        current = { index: turns.length + 1, messages: [] };
        turns.push(current);
      }
      current.messages.push(message);
    }
    return turns.map((turn) => {
      const text = formatTurn(turn);
      const framingTokens = estimateTokens(`[Turn ${turn.index}]`) + turn.messages.reduce(
        (sum, message) => sum + estimateTokens(message.role === "user" ? "User: " : "Assistant: "),
        0,
      );
      return {
        ...turn,
        text,
        estimatedTokens: framingTokens + turn.messages.reduce((sum, message) => sum + message.estimatedTokens, 0),
      };
    });
  }

  function calculateRecommendation(turns, targetTokens = RECOMMENDED_ANALYSIS_TOKENS) {
    const totalTokens = turns.reduce((sum, turn) => sum + turn.estimatedTokens, 0);
    const averageTokensPerTurn = turns.length ? totalTokens / turns.length : 0;
    let recentTokens = 0;
    let recommendedTurns = 0;
    for (let index = turns.length - 1; index >= 0 && recentTokens < targetTokens; index -= 1) {
      recentTokens += turns[index].estimatedTokens;
      recommendedTurns += 1;
    }
    if (turns.length && recentTokens < targetTokens) {
      recommendedTurns += Math.max(0, Math.round((targetTokens - recentTokens) / Math.max(1, averageTokensPerTurn)));
    }
    return {
      totalTurns: turns.length,
      totalTokens,
      averageTokensPerTurn,
      recommendedTurns,
      recommendedTokens: Math.max(0, Number(targetTokens) || 0),
    };
  }

  function calculateChunkBudget(maxContextValue, promptReferenceTokens = 0) {
    const maxContext = Number.isFinite(Number(maxContextValue))
      ? Math.max(4_096, Math.round(Number(maxContextValue)))
      : DEFAULT_MAX_CONTEXT;
    const safetyMargin = Math.max(2_048, Math.floor(maxContext * 0.2));
    const instructionReserve = Math.max(2_048, Math.min(8_192, Math.floor(maxContext * 0.08)));
    const outputReserve = Math.max(2_048, Math.min(8_192, Math.floor(maxContext * 0.08)));
    const referenceReserve = Math.min(Math.max(0, promptReferenceTokens), Math.floor(maxContext * 0.25));
    return Math.max(
      MIN_CHUNK_TOKENS,
      maxContext - safetyMargin - instructionReserve - outputReserve - referenceReserve,
    );
  }

  function splitText(text, maxTokens) {
    const parts = [];
    let remaining = text;
    const maximumLatinChars = Math.max(1, Math.floor(
      (maxTokens / TOKEN_ESTIMATOR_CONFIG.safetyMultiplier) * TOKEN_ESTIMATOR_CONFIG.latinCharsPerToken,
    ));
    while (estimateTokens(remaining) > maxTokens) {
      let candidateLength = Math.min(remaining.length, maximumLatinChars);
      while (candidateLength > 1 && estimateTokens(remaining.slice(0, candidateLength)) > maxTokens) {
        candidateLength = Math.max(1, Math.floor(candidateLength * 0.8));
      }
      const floor = Math.floor(candidateLength * 0.55);
      const candidates = [
        remaining.lastIndexOf("\n\n", candidateLength),
        remaining.lastIndexOf("\n", candidateLength),
        remaining.lastIndexOf(". ", candidateLength),
        remaining.lastIndexOf(" ", candidateLength),
      ];
      const cut = candidates.find((index) => index >= floor) ?? candidateLength;
      parts.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) parts.push(remaining);
    return parts.filter(Boolean);
  }

  function chunkTurns(turns, chunkBudgetTokens) {
    const budget = Math.max(MIN_CHUNK_TOKENS, Math.round(Number(chunkBudgetTokens) || MIN_CHUNK_TOKENS));
    const chunks = [];
    let currentParts = [];
    let currentTokens = 0;
    const flush = () => {
      if (!currentParts.length) return;
      const text = currentParts.join("\n\n");
      chunks.push({ text, estimatedTokens: currentTokens });
      currentParts = [];
      currentTokens = 0;
    };
    for (const turn of turns) {
      const formatted = turn.text || formatTurn(turn);
      const turnTokens = Number.isFinite(turn.estimatedTokens) ? turn.estimatedTokens : estimateTokens(formatted);
      if (turnTokens > budget) {
        flush();
        for (const part of splitText(formatted, budget)) {
          chunks.push({ text: part, estimatedTokens: estimateTokens(part) });
        }
        continue;
      }
      if (currentParts.length && currentTokens + turnTokens > budget) flush();
      currentParts.push(formatted);
      currentTokens += turnTokens;
    }
    flush();
    return chunks.map((chunk, index) => ({ ...chunk, index: index + 1 }));
  }

  function selectedTurns(turns, mode, recentTurnCount) {
    if (mode === "all") return [...turns];
    const count = Math.max(1, Math.min(turns.length, Math.round(Number(recentTurnCount) || 1)));
    return turns.slice(-count);
  }

  function partitionReduceInputs(itemsValue, budgetTokens) {
    const items = Array.isArray(itemsValue) ? itemsValue : [];
    const budget = Math.max(MIN_CHUNK_TOKENS, Math.round(Number(budgetTokens) || MIN_CHUNK_TOKENS));
    const groups = [];
    let current = [];
    let currentTokens = 0;
    for (const item of items) {
      const itemTokens = estimateTokens(JSON.stringify(item));
      if (current.length && currentTokens + itemTokens > budget) {
        groups.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(item);
      currentTokens += itemTokens;
    }
    if (current.length) groups.push(current);
    return groups;
  }

  function stripFence(value) {
    const text = String(value ?? "").trim().replace(/^\uFEFF/, "");
    const fenced = text.match(/^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i);
    return (fenced ? fenced[1] : text).trim();
  }

  function parseJson(value, label) {
    try {
      return JSON.parse(stripFence(value));
    } catch (error) {
      throw new ChatExtractionValidationError(`${label} 응답을 JSON으로 해석하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function stringArray(value, path) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new ChatExtractionValidationError(`${path}는 문자열 배열이어야 합니다.`);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  }

  function parseExtractionResponse(value) {
    const root = parseJson(value, "대화 구간 추출");
    if (!isRecord(root) || !Array.isArray(root.candidates)) {
      throw new ChatExtractionValidationError("대화 구간 추출 응답에 후보(candidates) 배열이 필요합니다.");
    }
    const candidates = root.candidates.map((candidate, index) => {
      if (!isRecord(candidate)) throw new ChatExtractionValidationError(`candidates[${index}]는 객체여야 합니다.`);
      const statement = stringValue(candidate.statement);
      const relation = stringValue(candidate.relation) || "new";
      const evidenceType = stringValue(candidate.evidenceType) || "explicit";
      const scope = stringValue(candidate.scope) || "other";
      if (!statement) throw new ChatExtractionValidationError(`candidates[${index}].statement가 비어 있습니다.`);
      if (!RELATIONS.includes(relation)) throw new ChatExtractionValidationError(`candidates[${index}].relation이 올바르지 않습니다.`);
      if (!EVIDENCE_TYPES.includes(evidenceType)) throw new ChatExtractionValidationError(`candidates[${index}].evidenceType이 올바르지 않습니다.`);
      if (!SCOPES.includes(scope)) throw new ChatExtractionValidationError(`candidates[${index}].scope가 올바르지 않습니다.`);
      return {
        subject: stringValue(candidate.subject),
        statement,
        scope,
        relation,
        evidenceType,
        temporalContext: stringValue(candidate.temporalContext),
        evidenceSummary: stringValue(candidate.evidenceSummary),
      };
    });
    return { candidates, warnings: stringArray(root.warnings, "warnings") };
  }

  function parseReduceResponse(value) {
    const root = parseJson(value, "대화 분석 통합");
    if (!isRecord(root) || typeof root.chatDerivedPrompt !== "string") {
      throw new ChatExtractionValidationError("대화 분석 통합 응답에 대화 분석 프롬프트(chatDerivedPrompt) 문자열이 필요합니다.");
    }
    const chatDerivedPrompt = root.chatDerivedPrompt.trim();
    if (!chatDerivedPrompt) throw new ChatExtractionValidationError("대화 분석 프롬프트가 비어 있습니다.");
    return { chatDerivedPrompt, warnings: stringArray(root.warnings, "warnings") };
  }

  globalThis.MarinaraChatExtractionCore = Object.freeze({
    ChatExtractionValidationError,
    DEFAULT_MAX_CONTEXT,
    EXTRACTION_SYSTEM_PROMPT,
    RECOMMENDED_ANALYSIS_TOKENS,
    REDUCE_SYSTEM_PROMPT,
    TOKEN_ESTIMATOR_CONFIG,
    buildExtractionMessages,
    buildReduceMessages,
    calculateChunkBudget,
    calculateRecommendation,
    chunkTurns,
    estimateTokens,
    formatTurn,
    groupMessagesIntoTurns,
    availableChatLabel,
    normalizeAvailableChats,
    normalizeVisibleMessages,
    partitionReduceInputs,
    parseExtractionResponse,
    parseReduceResponse,
    selectedTurns,
  });
})();
