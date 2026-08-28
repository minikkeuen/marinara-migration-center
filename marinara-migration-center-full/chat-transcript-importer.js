(() => {
  "use strict";

  const hostMarinara = marinara;
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_MESSAGES = 10_000;
  const MAX_TOTAL_CONTENT_CHARACTERS = 25_000_000;
  const PREVIEW_LIMIT = 20;
  const MAX_JSONL_ISSUES_SHOWN = 50;
  const BULK_IMPORT_THROTTLE_THRESHOLD = 100;
  const importRequestCore = globalThis.MarinaraChatImportRequestCore;
  const messageCleanupCore = globalThis.MarinaraMessageCleanupCore;
  const PENDING_NAVIGATION_KEY = "marinara.chat-transcript-importer.pending-chat";
  const LAUNCHER_ATTRIBUTE = "data-marinara-migration-center-launcher";
  const migrationCenter = globalThis.MarinaraMigrationCenter || {};
  globalThis.MarinaraMigrationCenter = migrationCenter;
  let modalRoot = null;
  let modalCleanup = null;
  let helpRoot = null;
  let helpCleanup = null;

  class ImportValidationError extends Error {
    constructor(message) {
      super(message);
      this.name = "ImportValidationError";
    }
  }

  class MarinaraApiError extends Error {
    constructor(message, status, retryAfterMs) {
      super(message);
      this.name = "MarinaraApiError";
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  }

  const fail = (message) => {
    throw new ImportValidationError(message);
  };

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

  const importIcon = () => iconPath(["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"]);
  const migrationCenterIcon = () =>
    iconPath(["M12 3v9", "m8 8 4 4 4-4", "M5 17v4h14v-4"]);

  function createCenterNavigation(activeView, blocked) {
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
        if (view === activeView || blocked()) return;
        migrationCenter.open?.(view);
      });
      navigation.append(button);
    }
    return navigation;
  }

  function closeHelp() {
    const cleanup = helpCleanup;
    helpCleanup = null;
    cleanup?.();
    helpRoot?.remove();
    helpRoot = null;
  }

  function openHelp() {
    closeHelp();
    const root = createElement("div", { className: "mc-help-overlay" });
    const dialog = createElement("section", { className: "mc-help-dialog", role: "dialog" });
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "mc-help-title");
    const header = createElement("header", { className: "mc-help-header" });
    const title = createElement("h2", { id: "mc-help-title", text: "사용법" });
    const closeButton = createElement("button", { className: "cti-icon-button", type: "button", text: "×", ariaLabel: "사용법 닫기" });
    header.append(title, closeButton);
    const content = createElement("div", { className: "mc-help-content" });
    const importSection = createElement("section");
    importSection.append(
      createElement("h3", { text: "대화 가져오기" }),
      createElement("ol"),
    );
    importSection.querySelector("ol").append(
      createElement("li", { text: "TXT, XLSX 또는 JSON 파일을 선택합니다." }),
      createElement("li", { text: "필요하면 캐릭터·페르소나와 TXT 정리 항목을 조정합니다." }),
      createElement("li", { text: "미리보기에서 가져올 메시지를 확인한 뒤 대화 가져오기를 실행합니다." }),
    );
    const promptSection = createElement("section");
    promptSection.append(
      createElement("h3", { text: "프롬프트 이식" }),
      createElement("ol"),
    );
    promptSection.querySelector("ol").append(
      createElement("li", { text: "통짜 또는 분할을 선택하고 원본 프롬프트를 입력합니다." }),
      createElement("li", { text: "필요하면 대화 내역 참조를 켜고 분석할 대화를 선택합니다." }),
      createElement("li", { text: "변환 방식과 LLM 연결을 선택한 뒤 AI 분석을 실행합니다." }),
      createElement("li", { text: "작업소에서 결과를 검토하고 초안으로 보관하거나 Marinara 카드로 저장합니다." }),
    );
    const workspaceSection = createElement("section");
    workspaceSection.append(
      createElement("h3", { text: "작업소" }),
      createElement("ol"),
    );
    workspaceSection.querySelector("ol").append(
      createElement("li", { text: "현재 분석 결과를 검토하고 필요한 내용을 직접 수정합니다." }),
      createElement("li", { text: "저장된 초안 상단을 눌러 보관 목록을 열거나 닫습니다." }),
      createElement("li", { text: "보관본을 열고, 이름을 바꾸거나 필요 없는 항목을 삭제할 수 있습니다." }),
    );
    const settingsSection = createElement("section");
    settingsSection.append(
      createElement("h3", { text: "설정" }),
      createElement("ol"),
    );
    settingsSection.querySelector("ol").append(
      createElement("li", { text: "필요한 생성 설정만 재정의합니다." }),
      createElement("li", { text: "내용 및 형식 지침은 수정 버튼으로 잠금을 해제해 편집합니다." }),
      createElement("li", { text: "설정 저장을 눌러 다음 실행에도 적용합니다." }),
    );
    content.append(importSection, promptSection, workspaceSection, settingsSection);
    dialog.append(header, content);
    root.append(dialog);
    document.body.append(root);
    helpRoot = root;
    const keydown = (event) => {
      if (event.key === "Escape") closeHelp();
    };
    closeButton.addEventListener("click", closeHelp);
    root.addEventListener("click", (event) => {
      if (event.target === root) closeHelp();
    });
    document.addEventListener("keydown", keydown);
    helpCleanup = () => document.removeEventListener("keydown", keydown);
    closeButton.focus();
  }

  function parseRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  }

  function normalizeRole(value, itemLabel) {
    if (typeof value !== "string" || value.trim() === "") fail(`${itemLabel}에 role 값이 없습니다.`);
    const normalized = value.trim().toLowerCase();
    if (normalized === "user" || normalized === "human") return "user";
    if (normalized === "assistant" || normalized === "ai") return "assistant";
    fail(`${itemLabel}의 role 값 '${value}'은 지원하지 않습니다.`);
  }

  function validateOptionalString(value, field, itemLabel) {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") fail(`${itemLabel}의 ${field} 값은 문자열이어야 합니다.`);
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  function validateTimestamp(value, itemLabel) {
    const timestamp = validateOptionalString(value, "timestamp", itemLabel);
    if (!timestamp) return undefined;
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds)) fail(`${itemLabel}의 timestamp를 날짜로 해석할 수 없습니다.`);
    return new Date(milliseconds).toISOString();
  }

  function finalizeMessages(messages) {
    if (messages.length === 0) fail("가져올 메시지가 없습니다.");
    if (messages.length > MAX_MESSAGES)
      fail(`메시지는 최대 ${MAX_MESSAGES.toLocaleString()}개까지 가져올 수 있습니다.`);
    const totalCharacters = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (totalCharacters > MAX_TOTAL_CONTENT_CHARACTERS) fail("전체 메시지 본문이 2,500만 자를 초과합니다.");
    return messages;
  }

  function normalizeJsonMessage(value, itemLabel, sourceIndex, options = {}) {
    const item = parseRecord(value);
    if (!item) fail(`${itemLabel}가 객체가 아닙니다.`);
    if (typeof item.content !== "string" || item.content.trim() === "") {
      fail(`${itemLabel}에 content 값이 없습니다.`);
    }
    const name = validateOptionalString(item.name, "name", itemLabel);
    const timestamp = validateTimestamp(item.timestamp, itemLabel);
    const role = options.allowSystem === true && String(item.role || "").trim().toLowerCase() === "system"
      ? "system"
      : normalizeRole(item.role, itemLabel);
    return {
      role,
      content: item.content,
      ...(name ? { name } : {}),
      ...(timestamp ? { timestamp } : {}),
      sourceIndex,
    };
  }

  function parseJson(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      fail("JSON 문법이 올바르지 않습니다.");
    }
    const root = parseRecord(payload);
    if (!root || !Array.isArray(root.messages)) fail("JSON 최상위 객체에 messages 배열이 필요합니다.");
    const messages = root.messages.map((value, index) =>
      normalizeJsonMessage(value, `${index + 1}번째 메시지`, index + 1));
    return finalizeMessages(messages);
  }

  function summarizeJsonlIssues(issues) {
    const shown = issues.slice(0, MAX_JSONL_ISSUES_SHOWN).map((issue) => issue.message);
    if (issues.length > shown.length) shown.push(`그 외 ${issues.length - shown.length}개 행의 오류는 표시를 생략했습니다.`);
    return shown.join("\n");
  }

  function parseJsonl(text) {
    if (!globalThis.MarinaraTranscriptJsonl?.parseJsonl) fail("JSONL 파서가 로드되지 않았습니다.");
    const parsed = globalThis.MarinaraTranscriptJsonl.parseJsonl(text);
    const issues = [...parsed.issues];
    const messages = [];
    for (const candidate of parsed.candidates) {
      try {
        messages.push(normalizeJsonMessage(candidate.value, candidate.itemLabel, candidate.lineNumber, { allowSystem: true }));
      } catch (error) {
        if (!(error instanceof ImportValidationError)) throw error;
        issues.push({ lineNumber: candidate.lineNumber, message: error.message });
      }
    }
    issues.sort((left, right) => left.lineNumber - right.lineNumber);
    if (messages.length === 0) {
      const detail = summarizeJsonlIssues(issues);
      fail(`가져올 수 있는 JSONL 메시지가 없습니다.${detail ? `\n${detail}` : ""}`);
    }
    return { messages: finalizeMessages(messages), cleanupCandidates: [], issues };
  }


  function parseTxtDate(value) {
    if (typeof value !== "string") return undefined;
    const text = value.trim().replace(/\s+/g, " ");
    const match = text.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s*(?:(AM|PM|오전|오후)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/i);
    if (!match) return undefined;
    let [, year, month, day, meridiem, hour, minute, second] = match;
    let h = Number(hour);
    const marker = (meridiem || "").toUpperCase();
    if (marker === "PM" || meridiem === "오후") {
      if (h < 12) h += 12;
    } else if (marker === "AM" || meridiem === "오전") {
      if (h === 12) h = 0;
    }
    const date = new Date(Number(year), Number(month) - 1, Number(day), h, Number(minute), Number(second || 0));
    if (!Number.isFinite(date.getTime())) return undefined;
    return date.toISOString();
  }

  function classifyTxtSpeaker(raw) {
    const original = String(raw || "").trim();
    const compact = original.replace(/\s+/g, " ");
    const lowered = compact.toLowerCase();
    const userWrapped = compact.match(/^(?:유저|사용자|user|human)\s*[（(]\s*(.+?)\s*[)）]$/i);
    const assistantWrapped = compact.match(/^(?:캐릭터|character|assistant|ai)\s*[（(]\s*(.+?)\s*[)）]$/i);
    if (userWrapped) return { name: userWrapped[1].trim(), role: "user", explicit: true };
    if (assistantWrapped) return { name: assistantWrapped[1].trim(), role: "assistant", explicit: true };
    if (["나", "user", "human", "유저", "사용자", "{{user}}"].includes(lowered))
      return { name: original, role: "user", explicit: true };
    if (["assistant", "ai", "캐릭터", "character", "{{char}}"].includes(lowered))
      return { name: original, role: "assistant", explicit: true };
    return { name: original, role: undefined, explicit: false };
  }

  function cleanupId(prefix, ...parts) {
    return [prefix, ...parts].join(":");
  }

  function detectLeadingTxtMetadata(text, disabledCleanupIds = new Set()) {
    const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    const candidates = [];
    const metadataPatterns = [
      { regex: /^Nekochat\s+서비스\s+대화내역\s*$/i, label: "서비스 안내" },
      { regex: /^#\s*.+와의\s+대화\s*$/i, label: "대화 제목" },
      { regex: /^>\s*내보내기\s*날짜\s*:/i, label: "내보내기 날짜" },
      { regex: /^#\s*대화\s*내역\s*:/i, label: "대화 내역 제목" },
      { regex: /^#\s*내보내기\s*:/i, label: "내보내기 정보" },
      { regex: /^#\s*메시지\s*수\s*:/i, label: "메시지 수" },
      { regex: /^(?:\[캐릭터\]|캐릭터\s*:)/i, label: "캐릭터 메타데이터" },
      { regex: /^(?:\[페르소나\]|(?:유저\s*)?페르소나(?:\s*이름)?\s*:)/i, label: "페르소나 메타데이터" },
      { regex: /^(?:\[채팅방\]|채팅방\s*(?:이름|ID)\s*:)/i, label: "채팅방 메타데이터" },
      { regex: /^생성\s*시각\s*:/i, label: "생성 시각" },
      { regex: /^[─━═]{4,}\s*$/, label: "메타데이터 구분선" },
    ];

    const isStrongConversationHeader = (line) => {
      const trimmed = line.trim();
      let match = trimmed.match(/^\[([^\]]+)\]\s*([^:：]+?)\s*[:：]/);
      if (match && parseTxtDate(match[1])) return true;
      if (/^\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}\.?\s*(?:(?:AM|PM|오전|오후)\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*,\s*[^:：]+[:：]/i.test(trimmed)) return true;
      if (/^\[(?:유저|사용자|user|human|캐릭터|character|assistant|ai)(?:\s*[（(].+?[)）])?\]\s*[:：]/i.test(trimmed)) return true;
      if (/^\[(?:턴|turn)\s*#?\s*\d+\]$/i.test(trimmed)) return true;
      if (/^###\s+\S/.test(trimmed)) return true;
      return false;
    };

    let conversationStart = lines.findIndex(isStrongConversationHeader);
    if (conversationStart < 0) conversationStart = Math.min(lines.length, 80);
    const preamble = lines.slice(0, conversationStart);
    const hasStrongMetadata = preamble.some((line) =>
      /(?:Nekochat\s+서비스\s+대화내역|내보내기|메시지\s*수|\[캐릭터\]|\[채팅방\]|\[페르소나\]|채팅방\s*(?:이름|ID)|생성\s*시각|페르소나)/i.test(line),
    );
    if (!hasStrongMetadata) return { text: lines.join("\n"), candidates };

    for (let index = 0; index < conversationStart; index += 1) {
      const trimmed = lines[index].trim();
      if (!trimmed) continue;
      const pattern = metadataPatterns.find((entry) => entry.regex.test(trimmed));
      if (!pattern) continue;
      const id = cleanupId("metadata", index);
      candidates.push({
        id,
        type: "metadata",
        label: pattern.label,
        original: lines[index],
        replacement: "",
      });
      if (!disabledCleanupIds.has(id)) lines[index] = "";
    }
    return { text: lines.join("\n"), candidates };
  }

  function extractStatusReplacement(block, mode) {
    if (mode === "remove") return "";
    let date = "";
    let dayOfWeek = "";
    let time = "";
    const attr = (name) => {
      const match = block.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
      return match ? match[1].trim() : "";
    };
    date = attr("date");
    dayOfWeek = attr("dayOfWeek");
    time = attr("time");
    if (!date) {
      const dateMatch = block.match(/\b(?:(\d{4})[.\/-]\s*)?(\d{1,2})[.\/-](\d{1,2})\b/);
      if (dateMatch) date = dateMatch[1] ? `${dateMatch[1]}.${dateMatch[2]}.${dateMatch[3]}` : `${dateMatch[2]}.${dateMatch[3]}`;
    }
    if (!dayOfWeek) {
      const dayMatch = block.match(/(월요일|화요일|수요일|목요일|금요일|토요일|일요일)/);
      if (dayMatch) dayOfWeek = dayMatch[1];
    }
    if (!time) {
      const timeMatch = block.match(/\b(\d{1,2}:\d{2})(?::\d{2})?\b/);
      if (timeMatch) time = timeMatch[1];
    }
    if (mode === "date") return date;
    return `[${[date, time].filter(Boolean).join(" | ")}]`;
  }

  function transformStatusBlocks(content, messageSourceIndex, options, candidates) {
    const mode = ["keep", "remove", "date", "date-time"].includes(options.statusMode)
      ? options.statusMode
      : "keep";
    if (mode === "keep") return content;
    const disabledCleanupIds = options.disabledCleanupIds || new Set();
    let occurrence = 0;
    const applyBlock = (full) => {
      const id = cleanupId("status", messageSourceIndex, occurrence++);
      const replacement = extractStatusReplacement(full, mode);
      candidates.push({
        id,
        type: "status",
        label: mode === "remove" ? "상태창 제거" : mode === "date" ? "상태창 → 날짜" : "상태창 → 날짜·시간",
        original: full.trim(),
        replacement,
      });
      return disabledCleanupIds.has(id) ? full : replacement;
    };

    let result = String(content || "");

    // 상태창이 Markdown 코드펜스로 감싸진 경우에는 내부 일부만 지우지 않고
    // 여는 ``` 줄부터 닫는 ``` 줄까지 블록 전체를 하나의 상태창으로 처리한다.
    // 일반 코드 블록 오탐을 피하기 위해 날짜/시간·Status 속성·상태창 이모지 등
    // 상태창 특징이 있는 fenced block만 대상으로 한다.
    result = result.replace(/(^|\n)(```[^\n]*\n[\s\S]*?\n```)(?=\n|$)/g, (match, prefix, block) => {
      const body = block
        .replace(/^```[^\n]*\n/, "")
        .replace(/\n```$/, "");
      const looksLikeStatus =
        /[<〈＜]\s*Status\b/i.test(body) ||
        /(?:^|\n)📍/.test(body) ||
        /(?:^|\n)\s*(?:날짜|date)\s*[:=]/i.test(body) ||
        /\bdayOfWeek\s*=|\btime\s*=/i.test(body) ||
        /(?:^|\n)\s*(?:\d{4}[.\/-]\s*)?\d{1,2}[.\/-]\d{1,2}[^\n]*(?:오전|오후|AM|PM|\d{1,2}:\d{2})/i.test(body);
      if (!looksLikeStatus) return match;
      const replacement = applyBlock(body);
      if (!replacement) return prefix;
      return prefix + replacement;
    });

    // HTML <details>...</details> status panels used by some chat exports.
    // Process the entire element (including <summary> and nested markup) as one status block.
    result = result.replace(/<details\b[^>]*>[\s\S]*?<\/details\s*>/gi, (block) => {
      return applyBlock(block);
    });

    // JSON/JSONL exports can retain literal wrapper quotes around a status line.
    // Use an unwrapped copy only for detection; applyBlock keeps the complete
    // quoted source when the user disables this cleanup candidate.
    result = result.replace(/(^|\n)([^\n]+)(?=\n|$)/g, (match, prefix, line) => {
      if (!messageCleanupCore.isQuoteWrappedStatusLine(line)) return match;
      return prefix + applyBlock(line);
    });

    result = result.replace(/[<〈＜]\s*Status\b[\s\S]*?(?:\/[>〉＞]|[>〉＞])/gi, applyBlock);
    result = result.replace(/(?:^|\n)(📍[^\n]*(?:\n(?:👗|👕|🛠|🛠️|⚔|⚔️|🧰|🗡|🗡️|🎒|💬|🧭|🕰|🕰️)[^\n]*)*)/g, (match, block) => {
      const prefix = match.startsWith("\n") ? "\n" : "";
      return prefix + applyBlock(block);
    });
    return result.replace(/\n{3,}/g, "\n\n").trim();
  }

  function transformImageMarkers(content, messageSourceIndex, options, candidates) {
    if (options.removeImageMarkers === false) return content;
    const disabledCleanupIds = options.disabledCleanupIds || new Set();
    let occurrence = 0;
    const patterns = [
      // Markdown image embeds: ![](https://...)
      /!\[[^\]\n]*\]\(\s*(?:https?:\/\/|data:image\/)[^)]+\)/gi,
      // Marinara/other export image references: [img:path-or-id.ext]
      /\[img:[^\]\n]+\]/gi,
      // Known single-brace image calls such as {img_office}
      /\{img[_:][^{}\n]+\}/gi,
      // Double-brace image/template calls seen in chat exports.
      // Keep this intentionally conservative except for img::; opaque bare tokens are
      // accepted only when they look like short command identifiers, not prose/templates.
      /\{\{img::[^{}\n]+\}\}/gi,
      /\{\{(?!char\}\}|user\}\})[a-zA-Z][a-zA-Z0-9_-]{2,31}\}\}/gi,
    ];
    let result = String(content || "");
    for (const pattern of patterns) {
      result = result.replace(pattern, (full) => {
        const id = cleanupId("image-marker", messageSourceIndex, occurrence++);
        candidates.push({
          id,
          type: "image-marker",
          label: "이미지 호출/임베드",
          original: full,
          replacement: "",
        });
        return disabledCleanupIds.has(id) ? full : "";
      });
    }
    return result.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function replaceIdentityPlaceholders(content, options = {}) {
    const characterName = String(options.characterName || "").trim();
    const userName = String(options.userName || "").trim();
    let result = String(content || "");
    if (characterName) result = result.replace(/\{\{\s*char\s*\}\}/gi, characterName);
    if (userName) result = result.replace(/\{\{\s*user\s*\}\}/gi, userName);
    return result;
  }

  function sanitizeMessageBodies(messages, options = {}) {
    const candidates = [];
    const disabledCleanupIds = options.disabledCleanupIds || new Set();
    const result = [];
    for (const message of messages) {
      let content = transformStatusBlocks(message.content, message.sourceIndex, options, candidates);
      content = transformImageMarkers(content, message.sourceIndex, options, candidates);
      content = replaceIdentityPlaceholders(content, options);

      // Remove export/internal HTML comments such as <!-- [stability:44] -->.
      // Keep every match reviewable so a real authored comment can be preserved.
      let commentOccurrence = 0;
      content = content.replace(/<!--[\s\S]*?-->/g, (full) => {
        const commentId = cleanupId("html-comment", message.sourceIndex, commentOccurrence++);
        candidates.push({
          id: commentId,
          type: "html-comment",
          label: "주석 표시",
          original: full,
          replacement: "",
        });
        return disabledCleanupIds.has(commentId) ? full : "";
      });
      content = content.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

      // Some exports append a source timestamp to the end of each saved message:
      //   ...message text (2026-05-28 20:20:00)
      // Treat only a final parenthesized ISO-like datetime as export metadata.
      const trailingTimestampMatch = content.match(/(?:\s*\n?\s*)\((\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?)\)\s*$/);
      if (trailingTimestampMatch) {
        const timestampId = cleanupId("trailing-timestamp", message.sourceIndex);
        const originalTimestamp = trailingTimestampMatch[0].trim();
        candidates.push({
          id: timestampId,
          type: "trailing-timestamp",
          label: "메시지 끝 날짜/시간",
          original: originalTimestamp,
          replacement: "",
        });
        if (!disabledCleanupIds.has(timestampId)) {
          content = content.slice(0, trailingTimestampMatch.index).trimEnd();
        }
      }

      if (!content.trim() && message.content.trim() && options.statusMode !== "keep") continue;

      const userControlId = cleanupId("user-control", message.sourceIndex);
      if (
        message.role === "user" &&
        options.removeUserControlMessages !== false &&
        messageCleanupCore.isUserControlOnlyMessage(content)
      ) {
        candidates.push({
          id: userControlId,
          type: "user-control",
          label: "유저 명령/OOC 전용 메시지",
          original: content,
          replacement: "",
        });
        if (!disabledCleanupIds.has(userControlId)) continue;
      }

      const meaninglessId = cleanupId("meaningless", message.sourceIndex);
      if (options.removeMeaningless !== false && messageCleanupCore.isMeaninglessMessage(content)) {
        candidates.push({
          id: meaninglessId,
          type: "meaningless",
          label: "의미 없는 메시지",
          original: content || message.content,
          replacement: "",
        });
        if (!disabledCleanupIds.has(meaninglessId)) continue;
      }
      if (!content.trim()) {
        if (message.content.trim() && options.statusMode !== "keep") continue;
        continue;
      }
      result.push({ ...message, content });
    }
    return { messages: result, candidates };
  }

  function parseTxtCore(text, options = {}) {
    const firstImplicitRole = options.firstImplicitRole === "assistant" ? "assistant" : "user";
    const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    const items = [];
    let current = null;
    let implicitIndex = 0;

    const oppositeRole = (role) => (role === "user" ? "assistant" : "user");
    const implicitRoleAt = (index) => (index % 2 === 0 ? firstImplicitRole : oppositeRole(firstImplicitRole));
    const pushCurrent = () => {
      if (!current) return;
      const content = current.content.join("\n").replace(/^\n+|\n+$/g, "");
      if (content.trim()) items.push({ ...current, content });
      current = null;
    };
    const start = ({ speaker, role, timestamp, explicitRole = false }) => {
      pushCurrent();
      current = {
        role,
        speaker,
        name: speaker || undefined,
        timestamp,
        explicitRole,
        content: [],
      };
    };
    const ensureCurrent = () => {
      if (!current) {
        start({ role: implicitRoleAt(implicitIndex), explicitRole: false });
        implicitIndex += 1;
      }
    };

    for (const rawLine of lines) {
      const line = rawLine;
      const trimmed = line.trim();
      let match;

      match = trimmed.match(/^\[([^\]]+)\]\s*([^:：]+?)\s*[:：]\s*(.*)$/);
      if (match) {
        const timestamp = parseTxtDate(match[1]);
        if (timestamp) {
          const speakerInfo = classifyTxtSpeaker(match[2]);
          start({ speaker: speakerInfo.name, role: speakerInfo.role, timestamp, explicitRole: speakerInfo.explicit });
          if (match[3]) current.content.push(match[3]);
          continue;
        }
      }

      match = trimmed.match(/^(\d{4}[.\-/]\s*\d{1,2}[.\-/]\s*\d{1,2}\.?\s*(?:(?:AM|PM|오전|오후)\s*)?\d{1,2}:\d{2}(?::\d{2})?)\s*,\s*([^:：]+?)\s*[:：]\s*(.*)$/i);
      if (match) {
        const timestamp = parseTxtDate(match[1]);
        const speakerInfo = classifyTxtSpeaker(match[2]);
        start({ speaker: speakerInfo.name, role: speakerInfo.role, timestamp, explicitRole: speakerInfo.explicit });
        if (match[3]) current.content.push(match[3]);
        continue;
      }

      match = trimmed.match(/^\[([^\]]+)\]\s*[:：]\s*(.*)$/);
      if (match && !/^턴\s*#?\s*\d+$/i.test(match[1].trim())) {
        const speakerInfo = classifyTxtSpeaker(match[1]);
        start({ speaker: speakerInfo.name, role: speakerInfo.role, explicitRole: speakerInfo.explicit });
        if (match[2]) current.content.push(match[2]);
        continue;
      }

      if (/^\[(?:턴|turn)\s*#?\s*\d+\]$/i.test(trimmed)) {
        pushCurrent();
        implicitIndex = 0;
        continue;
      }

      match = trimmed.match(/^###\s+(.+?)\s*$/);
      if (match) {
        const speakerInfo = classifyTxtSpeaker(match[1]);
        start({ speaker: speakerInfo.name, role: speakerInfo.role, explicitRole: speakerInfo.explicit });
        continue;
      }

      if (/^-{3,}$/.test(trimmed)) {
        pushCurrent();
        continue;
      }

      ensureCurrent();
      current.content.push(line);
    }
    pushCurrent();

    if (items.length === 0) fail("TXT에서 가져올 메시지를 찾지 못했습니다.");

    const speakerRoleMap = new Map();
    for (const item of items) {
      if (item.speaker && item.role) speakerRoleMap.set(item.speaker, item.role);
    }
    const unknownSpeakers = [];
    for (const item of items) {
      if (!item.role && item.speaker && speakerRoleMap.has(item.speaker)) item.role = speakerRoleMap.get(item.speaker);
      if (!item.role && item.speaker && !unknownSpeakers.includes(item.speaker)) unknownSpeakers.push(item.speaker);
    }
    unknownSpeakers.forEach((speaker, index) => {
      speakerRoleMap.set(speaker, implicitRoleAt(index));
    });

    let fallbackIndex = 0;
    return items.map((item, index) => {
      let role = item.role || (item.speaker ? speakerRoleMap.get(item.speaker) : undefined);
      if (!role) {
        role = implicitRoleAt(fallbackIndex);
        fallbackIndex += 1;
      }
      return {
        role,
        content: item.content,
        ...(item.name ? { name: item.name } : {}),
        ...(item.timestamp ? { timestamp: item.timestamp } : {}),
        sourceIndex: index + 1,
      };
    });
  }

  function parseTxt(text, options = {}) {
    const disabledCleanupIds = options.disabledCleanupIds instanceof Set
      ? options.disabledCleanupIds
      : new Set(options.disabledCleanupIds || []);
    const metadata = options.removeMetadata === false
      ? { text: String(text || ""), candidates: [] }
      : detectLeadingTxtMetadata(text, disabledCleanupIds);
    const parsed = parseTxtCore(metadata.text, options);
    const sanitized = sanitizeMessageBodies(parsed, { ...options, disabledCleanupIds });
    const messages = finalizeMessages(sanitized.messages);
    return { messages, cleanupCandidates: [...metadata.candidates, ...sanitized.candidates] };
  }

  function maybeSanitizeStructured(result, options = {}) {
    if (options.cleanStructuredMessages !== true) return result;
    const sanitized = sanitizeMessageBodies(result.messages, options);
    return {
      ...result,
      messages: finalizeMessages(sanitized.messages),
      cleanupCandidates: sanitized.candidates,
    };
  }

  async function parseFile(file, options = {}) {
    if (!file) fail("파일을 선택하세요.");
    if (file.size > MAX_FILE_BYTES) fail("파일은 20MB 이하여야 합니다.");
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".json")) {
      return maybeSanitizeStructured({ messages: parseJson(await file.text()), cleanupCandidates: [] }, options);
    }
    if (lowerName.endsWith(".jsonl")) return maybeSanitizeStructured(parseJsonl(await file.text()), options);
    if (lowerName.endsWith(".txt")) return parseTxt(await file.text(), options);
    if (lowerName.endsWith(".xlsx")) {
      if (!globalThis.MarinaraTranscriptXlsx?.parseXlsx) fail("Excel 파서가 로드되지 않았습니다.");
      const messages = await globalThis.MarinaraTranscriptXlsx.parseXlsx(await file.arrayBuffer());
      return {
        messages: finalizeMessages(
          messages.map((message) => ({
            ...message,
            ...(message.timestamp ? { timestamp: validateTimestamp(message.timestamp, `${message.sourceIndex}행`) } : {}),
          })),
        ),
        cleanupCandidates: [],
      };
    }
    fail("지원하지 않는 파일입니다. .xlsx, .json, .jsonl 또는 .txt 파일을 선택하세요.");
  }

  function normalizedMessageTimestamps(messages) {
    const now = Date.now();
    const firstTimestampIndex = messages.findIndex((message) => message.timestamp);
    const firstTimestamp = firstTimestampIndex >= 0 ? Date.parse(messages[firstTimestampIndex].timestamp) : Number.NaN;
    let previous = null;
    return messages.map((message, index) => {
      const parsed = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
      let candidate;
      if (Number.isFinite(parsed)) candidate = parsed;
      else if (previous !== null) candidate = previous + 1;
      else if (Number.isFinite(firstTimestamp)) candidate = firstTimestamp - (firstTimestampIndex - index);
      else candidate = now + index;
      if (previous !== null && candidate <= previous) candidate = previous + 1;
      previous = candidate;
      return new Date(candidate).toISOString();
    });
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
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof payload.error === "string"
          ? payload.error
          : `Marinara API 요청이 실패했습니다 (${response.status}).`;
      const retryAfterMs = importRequestCore?.parseRetryAfter(response.headers?.get?.("Retry-After")) ?? null;
      throw new MarinaraApiError(message, response.status, retryAfterMs);
    }
    return payload;
  }

  function characterName(row) {
    let data = row?.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        data = null;
      }
    }
    return String(data?.name || row?.name || row?.comment || row?.id || "이름 없는 캐릭터");
  }

  async function loadChoices() {
    const [charactersValue, personasValue] = await Promise.all([
      apiRequest("/api/characters"),
      apiRequest("/api/characters/personas/list"),
    ]);
    const characters = Array.isArray(charactersValue?.items)
      ? charactersValue.items
      : Array.isArray(charactersValue)
        ? charactersValue
        : [];
    const personas = Array.isArray(personasValue?.items)
      ? personasValue.items
      : Array.isArray(personasValue)
        ? personasValue
        : [];
    return {
      characters: characters
        .filter((row) => row && typeof row.id === "string")
        .map((row) => ({ id: row.id, name: characterName(row) }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      personas: personas
        .filter((row) => row && typeof row.id === "string")
        .map((row) => ({
          id: row.id,
          name: String(row.name || row.id),
          active: row.isActive === true || row.isActive === "true",
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  function option(value, label) {
    const element = createElement("option", { text: label });
    element.value = value;
    return element;
  }

  function closeModal() {
    const cleanup = modalCleanup;
    modalCleanup = null;
    cleanup?.();
    modalRoot?.remove();
    modalRoot = null;
  }

  function waitForChatRow(chatId, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const escaped = globalThis.CSS?.escape ? CSS.escape(chatId) : chatId.replace(/["\\]/g, "\\$&");
        const row = document.querySelector(`[data-chat-id="${escaped}"]`);
        if (row) return resolve(row);
        if (Date.now() - started >= timeoutMs) return resolve(null);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  async function navigateToChat(chatId) {
    window.dispatchEvent(new Event("online"));
    const row = await waitForChatRow(chatId, 5_000);
    if (row) {
      row.click();
      return;
    }
    try {
      sessionStorage.setItem(PENDING_NAVIGATION_KEY, chatId);
    } catch {
      return;
    }
    window.location.reload();
  }

  async function resumePendingNavigation() {
    let chatId = null;
    try {
      chatId = sessionStorage.getItem(PENDING_NAVIGATION_KEY);
    } catch {
      return;
    }
    if (!chatId) return;
    const row = await waitForChatRow(chatId, 12_000);
    if (!row) return;
    try {
      sessionStorage.removeItem(PENDING_NAVIGATION_KEY);
    } catch {
      // Navigation can proceed even when storage cleanup is unavailable.
    }
    row.click();
  }

  function openImporter() {
    migrationCenter.closePrompt?.();
    closeModal();
    const state = { messages: [], cleanupCandidates: [], disabledCleanupIds: new Set(), excludedMessageKeys: new Set(), file: null, importing: false, choicesLoaded: false };
    const root = createElement("div", { className: "cti-overlay" });
    const dialog = createElement("section", { className: "cti-dialog mc-dialog", role: "dialog" });
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "cti-title");
    const header = createElement("header", { className: "cti-header" });
    const headerPrimary = createElement("div", { className: "mc-header-primary" });
    const headingGroup = createElement("div", { className: "cti-heading-group" });
    const title = createElement("h2", { id: "cti-title", text: "마리나라 이식 센터" });
    const subtitle = createElement("p", { text: "Excel, JSON 또는 TXT 대화 기록을 실제 Marinara 메시지로 저장합니다." });
    headingGroup.append(title, subtitle);
    const closeButton = createElement("button", {
      className: "cti-icon-button",
      type: "button",
      text: "×",
      ariaLabel: "가져오기 닫기",
    });
    closeButton.addEventListener("click", closeModal);
    const helpButton = createElement("button", {
      className: "cti-icon-button",
      type: "button",
      text: "?",
      ariaLabel: "사용법 열기",
    });
    helpButton.title = "사용법";
    helpButton.addEventListener("click", openHelp);
    const headerActions = createElement("div", { className: "mc-header-actions" });
    headerActions.append(helpButton, closeButton);
    headerPrimary.append(headingGroup, headerActions);
    header.append(headerPrimary, createCenterNavigation("import", () => state.importing));

    const body = createElement("div", { className: "cti-body" });
    const form = createElement("div", { className: "cti-form" });
    const preview = createElement("section", { className: "cti-preview" });
    const previewHeader = createElement("div", { className: "cti-preview-header" });
    const previewTitle = createElement("h3", { text: "미리보기" });
    const previewCount = createElement("span", { text: "파일을 선택하세요" });
    const previewActions = createElement("div", { className: "cti-preview-actions" });
    const selectAllButton = createElement("button", { className: "cti-mini-button", type: "button", text: "전체 선택" });
    const deselectAllButton = createElement("button", { className: "cti-mini-button", type: "button", text: "전체 해제" });
    const selectUserButton = createElement("button", { className: "cti-mini-button", type: "button", text: "User만" });
    const selectAssistantButton = createElement("button", { className: "cti-mini-button", type: "button", text: "Assistant만" });
    previewActions.append(selectAllButton, deselectAllButton, selectUserButton, selectAssistantButton);
    previewHeader.append(previewTitle, previewCount, previewActions);
    const previewList = createElement("div", { className: "cti-preview-list" });
    previewList.appendChild(
      createElement("div", {
        className: "cti-empty",
        text: "대화 기록을 읽으면 여기에 앞부분을 표시합니다.",
      }),
    );
    preview.append(previewHeader, previewList);

    const makeField = (labelText, control, hint) => {
      const field = createElement("label", { className: "cti-field" });
      field.append(createElement("span", { className: "cti-label", text: labelText }), control);
      if (hint) field.append(createElement("small", { text: hint }));
      return field;
    };

    const chatNameInput = createElement("input");
    chatNameInput.type = "text";
    chatNameInput.maxLength = 200;
    chatNameInput.placeholder = "가져온 대화";
    chatNameInput.addEventListener("input", () => {
      chatNameInput.dataset.edited = "true";
    });
    const modeSelect = createElement("select");
    modeSelect.append(option("roleplay", "Roleplay"), option("conversation", "Conversation"));
    const characterSelect = createElement("select");
    characterSelect.append(option("", "캐릭터 없음"));
    characterSelect.disabled = true;
    const personaSelect = createElement("select");
    personaSelect.append(option("", "페르소나 없음"));
    personaSelect.disabled = true;

    const identityRow = createElement("div", { className: "cti-identity-grid" });
    identityRow.append(
      makeField("캐릭터", characterSelect),
      makeField("페르소나", personaSelect),
    );
    form.append(makeField("채팅 이름", chatNameInput), makeField("채팅 모드", modeSelect), identityRow);

    const fileInput = createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".xlsx,.json,.jsonl,.txt";
    fileInput.className = "cti-file-input";
    fileInput.id = "cti-file";
    const dropzone = createElement("label", { className: "cti-dropzone", htmlFor: "cti-file" });
    const dropIcon = createElement("span", { className: "cti-drop-icon" });
    dropIcon.appendChild(importIcon());
    const dropCopy = createElement("span", { className: "cti-drop-copy" });
    const fileTitle = createElement("strong", { text: "파일 선택" });
    const fileHint = createElement("small", { text: ".xlsx, .json, .jsonl 또는 .txt, 최대 20MB" });
    dropCopy.append(fileTitle, fileHint);
    dropzone.append(dropIcon, dropCopy, fileInput);
    form.appendChild(dropzone);

    const txtOptions = createElement("div", { className: "cti-txt-options" });
    txtOptions.hidden = true;
    const txtFirstRoleSelect = createElement("select");
    txtFirstRoleSelect.hidden = true;
    txtFirstRoleSelect.append(option("user", "User"), option("assistant", "Assistant"));
    const txtRoleToggle = createElement("div", { className: "cti-role-toggle", role: "group", ariaLabel: "TXT 첫 화자 역할" });
    const txtRoleButtons = [];
    for (const [value, label] of [["user", "User"], ["assistant", "Assistant"]]) {
      const button = createElement("button", { type: "button", text: label });
      button.dataset.value = value;
      button.addEventListener("click", () => {
        txtFirstRoleSelect.value = value;
        for (const item of txtRoleButtons) {
          const selected = item.dataset.value === value;
          item.dataset.selected = String(selected);
          item.setAttribute("aria-pressed", String(selected));
        }
        txtFirstRoleSelect.dispatchEvent(new Event("change"));
      });
      txtRoleButtons.push(button);
      txtRoleToggle.append(button);
    }
    txtRoleButtons[0].dataset.selected = "true";
    txtRoleButtons[0].setAttribute("aria-pressed", "true");
    txtRoleButtons[1].dataset.selected = "false";
    txtRoleButtons[1].setAttribute("aria-pressed", "false");
    const txtRoleField = createElement("div", { className: "cti-field" });
    txtRoleField.append(
      createElement("span", { className: "cti-label", text: "TXT 첫 화자 역할" }),
      txtRoleToggle,
      txtFirstRoleSelect,
      createElement("small", { text: "화자 표시가 불명확한 TXT에서 첫 구간의 역할을 지정합니다." }),
    );
    txtOptions.append(txtRoleField);

    const cleanupTitle = createElement("div", { className: "cti-section-title", text: "TXT 정리" });
    const cleanupGrid = createElement("div", { className: "cti-cleanup-grid" });
    const makeToggle = (labelText, checked = true) => {
      const label = createElement("label", { className: "cti-check-row" });
      const input = createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      label.append(input, createElement("span", { text: labelText }));
      return { label, input };
    };
    const metadataToggle = makeToggle("서비스/내보내기 메타데이터 제거", true);
    const structuredCleanupToggle = makeToggle("본문 정리 사용", false);
    structuredCleanupToggle.label.hidden = true;
    const meaninglessToggle = makeToggle("빈 메시지/플레이스홀더 제거", true);
    const imageMarkerToggle = makeToggle("이미지 호출/임베드 제거", true);
    const userControlToggle = makeToggle("유저 명령/OOC 전용 메시지 제거", true);
    cleanupGrid.append(metadataToggle.label, meaninglessToggle.label, imageMarkerToggle.label, userControlToggle.label);

    const statusModeSelect = createElement("select");
    statusModeSelect.append(
      option("keep", "그대로 유지"),
      option("remove", "전체 제거"),
      option("date", "날짜만 남기기"),
      option("date-time", "날짜 + 시간 남기기"),
    );
    statusModeSelect.value = "remove";

    const reviewBox = createElement("section", { className: "cti-cleanup-review" });
    const reviewHeader = createElement("div", { className: "cti-cleanup-review-header" });
    const reviewTitle = createElement("strong", { text: "정리 항목 검토" });
    const reviewCount = createElement("span", { text: "감지된 항목 없음" });
    reviewHeader.append(reviewTitle, reviewCount);
    const reviewList = createElement("div", { className: "cti-cleanup-review-list" });
    reviewList.append(createElement("div", { className: "cti-cleanup-empty", text: "TXT를 선택하면 제거·변환 예정 항목을 여기에 표시합니다." }));
    reviewBox.append(reviewHeader, reviewList);

    txtOptions.append(
      cleanupTitle,
      cleanupGrid,
      makeField("상태창 처리", statusModeSelect, "상태창이 실제 대사/지문과 같은 메시지에 있어도 상태창 부분만 정리합니다."),
      reviewBox,
    );
    form.append(structuredCleanupToggle.label, txtOptions);

    const status = createElement("div", { className: "cti-status", role: "status" });
    status.hidden = true;
    form.appendChild(status);

    const footer = createElement("footer", { className: "cti-footer" });
    const importButton = createElement("button", {
      className: "cti-button cti-button-primary",
      type: "button",
      text: "Import 실행",
    });
    importButton.disabled = true;
    footer.append(importButton);
    body.append(form, preview);
    dialog.append(header, body, footer);
    root.appendChild(dialog);
    document.body.appendChild(root);
    modalRoot = root;

    const showStatus = (tone, message) => {
      status.hidden = false;
      status.dataset.tone = tone;
      status.textContent = message;
    };
    const clearStatus = () => {
      status.hidden = true;
      status.removeAttribute("data-tone");
      status.textContent = "";
    };
    const messageKey = (message, index) =>
      `${index}\u241f${message.role || ""}\u241f${message.name || ""}\u241f${message.timestamp || ""}\u241f${message.content || ""}`;
    const selectedMessages = () =>
      state.messages.filter((message, index) => !state.excludedMessageKeys.has(messageKey(message, index)));
    const publishImportedConversation = () => {
      if (!state.file || state.messages.length === 0) return;
      migrationCenter.importedConversationSource = {
        name: chatNameInput.value.trim() || state.file.name.replace(/\.(xlsx|jsonl?|txt)$/i, "").trim() || "가져온 대화",
        messages: selectedMessages().map((message) => ({
          role: message.role,
          content: message.content,
          name: message.name || "",
          timestamp: message.timestamp || "",
        })),
      };
    };
    const updateImportAvailability = () => {
      importButton.disabled = state.importing || !state.choicesLoaded || selectedMessages().length === 0;
      closeButton.disabled = state.importing;
    };
    const renderPreview = () => {
      previewList.textContent = "";
      const selectedCount = selectedMessages().length;
      previewCount.textContent = `총 ${state.messages.length.toLocaleString()}개 · 선택 ${selectedCount.toLocaleString()}개`;
      previewActions.hidden = state.messages.length === 0;
      for (const [index, message] of state.messages.entries()) {
        const key = messageKey(message, index);
        const item = createElement("article", { className: "cti-message-preview cti-message-selectable" });
        if (state.excludedMessageKeys.has(key)) item.dataset.excluded = "true";
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "cti-message-checkbox";
        checkbox.checked = !state.excludedMessageKeys.has(key);
        checkbox.setAttribute("aria-label", `${index + 1}번 메시지 가져오기`);
        const messageBody = createElement("div", { className: "cti-message-preview-body" });
        const meta = createElement("div", { className: "cti-message-meta" });
        meta.append(
          createElement("span", {
            className: `cti-role cti-role-${message.role}`,
            text: `${index + 1} ${message.role.toUpperCase()}`,
          }),
        );
        if (message.name || message.timestamp) {
          meta.append(createElement("span", { text: [message.name, message.timestamp].filter(Boolean).join(" · ") }));
        }
        const content = createElement("p", { text: message.content });
        messageBody.append(meta, content);
        item.append(checkbox, messageBody);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            state.excludedMessageKeys.delete(key);
            delete item.dataset.excluded;
          } else {
            state.excludedMessageKeys.add(key);
            item.dataset.excluded = "true";
          }
          previewCount.textContent = `총 ${state.messages.length.toLocaleString()}개 · 선택 ${selectedMessages().length.toLocaleString()}개`;
          updateImportAvailability();
          publishImportedConversation();
        });
        previewList.appendChild(item);
      }
    };
    const renderCleanupReview = () => {
      reviewList.textContent = "";
      const candidates = state.cleanupCandidates;
      reviewCount.textContent = candidates.length > 0 ? `${candidates.length.toLocaleString()}개 감지` : "감지된 항목 없음";
      if (candidates.length === 0) {
        reviewList.append(
          createElement("div", {
            className: "cti-cleanup-empty",
            text: state.file ? "현재 설정에서 정리할 항목이 없습니다." : "파일을 선택하면 제거·변환 예정 항목을 여기에 표시합니다.",
          }),
        );
        return;
      }
      for (const candidate of candidates) {
        const row = createElement("label", { className: "cti-cleanup-item" });
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !state.disabledCleanupIds.has(candidate.id);
        const copy = createElement("span", { className: "cti-cleanup-copy" });
        const heading = createElement("span", { className: "cti-cleanup-item-title", text: candidate.label });
        const before = createElement("code", { className: "cti-cleanup-before", text: candidate.original || "(빈 내용)" });
        const afterText = candidate.replacement ? `→ ${candidate.replacement}` : "→ 제거";
        const after = createElement("span", { className: "cti-cleanup-after", text: afterText });
        copy.append(heading, before, after);
        row.append(checkbox, copy);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) state.disabledCleanupIds.delete(candidate.id);
          else state.disabledCleanupIds.add(candidate.id);
          if (state.file) void handleFile(state.file, { resetDecisions: false });
        });
        reviewList.append(row);
      }
    };

    const handleFile = async (file, { resetDecisions = false } = {}) => {
      clearStatus();
      const fileChanged = state.file !== file;
      if (resetDecisions || fileChanged) {
        state.disabledCleanupIds = new Set();
        state.excludedMessageKeys = new Set();
      }
      if (fileChanged) migrationCenter.importedConversationSource = null;
      state.file = file;
      state.messages = [];
      state.cleanupCandidates = [];
      importButton.disabled = true;
      fileTitle.textContent = file?.name || "파일 선택";
      fileHint.textContent = file ? "읽는 중…" : ".xlsx, .json, .jsonl 또는 .txt, 최대 20MB";
      const lowerName = file?.name?.toLowerCase() || "";
      const isTxt = lowerName.endsWith(".txt");
      const isStructuredText = lowerName.endsWith(".json") || lowerName.endsWith(".jsonl");
      structuredCleanupToggle.label.hidden = !isStructuredText;
      txtOptions.hidden = !(isTxt || (isStructuredText && structuredCleanupToggle.input.checked));
      txtRoleField.hidden = !isTxt;
      metadataToggle.label.hidden = !isTxt;
      cleanupTitle.textContent = isTxt ? "TXT 정리" : "메시지 본문 정리";
      try {
        const result = await parseFile(file, {
          firstImplicitRole: txtFirstRoleSelect.value,
          removeMetadata: metadataToggle.input.checked,
          removeMeaningless: meaninglessToggle.input.checked,
          removeImageMarkers: imageMarkerToggle.input.checked,
          removeUserControlMessages: userControlToggle.input.checked,
          cleanStructuredMessages: structuredCleanupToggle.input.checked,
          characterName: characterSelect.value ? characterSelect.selectedOptions[0]?.textContent || "" : "",
          userName: personaSelect.value ? (personaSelect.selectedOptions[0]?.textContent || "") : "",
          statusMode: statusModeSelect.value,
          disabledCleanupIds: state.disabledCleanupIds,
        });
        const messages = result.messages;
        state.messages = messages;
        state.cleanupCandidates = result.cleanupCandidates || [];
        fileHint.textContent = `${messages.length.toLocaleString()}개 메시지를 확인했습니다.`;
        if (chatNameInput.dataset.edited !== "true") {
          chatNameInput.value = file.name
            .replace(/\.(xlsx|jsonl?|txt)$/i, "")
            .replaceAll("_", " ")
            .trim();
        }
        renderPreview();
        renderCleanupReview();
        publishImportedConversation();
        if (result.issues?.length) {
          showStatus(
            "warning",
            `${result.issues.length.toLocaleString()}개 JSONL 항목을 제외했습니다.\n${summarizeJsonlIssues(result.issues)}`,
          );
        }
      } catch (error) {
        fileHint.textContent = ".xlsx, .json, .jsonl 또는 .txt, 최대 20MB";
        previewCount.textContent = "파일을 읽지 못했습니다";
        previewList.textContent = "";
        previewList.appendChild(
          createElement("div", { className: "cti-empty", text: "파일 내용을 수정한 뒤 다시 선택하세요." }),
        );
        state.cleanupCandidates = [];
        renderCleanupReview();
        showStatus("error", error instanceof Error ? error.message : String(error));
      } finally {
        updateImportAvailability();
      }
    };

    const applyMessageSelection = (predicate) => {
      state.excludedMessageKeys = new Set(
        state.messages
          .map((message, index) => ({ message, index, key: messageKey(message, index) }))
          .filter(({ message, index }) => !predicate(message, index))
          .map(({ key }) => key),
      );
      renderPreview();
      updateImportAvailability();
      publishImportedConversation();
    };
    selectAllButton.addEventListener("click", () => applyMessageSelection(() => true));
    deselectAllButton.addEventListener("click", () => applyMessageSelection(() => false));
    selectUserButton.addEventListener("click", () => applyMessageSelection((message) => message.role === "user"));
    selectAssistantButton.addEventListener("click", () => applyMessageSelection((message) => message.role === "assistant"));

    fileInput.addEventListener("change", () => void handleFile(fileInput.files?.[0], { resetDecisions: true }));
    const refreshCleanup = () => {
      const lowerName = state.file?.name?.toLowerCase() || "";
      const isTxt = lowerName.endsWith(".txt");
      const isEnabledStructured =
        (lowerName.endsWith(".json") || lowerName.endsWith(".jsonl")) && structuredCleanupToggle.input.checked;
      if (isTxt || isEnabledStructured) void handleFile(state.file, { resetDecisions: false });
    };
    structuredCleanupToggle.input.addEventListener("change", () => {
      if (state.file) void handleFile(state.file, { resetDecisions: false });
    });
    txtFirstRoleSelect.addEventListener("change", refreshCleanup);
    metadataToggle.input.addEventListener("change", refreshCleanup);
    meaninglessToggle.input.addEventListener("change", refreshCleanup);
    imageMarkerToggle.input.addEventListener("change", refreshCleanup);
    userControlToggle.input.addEventListener("change", refreshCleanup);
    statusModeSelect.addEventListener("change", () => {
      state.disabledCleanupIds = new Set([...state.disabledCleanupIds].filter((id) => !id.startsWith("status:")));
      refreshCleanup();
    });
    for (const eventName of ["dragenter", "dragover"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.dataset.dragging = "true";
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        delete dropzone.dataset.dragging;
      });
    }
    dropzone.addEventListener("drop", (event) => void handleFile(event.dataTransfer?.files?.[0], { resetDecisions: true }));
    characterSelect.addEventListener("change", () => {
      updateImportAvailability();
      refreshCleanup();
    });
    personaSelect.addEventListener("change", refreshCleanup);
    chatNameInput.addEventListener("input", publishImportedConversation);

    importButton.addEventListener("click", async () => {
      const messagesToImport = selectedMessages();
      if (state.importing || messagesToImport.length === 0) return;
      clearStatus();
      state.importing = true;
      updateImportAvailability();
      importButton.textContent = "채팅 생성 중…";
      const timestamps = normalizedMessageTimestamps(messagesToImport);
      const selectedCharacterId = characterSelect.value || null;
      let createdChatId = null;
      const requestScheduler = importRequestCore.createRequestScheduler({
        request: apiRequest,
        minIntervalMs:
          messagesToImport.length >= BULK_IMPORT_THROTTLE_THRESHOLD ? importRequestCore.DEFAULT_MIN_INTERVAL_MS : 0,
      });
      const requestWithRetry = (path, options, label) =>
        requestScheduler.run(path, options, {
          onRetry: ({ delayMs }) => {
            importButton.textContent = `${label} · 요청 제한으로 ${Math.max(1, Math.ceil(delayMs / 1_000))}초 대기 중…`;
          },
        });
      try {
        if (selectedCharacterId) {
          await requestWithRetry(`/api/characters/${encodeURIComponent(selectedCharacterId)}`, undefined, "캐릭터 확인 중");
        }
        if (personaSelect.value) {
          await requestWithRetry(
            `/api/characters/personas/${encodeURIComponent(personaSelect.value)}`,
            undefined,
            "페르소나 확인 중",
          );
        }
        const chatName =
          chatNameInput.value.trim() ||
          (selectedCharacterId
            ? `${characterSelect.selectedOptions[0]?.textContent || "캐릭터"} 가져온 대화`
            : "가져온 대화");
        const chat = await requestWithRetry("/api/chats", {
          method: "POST",
          body: {
            name: chatName,
            mode: modeSelect.value,
            characterIds: selectedCharacterId ? [selectedCharacterId] : [],
            personaId: personaSelect.value || null,
            createdAt: timestamps[0],
            updatedAt: timestamps.at(-1),
          },
        }, "채팅 생성 중");
        if (!chat?.id) throw new Error("생성된 채팅 ID를 받지 못했습니다.");
        createdChatId = chat.id;
        for (let index = 0; index < messagesToImport.length; index += 1) {
          const message = messagesToImport[index];
          importButton.textContent = `메시지 저장 중 ${index + 1} / ${messagesToImport.length}`;
          await requestWithRetry(`/api/chats/${encodeURIComponent(createdChatId)}/messages`, {
            method: "POST",
            body: {
              role: message.role,
              characterId: message.role === "assistant" ? selectedCharacterId : null,
              content: message.content,
              createdAt: timestamps[index],
            },
          }, `메시지 저장 중 ${index + 1} / ${messagesToImport.length}`);
        }
        showStatus(
          "success",
          `${messagesToImport.length.toLocaleString()}개 메시지를 가져왔습니다. 채팅으로 이동합니다.`,
        );
        importButton.textContent = "완료";
        await new Promise((resolve) => setTimeout(resolve, 350));
        closeModal();
        await navigateToChat(createdChatId);
      } catch (error) {
        let rollbackMessage = "";
        if (createdChatId) {
          try {
            importButton.textContent = "불완전한 채팅 정리 중…";
            await requestWithRetry(
              `/api/chats/${encodeURIComponent(createdChatId)}`,
              { method: "DELETE" },
              "불완전한 채팅 정리 대기 중",
            );
            rollbackMessage = " 생성된 불완전한 채팅은 삭제했습니다.";
          } catch (rollbackError) {
            rollbackMessage = ` 불완전한 채팅(${createdChatId})을 자동 삭제하지 못했습니다: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`;
          }
        }
        showStatus("error", `${error instanceof Error ? error.message : String(error)}${rollbackMessage}`);
        state.importing = false;
        importButton.textContent = "Import 다시 실행";
        updateImportAvailability();
      }
    });

    const keydown = (event) => {
      if (event.key === "Escape" && !state.importing) closeModal();
    };
    root.addEventListener("click", (event) => {
      if (event.target === root && !state.importing) closeModal();
    });
    document.addEventListener("keydown", keydown, { once: false });
    modalCleanup = () => document.removeEventListener("keydown", keydown);
    closeButton.focus();

    void loadChoices()
      .then(async ({ characters, personas }) => {
        for (const character of characters) characterSelect.append(option(character.id, character.name));
        for (const persona of personas) personaSelect.append(option(persona.id, persona.name));
        const context = await Promise.resolve(hostMarinara.context?.get?.()).catch(() => null);
        const activeCharacterId = context?.characterIds?.length === 1 ? context.characterIds[0] : null;
        if (activeCharacterId && characters.some((character) => character.id === activeCharacterId)) {
          characterSelect.value = activeCharacterId;
        }
        const activePersonaId = context?.personaId || personas.find((persona) => persona.active)?.id || "";
        if (activePersonaId && personas.some((persona) => persona.id === activePersonaId))
          personaSelect.value = activePersonaId;
        characterSelect.disabled = false;
        personaSelect.disabled = false;
        state.choicesLoaded = true;
        updateImportAvailability();
      })
      .catch((error) => {
        showStatus(
          "error",
          `캐릭터와 페르소나를 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  function createLauncher() {
    const button = createElement("button", {
      className: "mari-chrome-control mari-chrome-control--small cti-launcher",
      type: "button",
      ariaLabel: "마리나라 이식 센터 열기",
    });
    button.setAttribute(LAUNCHER_ATTRIBUTE, "true");
    button.title = "대화 가져오기 및 프롬프트 이식";
    button.append(migrationCenterIcon());
    button.addEventListener("click", openImporter);
    return button;
  }

  function mountLauncher() {
    if (document.querySelector(`[${LAUNCHER_ATTRIBUTE}]`)) return;
    const sidebar = document.querySelector('[data-component="ChatSidebar"]');
    const header = sidebar?.querySelector(".mari-sidebar-header");
    if (!header) return;
    const actions = header.lastElementChild;
    if (!(actions instanceof HTMLElement)) return;
    actions.prepend(createLauncher());
  }

  migrationCenter.openImport = openImporter;
  migrationCenter.closeImport = closeModal;
  migrationCenter.open = (view = "import") => {
    if (view === "settings" && typeof migrationCenter.openSettings === "function") migrationCenter.openSettings();
    else if (view === "workspace" && typeof migrationCenter.openWorkspace === "function") migrationCenter.openWorkspace();
    else if (view === "prompt" && typeof migrationCenter.openPrompt === "function") migrationCenter.openPrompt();
    else openImporter();
  };
  migrationCenter.openHelp = openHelp;

  mountLauncher();
  const launcherObserver = new MutationObserver(mountLauncher);
  launcherObserver.observe(document.body, { childList: true, subtree: true });

  hostMarinara.onCleanup(() => {
    launcherObserver.disconnect();
    document.querySelector(`[${LAUNCHER_ATTRIBUTE}]`)?.remove();
    closeHelp();
    closeModal();
    delete migrationCenter.openImport;
    delete migrationCenter.closeImport;
    delete migrationCenter.open;
    delete migrationCenter.openHelp;
    delete migrationCenter.importedConversationSource;
    if (!migrationCenter.openPrompt) delete globalThis.MarinaraMigrationCenter;
    delete globalThis.MarinaraTranscriptXlsx;
  });

  void resumePendingNavigation();
  hostMarinara.log.info("Chat Transcript Importer loaded");
})();
