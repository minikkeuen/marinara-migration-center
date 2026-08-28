(() => {
  "use strict";

  const QUOTE_PAIRS = Object.freeze([
    ["\"", "\""],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
    ["＂", "＂"],
  ]);

  function detectionText(content) {
    let value = String(content ?? "").trim();
    for (let depth = 0; depth < 12 && value; depth += 1) {
      const unescaped = value.replace(/\\(["'“”‘’＂])/g, "$1").trim();
      let next = unescaped;
      const pair = QUOTE_PAIRS.find(([open, close]) => next.length >= open.length + close.length && next.startsWith(open) && next.endsWith(close));
      if (pair) next = next.slice(pair[0].length, -pair[1].length).trim();
      if (next === value) break;
      value = next;
    }
    return value;
  }

  function isMeaninglessMessage(content) {
    const value = detectionText(content);
    if (!value) return true;
    if (/^`{3,}\s*$/.test(value)) return true;
    if (/^\.\s*$/.test(value)) return true;
    if (/^\.\s*\([^)]*(?:\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}:\d{2})[^)]*\)\s*$/.test(value)) return true;
    if (/^\(?\s*\d{4}[-./]\s*\d{1,2}[-./]\s*\d{1,2}(?:\s+(?:오전|오후|AM|PM)?\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*\)?$/i.test(value)) return true;
    return false;
  }

  function isQuoteWrappedStatusLine(content) {
    const original = String(content ?? "").trim();
    const detected = detectionText(original);
    return detected !== original && detected.startsWith("📍");
  }

  function isUserControlOnlyMessage(content) {
    const value = detectionText(content);
    if (!value) return false;
    if (/^(?:이어서|이어\s*서\s*진행|이어서\s*(?:계속|진행|진행해|진행해줘|써줘|작성해줘)|계속|계속\s*(?:진행|진행해|진행해줘)|다음|계속해|계속해줘|이어줘|이어\s*가|이어가|진행해|진행해줘)[.!?…~\s]*$/i.test(value)) {
      return true;
    }
    if (/^\[[^\]\r\n]{1,200}\]$/.test(value)) return true;
    if (/^![^\s!][^\r\n]*$/.test(value)) return true;
    if (/^\[\s*OOC\s*:[\s\S]*\]$/i.test(value)) return true;
    if (/^<\s*OOC\s*>[\s\S]*<\s*\/\s*OOC\s*>$/i.test(value)) return true;
    return false;
  }

  globalThis.MarinaraMessageCleanupCore = Object.freeze({
    detectionText,
    isMeaninglessMessage,
    isQuoteWrappedStatusLine,
    isUserControlOnlyMessage,
  });
})();
