import fs from "node:fs";
import vm from "node:vm";

const manifest = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
const importerSource = fs.readFileSync(new URL("./chat-transcript-importer.js", import.meta.url), "utf8");
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL("./message-cleanup-core.js", import.meta.url), "utf8"), context);
const core = context.globalThis.MarinaraMessageCleanupCore;
const checks = [];
const check = (name, condition) => {
  if (!condition) throw new Error(`Failed: ${name}`);
  checks.push(name);
};

check("plain control messages remain detectable", core.isUserControlOnlyMessage("이어서"));
check("double-quoted controls are detectable", core.isUserControlOnlyMessage('"이어서"'));
check("multiply quoted controls are detectable", core.isUserControlOnlyMessage('\"\"\"!continue\"\"\"'));
check("escaped quoted OOC controls are detectable", core.isUserControlOnlyMessage('\\\"[OOC: continue]\\\"'));
check("smart-quoted controls are detectable", core.isUserControlOnlyMessage("“[명령어: 계속]”"));
check("quoted ordinary prose is not a control", !core.isUserControlOnlyMessage('"오늘은 계속 비가 내렸다."'));
check("quote-only residue is meaningless", core.isMeaninglessMessage('\"\"\"\"'));
check("quoted empty placeholders are meaningless", core.isMeaninglessMessage('"."'));
check("ellipsis remains meaningful under the existing policy", !core.isMeaninglessMessage('"..."'));
check("detection never mutates the caller string", (() => { const value = '\\\"이어서\\\"'; core.detectionText(value); return value === '\\\"이어서\\\"'; })());
check(
  "cleanup core loads before the importer",
  manifest.config.jsPath.indexOf("message-cleanup-core.js") < manifest.config.jsPath.indexOf("chat-transcript-importer.js"),
);
check("importer uses the shared cleanup detector", importerSource.includes("messageCleanupCore.isUserControlOnlyMessage"));

console.info(`${checks.length} message cleanup regression checks passed`);
