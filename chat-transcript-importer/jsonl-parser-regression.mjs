import fs from "node:fs";
import vm from "node:vm";

const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const importerSource = fs.readFileSync(new URL("./chat-transcript-importer.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("./jsonl-parser.js", import.meta.url), "utf8"), context);
const parser = context.globalThis.MarinaraTranscriptJsonl;
const checks = [];
const check = (name, condition) => {
  if (!condition) throw new Error(`Failed: ${name}`);
  checks.push(name);
};

const result = parser.parseJsonl([
  "",
  JSON.stringify({ role: "user", content: "Hello", name: "Min", timestamp: "2026-08-28T10:00:00Z" }),
  "{bad json",
  JSON.stringify({ sender: "bot", text: "Hi", created_at: "2026-08-28T10:00:01Z" }),
  JSON.stringify({ conversations: [{ from: "human", value: "Question" }, { from: "gpt", value: "Answer" }] }),
  JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "Part one" }, { type: "text", text: "Part two" }] }] }),
  JSON.stringify({ prompt: "Prompt", response: "Response" }),
  JSON.stringify({ message: { role: "assistant", content: "Nested" }, timestamp: "2026-08-28T10:00:02Z" }),
  JSON.stringify({ sender: "bot", message: { text: "Inherited role" } }),
  JSON.stringify({ instruction: "Instruction", input: "Context", output: "Completion" }),
  JSON.stringify({ role: "user", content: "Epoch", timestamp: 1_700_000_000 }),
  "[]",
].join("\n"));

check("blank lines are ignored", result.candidates[0].lineNumber === 2);
check("malformed JSON is isolated", result.issues.some((issue) => issue.lineNumber === 3));
check("non-object rows are isolated", result.issues.some((issue) => issue.lineNumber === 12));
check("direct messages preserve canonical fields", result.candidates[0].value.name === "Min");
check("sender and text aliases normalize", result.candidates[1].value.role === "assistant" && result.candidates[1].value.content === "Hi");
check("ShareGPT conversations expand", result.candidates[2].value.role === "user" && result.candidates[3].value.role === "assistant");
check("content part arrays become readable text", result.candidates[4].value.content === "Part one\nPart two");
check("prompt and response pairs expand", result.candidates[5].value.role === "user" && result.candidates[6].value.role === "assistant");
check("nested messages inherit outer timestamps", result.candidates[7].value.timestamp === "2026-08-28T10:00:02Z");
check("expanded messages retain their source line", result.candidates[3].lineNumber === 5);
check("nested messages inherit outer sender roles", result.candidates[8].value.role === "assistant");
check(
  "instruction datasets preserve instruction and input",
  result.candidates[9].value.content === "Instruction\n\nContext" && result.candidates[10].value.content === "Completion",
);
check("numeric epoch timestamps normalize to ISO", result.candidates[11].value.timestamp === "2023-11-14T22:13:20.000Z");
check(
  "manifest loads the JSONL adapter before the importer",
  manifest.config.jsPath.indexOf("jsonl-parser.js") < manifest.config.jsPath.indexOf("chat-transcript-importer.js"),
);
check("file picker accepts JSONL", importerSource.includes('fileInput.accept = ".xlsx,.json,.jsonl,.txt"'));
check("JSONL files use the dedicated parser", importerSource.includes('lowerName.endsWith(".jsonl")'));

const internalSample = [
  JSON.stringify({
    user_name: "서진",
    character_name: "정훈",
    create_date: "2026-08-28T10:27:36.503Z",
    chat_metadata: { source: "caveduck", source_url: "https://example.invalid", exported_at: "2026-08-28", extractor: "fixture" },
  }),
  JSON.stringify({
    name: "정훈",
    is_user: true,
    is_system: false,
    role: "assistant",
    character_id: "character-1",
    mes: "첫 줄\n\"따옴표\"와 {JSON처럼 보이는 문자열}은 그대로 유지",
    swipes: ["다른 swipe", "현재 swipe"],
    swipe_id: 1,
    send_date: null,
    extra: { source: "caveduck" },
  }),
  JSON.stringify({ name: "System", is_user: false, is_system: true, mes: "System notice", send_date: "2026-08-28T10:27:37.000Z" }),
  JSON.stringify({ name: "서진", is_user: true, is_system: false, mes: "User line", send_date: null }),
  JSON.stringify({ name: "정훈", is_user: false, is_system: false, mes: "Assistant fallback", send_date: null }),
].join("\n");
const internal = parser.parseJsonl(internalSample);
check("internal metadata is detected only as the first object", internal.format === parser.INTERNAL_FORMAT && internal.metadata.user_name === "서진");
check("metadata is not emitted as a message", internal.candidates.length === 4 && internal.candidates[0].lineNumber === 2);
check("explicit role takes priority over is_user", internal.candidates[0].value.role === "assistant");
check("mes content remains byte-for-byte equivalent after JSON decoding", internal.candidates[0].value.content === "첫 줄\n\"따옴표\"와 {JSON처럼 보이는 문자열}은 그대로 유지");
check("null send_date delegates to timestamp fallback", !("timestamp" in internal.candidates[0].value));
check("is_system provides the system role fallback", internal.candidates[1].value.role === "system");
check("is_user true provides the user role fallback", internal.candidates[2].value.role === "user");
check("is_user false provides the assistant role fallback", internal.candidates[3].value.role === "assistant");
check("send_date becomes the canonical timestamp", internal.candidates[1].value.timestamp === "2026-08-28T10:27:37.000Z");
check("swipes do not replace the required mes content", internal.candidates[0].value.content !== "현재 swipe");
check("JSONL integration explicitly allows Engine-supported system messages", importerSource.includes("allowSystem: true"));
check("structured body cleanup defaults off", importerSource.includes('const structuredCleanupToggle = makeToggle("본문 정리 사용", false)'));
check("JSON and JSONL share the optional cleanup stage", (importerSource.match(/maybeSanitizeStructured\(/g) || []).length === 3);
check("TXT continues through the shared body sanitizer", importerSource.includes("sanitizeMessageBodies(parsed"));
check("the old TXT-only sanitizer name is removed", !importerSource.includes("sanitizeTxtMessages"));

console.info(`${checks.length} JSONL parser regression checks passed`);
