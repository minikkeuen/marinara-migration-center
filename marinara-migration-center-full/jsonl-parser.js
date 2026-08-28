(() => {
  "use strict";

  const ARRAY_KEYS = Object.freeze(["messages", "conversation", "conversations", "turns"]);
  const USER_ROLES = new Set(["user", "human", "customer", "client", "persona"]);
  const ASSISTANT_ROLES = new Set(["assistant", "ai", "gpt", "bot", "model", "character"]);
  const INTERNAL_FORMAT = "conversation-message-jsonl";

  const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function roleValue(value) {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (USER_ROLES.has(normalized)) return "user";
    if (ASSISTANT_ROLES.has(normalized)) return "assistant";
    if (normalized === "system") return "system";
    return value;
  }

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function isInternalMetadata(record) {
    return (
      isRecord(record) &&
      !hasOwn(record, "mes") &&
      (hasOwn(record, "user_name") || hasOwn(record, "character_name") || hasOwn(record, "chat_metadata"))
    );
  }

  function isInternalMessage(record) {
    return (
      isRecord(record) &&
      hasOwn(record, "mes") &&
      ["is_user", "is_system", "character_id", "swipes", "swipe_id", "send_date"].some((key) => hasOwn(record, key))
    );
  }

  function internalMessage(record) {
    const explicitRole = typeof record.role === "string" && record.role.trim() ? roleValue(record.role) : undefined;
    const fallbackRole = record.is_system === true ? "system" : record.is_user === true ? "user" : record.is_user === false ? "assistant" : undefined;
    return {
      role: explicitRole ?? fallbackRole,
      content: record.mes,
      ...(record.name !== undefined ? { name: record.name } : {}),
      ...(record.send_date !== undefined && record.send_date !== null
        ? { timestamp: timestampValue(record.send_date) }
        : {}),
    };
  }

  function contentValue(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return value;
    const parts = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return typeof part.text === "string"
          ? part.text
          : typeof part.content === "string"
            ? part.content
            : typeof part.value === "string"
              ? part.value
              : "";
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : value;
  }

  function timestampValue(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }

  function canonicalMessage(value, inherited = {}) {
    if (!isRecord(value)) return value;
    const author = isRecord(value.author) ? value.author : {};
    const sender = isRecord(value.sender) ? value.sender : {};
    const authorText = typeof value.author === "string" ? value.author : undefined;
    const senderText = typeof value.sender === "string" ? value.sender : undefined;
    const speaker = typeof value.speaker === "string" ? value.speaker : undefined;
    const speakerRole = roleValue(speaker);
    const speakerIsRole = speakerRole === "user" || speakerRole === "assistant";
    const authorRole = roleValue(authorText);
    const authorIsRole = authorRole === "user" || authorRole === "assistant";
    const senderRole = roleValue(senderText);
    const senderIsRole = senderRole === "user" || senderRole === "assistant";
    const rawRole = firstDefined(
      value.role,
      value.senderRole,
      value.sender_role,
      value.speakerRole,
      value.speaker_role,
      author.role,
      sender.role,
      authorIsRole ? authorRole : undefined,
      senderIsRole ? senderRole : undefined,
      value.from,
      value.type,
      speakerIsRole ? speakerRole : undefined,
      inherited.role,
    );
    const rawContent = firstDefined(
      value.content,
      value.text,
      value.value,
      value.body,
      typeof value.message === "string" ? value.message : undefined,
      inherited.content,
    );
    const name = firstDefined(
      value.name,
      author.name,
      sender.name,
      value.username,
      !authorIsRole ? authorText : undefined,
      !senderIsRole ? senderText : undefined,
      !speakerIsRole ? speaker : undefined,
      inherited.name,
    );
    const timestamp = firstDefined(
      value.timestamp,
      value.createdAt,
      value.created_at,
      value.date,
      value.time,
      inherited.timestamp,
    );
    return {
      role: roleValue(rawRole),
      content: contentValue(rawContent),
      ...(name !== undefined ? { name } : {}),
      ...(timestamp !== undefined ? { timestamp: timestampValue(timestamp) } : {}),
    };
  }

  function pairMessages(record) {
    if (typeof record.instruction === "string" && typeof record.output === "string") {
      const input = typeof record.input === "string" && record.input.trim() ? `\n\n${record.input}` : "";
      return [
        canonicalMessage({ role: "user", content: `${record.instruction}${input}`, timestamp: record.timestamp }),
        canonicalMessage({ role: "assistant", content: record.output, timestamp: record.timestamp }),
      ];
    }
    for (const [userKey, assistantKey] of [
      ["user", "assistant"],
      ["prompt", "response"],
      ["input", "output"],
    ]) {
      if (typeof record[userKey] === "string" && typeof record[assistantKey] === "string") {
        return [
          canonicalMessage({ role: "user", content: record[userKey], timestamp: record.timestamp }),
          canonicalMessage({ role: "assistant", content: record[assistantKey], timestamp: record.timestamp }),
        ];
      }
    }
    return null;
  }

  function recordsFromLine(record) {
    for (const key of ARRAY_KEYS) {
      if (Array.isArray(record[key])) return record[key].map((value) => canonicalMessage(value));
    }
    if (isRecord(record.message)) {
      return [canonicalMessage(record.message, canonicalMessage(record))];
    }
    const pair = pairMessages(record);
    if (pair) return pair;
    return [canonicalMessage(record)];
  }

  function parseJsonl(text) {
    const candidates = [];
    const issues = [];
    let metadata = null;
    let format = null;
    let objectIndex = 0;
    const lines = String(text ?? "").split(/\r?\n/);
    lines.forEach((source, index) => {
      const lineNumber = index + 1;
      if (!source.trim()) return;
      let record;
      try {
        record = JSON.parse(source);
      } catch (error) {
        issues.push({
          lineNumber,
          message: `${lineNumber}행의 JSON 문법이 올바르지 않습니다: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (!isRecord(record)) {
        issues.push({ lineNumber, message: `${lineNumber}행은 JSON 객체여야 합니다.` });
        return;
      }
      const isFirstObject = objectIndex === 0;
      objectIndex += 1;
      if (isFirstObject && isInternalMetadata(record)) {
        metadata = record;
        format = INTERNAL_FORMAT;
        return;
      }
      const internal = isInternalMessage(record);
      if (internal) format = INTERNAL_FORMAT;
      const values = internal ? [internalMessage(record)] : recordsFromLine(record);
      values.forEach((value, itemIndex) => {
        candidates.push({
          value,
          lineNumber,
          itemIndex,
          itemLabel: values.length === 1 ? `${lineNumber}행` : `${lineNumber}행 ${itemIndex + 1}번째 메시지`,
        });
      });
    });
    return { candidates, issues, format, metadata };
  }

  globalThis.MarinaraTranscriptJsonl = Object.freeze({ INTERNAL_FORMAT, isInternalMetadata, isInternalMessage, parseJsonl });
})();
