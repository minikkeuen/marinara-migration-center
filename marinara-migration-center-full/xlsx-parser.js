(() => {
  "use strict";

  const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
  const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
  const MAX_TOTAL_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
  const EOCD_SIGNATURE = 0x06054b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;
  const UTF8 = new TextDecoder("utf-8", { fatal: true });
  const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

  class XlsxParseError extends Error {
    constructor(message) {
      super(message);
      this.name = "XlsxParseError";
    }
  }

  const fail = (message) => {
    throw new XlsxParseError(message);
  };

  const readU16 = (view, offset) => view.getUint16(offset, true);
  const readU32 = (view, offset) => view.getUint32(offset, true);

  function normalizeArchivePath(path) {
    const parts = [];
    for (const part of String(path).replaceAll("\\", "/").replace(/^\/+/, "").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  }

  function resolveArchivePath(baseFile, target) {
    if (String(target).startsWith("/")) return normalizeArchivePath(target);
    const baseParts = normalizeArchivePath(baseFile).split("/");
    baseParts.pop();
    return normalizeArchivePath([...baseParts, target].join("/"));
  }

  function findEndOfCentralDirectory(bytes, view) {
    const floor = Math.max(0, bytes.length - 65_557);
    for (let offset = bytes.length - 22; offset >= floor; offset -= 1) {
      if (readU32(view, offset) === EOCD_SIGNATURE) return offset;
    }
    fail("Excel 파일의 ZIP 디렉터리를 찾을 수 없습니다.");
  }

  function readArchiveDirectory(bytes) {
    if (bytes.length > MAX_ARCHIVE_BYTES) fail("Excel 파일은 20MB 이하여야 합니다.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocdOffset = findEndOfCentralDirectory(bytes, view);
    const diskNumber = readU16(view, eocdOffset + 4);
    const centralDisk = readU16(view, eocdOffset + 6);
    const entryCount = readU16(view, eocdOffset + 10);
    const centralOffset = readU32(view, eocdOffset + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || entryCount === 0xffff) {
      fail("분할 ZIP 또는 ZIP64 형식의 Excel 파일은 지원하지 않습니다.");
    }

    const entries = new Map();
    let offset = centralOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > bytes.length || readU32(view, offset) !== CENTRAL_SIGNATURE) {
        fail("Excel 파일의 ZIP 디렉터리가 손상되었습니다.");
      }
      const flags = readU16(view, offset + 8);
      const method = readU16(view, offset + 10);
      const compressedSize = readU32(view, offset + 20);
      const uncompressedSize = readU32(view, offset + 24);
      const nameLength = readU16(view, offset + 28);
      const extraLength = readU16(view, offset + 30);
      const commentLength = readU16(view, offset + 32);
      const localOffset = readU32(view, offset + 42);
      const nameStart = offset + 46;
      const nameEnd = nameStart + nameLength;
      if (nameEnd > bytes.length) fail("Excel 파일의 ZIP 항목 이름이 손상되었습니다.");
      if ((flags & 1) !== 0) fail("암호화된 Excel 파일은 지원하지 않습니다.");
      if (method !== 0 && method !== 8) fail(`지원하지 않는 Excel 압축 방식입니다: ${method}`);
      if (uncompressedSize > MAX_ENTRY_BYTES) fail("Excel 내부 항목 하나가 32MB를 초과합니다.");
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        fail("압축 해제된 Excel 데이터가 64MB를 초과합니다.");
      }
      let name;
      try {
        name = normalizeArchivePath(UTF8.decode(bytes.subarray(nameStart, nameEnd)));
      } catch {
        fail("Excel 파일에 UTF-8이 아닌 ZIP 항목 이름이 있습니다.");
      }
      if (name) entries.set(name, { name, flags, method, compressedSize, uncompressedSize, localOffset });
      offset = nameEnd + extraLength + commentLength;
    }
    return { bytes, view, entries };
  }

  async function inflateRawLimited(compressed, expectedSize) {
    if (typeof DecompressionStream !== "function") {
      fail("이 브라우저는 Excel 압축 해제를 지원하지 않습니다. 최신 Chromium 기반 브라우저를 사용하세요.");
    }
    let stream;
    try {
      stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    } catch {
      fail("이 브라우저는 Excel의 DEFLATE 압축을 지원하지 않습니다.");
    }
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ENTRY_BYTES || total > expectedSize + 1024) {
          await reader.cancel();
          fail("Excel 내부 항목의 압축 해제 크기가 유효하지 않습니다.");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof XlsxParseError) throw error;
      fail("Excel 압축 데이터를 해제하지 못했습니다.");
    }
    if (total !== expectedSize) fail("Excel 내부 항목의 크기가 ZIP 정보와 일치하지 않습니다.");
    const output = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of chunks) {
      output.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return output;
  }

  async function readArchiveEntry(archive, path, required = true) {
    const normalized = normalizeArchivePath(path);
    const entry = archive.entries.get(normalized);
    if (!entry) {
      if (required) fail(`Excel 내부 파일이 없습니다: ${normalized}`);
      return null;
    }
    const { bytes, view } = archive;
    const offset = entry.localOffset;
    if (offset + 30 > bytes.length || readU32(view, offset) !== LOCAL_SIGNATURE) {
      fail(`Excel 내부 파일이 손상되었습니다: ${normalized}`);
    }
    const nameLength = readU16(view, offset + 26);
    const extraLength = readU16(view, offset + 28);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) fail(`Excel 내부 파일 데이터가 잘렸습니다: ${normalized}`);
    const compressed = bytes.subarray(dataStart, dataEnd);
    return entry.method === 0 ? compressed.slice() : inflateRawLimited(compressed, entry.uncompressedSize);
  }

  function decodeXml(bytes, label) {
    let source;
    try {
      source = UTF8.decode(bytes);
    } catch {
      fail(`${label} XML이 UTF-8이 아닙니다.`);
    }
    const documentValue = new DOMParser().parseFromString(source, "application/xml");
    if (documentValue.getElementsByTagName("parsererror").length > 0) fail(`${label} XML이 손상되었습니다.`);
    return documentValue;
  }

  const elements = (root, localName) => Array.from(root.getElementsByTagNameNS("*", localName));
  const firstElement = (root, localName) => elements(root, localName)[0] ?? null;
  const attribute = (node, name) => node?.getAttribute(name) ?? "";

  function relationshipMap(documentValue, baseFile) {
    const map = new Map();
    for (const relationship of elements(documentValue, "Relationship")) {
      const id = attribute(relationship, "Id");
      const target = attribute(relationship, "Target");
      const type = attribute(relationship, "Type");
      if (id && target) map.set(id, { path: resolveArchivePath(baseFile, target), type });
    }
    return map;
  }

  function textRuns(node) {
    return elements(node, "t")
      .map((item) => item.textContent ?? "")
      .join("");
  }

  function parseSharedStrings(documentValue) {
    return elements(documentValue, "si").map(textRuns);
  }

  function isDateFormatCode(code) {
    const normalized = String(code)
      .replace(/"[^"]*"/g, "")
      .replace(/\\./g, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/_.|\*./g, "")
      .toLowerCase();
    return /(^|[^a-z])[ymdhis]+([^a-z]|$)/i.test(normalized);
  }

  function parseDateStyles(documentValue) {
    const dateIds = new Set(DATE_FORMAT_IDS);
    for (const format of elements(documentValue, "numFmt")) {
      const id = Number(attribute(format, "numFmtId"));
      if (Number.isInteger(id) && isDateFormatCode(attribute(format, "formatCode"))) dateIds.add(id);
    }
    const cellXfs = firstElement(documentValue, "cellXfs");
    if (!cellXfs) return [];
    return Array.from(cellXfs.children).map((xf) => dateIds.has(Number(attribute(xf, "numFmtId"))));
  }

  function excelSerialToIso(serial, uses1904DateSystem) {
    const numeric = Number(serial);
    if (!Number.isFinite(numeric)) return null;
    const adjustedDays = uses1904DateSystem ? numeric + 1462 : numeric - (numeric >= 60 ? 1 : 0);
    const milliseconds = Math.round(Date.UTC(1899, 11, 31) + adjustedDays * 86_400_000);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function columnIndex(reference) {
    const match = String(reference).match(/^([A-Z]+)/i);
    if (!match) return -1;
    let value = 0;
    for (const character of match[1].toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
    return value - 1;
  }

  function readCellValue(cell, sharedStrings, dateStyles, uses1904DateSystem) {
    const type = attribute(cell, "t");
    if (type === "inlineStr") return textRuns(firstElement(cell, "is") ?? cell);
    const raw = firstElement(cell, "v")?.textContent ?? "";
    if (type === "s") return sharedStrings[Number(raw)] ?? "";
    if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
    if (type === "e") return "";
    const styleIndex = Number(attribute(cell, "s"));
    if (raw && dateStyles[styleIndex] === true) return excelSerialToIso(raw, uses1904DateSystem) ?? raw;
    return raw;
  }

  function rowValues(row, sharedStrings, dateStyles, uses1904DateSystem) {
    const values = [];
    for (const cell of elements(row, "c")) {
      const index = columnIndex(attribute(cell, "r"));
      if (index >= 0) values[index] = readCellValue(cell, sharedStrings, dateStyles, uses1904DateSystem);
    }
    return values;
  }

  function roleValue(value, rowNumber) {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase();
    if (normalized === "user" || normalized === "human") return "user";
    if (normalized === "assistant" || normalized === "ai") return "assistant";
    fail(`${rowNumber}행의 role 값 '${String(value ?? "")}'은 지원하지 않습니다.`);
  }

  function parseWorksheet(documentValue, sharedStrings, dateStyles, uses1904DateSystem) {
    const rows = elements(documentValue, "row");
    if (rows.length === 0) fail("Excel 첫 번째 워크시트가 비어 있습니다.");
    const headerValues = rowValues(rows[0], sharedStrings, dateStyles, uses1904DateSystem);
    const headers = new Map();
    headerValues.forEach((value, index) => {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
      if (normalized && !headers.has(normalized)) headers.set(normalized, index);
    });
    if (!headers.has("role") || !headers.has("content")) {
      fail("Excel 첫 행에는 role과 content 열이 모두 필요합니다.");
    }

    const result = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      const values = rowValues(row, sharedStrings, dateStyles, uses1904DateSystem);
      const rowNumber = Number(attribute(row, "r")) || index + 1;
      const role = values[headers.get("role")];
      const content = values[headers.get("content")];
      const name = headers.has("name") ? values[headers.get("name")] : undefined;
      const timestamp = headers.has("timestamp") ? values[headers.get("timestamp")] : undefined;
      const isEmpty = [role, content, name, timestamp].every((value) => String(value ?? "").trim() === "");
      if (isEmpty) continue;
      if (String(role ?? "").trim() === "") fail(`${rowNumber}행에 role 값이 없습니다.`);
      if (String(content ?? "").trim() === "") fail(`${rowNumber}행에 content 값이 없습니다.`);
      result.push({
        role: roleValue(role, rowNumber),
        content: String(content),
        ...(String(name ?? "").trim() ? { name: String(name).trim() } : {}),
        ...(String(timestamp ?? "").trim() ? { timestamp: String(timestamp).trim() } : {}),
        sourceIndex: rowNumber,
      });
    }
    if (result.length === 0) fail("가져올 메시지가 없습니다.");
    return result;
  }

  async function parseXlsx(arrayBuffer) {
    const archive = readArchiveDirectory(new Uint8Array(arrayBuffer));
    const workbookPath = archive.entries.has("xl/workbook.xml")
      ? "xl/workbook.xml"
      : [...archive.entries.keys()].find((path) => path.endsWith("/workbook.xml"));
    if (!workbookPath) fail("Excel workbook.xml을 찾을 수 없습니다.");
    const workbookDocument = decodeXml(await readArchiveEntry(archive, workbookPath), "workbook");
    const workbookProperties = firstElement(workbookDocument, "workbookPr");
    const uses1904DateSystem = ["1", "true"].includes(attribute(workbookProperties, "date1904").toLowerCase());
    const workbookName = workbookPath.split("/").pop();
    const workbookDirectory = workbookPath.slice(0, -(workbookName.length + 1));
    const relationshipsPath = `${workbookDirectory}/_rels/${workbookName}.rels`;
    const relationshipDocument = decodeXml(
      await readArchiveEntry(archive, relationshipsPath),
      "workbook relationships",
    );
    const relationships = relationshipMap(relationshipDocument, workbookPath);
    const firstSheet = firstElement(workbookDocument, "sheet");
    if (!firstSheet) fail("Excel workbook에 워크시트가 없습니다.");
    const sheetRelationshipId =
      firstSheet.getAttribute("r:id") ||
      firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const sheetPath = relationships.get(sheetRelationshipId)?.path;
    if (!sheetPath) fail("첫 번째 Excel 워크시트 경로를 찾을 수 없습니다.");

    const sharedRelationship = [...relationships.values()].find((item) => item.type.endsWith("/sharedStrings"));
    const stylesRelationship = [...relationships.values()].find((item) => item.type.endsWith("/styles"));
    const sharedBytes = sharedRelationship ? await readArchiveEntry(archive, sharedRelationship.path, false) : null;
    const stylesBytes = stylesRelationship ? await readArchiveEntry(archive, stylesRelationship.path, false) : null;
    const sharedStrings = sharedBytes ? parseSharedStrings(decodeXml(sharedBytes, "shared strings")) : [];
    const dateStyles = stylesBytes ? parseDateStyles(decodeXml(stylesBytes, "styles")) : [];
    const worksheetDocument = decodeXml(await readArchiveEntry(archive, sheetPath), "worksheet");
    return parseWorksheet(worksheetDocument, sharedStrings, dateStyles, uses1904DateSystem);
  }

  globalThis.MarinaraTranscriptXlsx = Object.freeze({ parseXlsx, XlsxParseError });
})();
