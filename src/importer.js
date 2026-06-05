import { decompressFromBase64 } from "./lz-string.js";

export const REFERENCE_SAVE_KEY = "poke-sheet-save-data";

export function normalizeStickerKey(value) {
  return String(value ?? "")
    .replace(/[\s_]+/g, "")
    .toLowerCase();
}

export function createCatalogIndex(stickers) {
  const byNormalizedKey = new Map();

  for (const sticker of stickers ?? []) {
    const normalizedKey = sticker.normalizedKey || normalizeStickerKey(sticker.key);
    byNormalizedKey.set(normalizedKey, {
      ...sticker,
      normalizedKey,
    });
  }

  return {
    stickers,
    byNormalizedKey,
  };
}

export function decodeReferenceInput(input, options = {}) {
  const { allowJson = true } = options;
  const text = extractSharePayload(String(input ?? "").trim());
  if (!text) throw new Error("가져올 데이터가 비어 있습니다.");

  if (looksLikeJson(text)) {
    if (!allowJson) {
      throw new Error("저장 JSON 직접 입력은 지원하지 않습니다. 참고 프로그램의 공유 코드 또는 공유 링크를 입력하세요.");
    }
    return JSON.parse(text);
  }

  const cleaned = text.replace(/[^A-Za-z0-9+/=]/g, "");
  const decompressed = decompressFromBase64(cleaned);
  if (decompressed && looksLikeJson(decompressed)) return JSON.parse(decompressed);

  const decoded = decodeBase64Text(cleaned);
  if (decoded && looksLikeJson(decoded)) return JSON.parse(decoded);

  throw new Error("공유 코드 또는 저장 데이터 형식을 해석할 수 없습니다.");
}

export function transformReferenceData(rawData, catalogIndex) {
  const wantedGroups = normalizeWantedGroups(rawData, catalogIndex);
  const ownedGroups = normalizeOwnedGroups(rawData, catalogIndex);
  const validation = validateImportedGroups(wantedGroups, ownedGroups);

  return {
    source: "poke30-tra",
    importedAt: new Date().toISOString(),
    haveLayoutMode: rawData?.haveLayoutMode === "single" ? "single" : "split",
    wantedGroups,
    ownedGroups,
    validation,
    rawData,
  };
}

export function parseReferenceInput(input, catalogIndex, options = {}) {
  return transformReferenceData(decodeReferenceInput(input, options), catalogIndex);
}

export function refreshImportedData(importedData) {
  const wantedGroups = importedData?.wantedGroups ?? [];
  const ownedGroups = importedData?.ownedGroups ?? [];

  return {
    ...importedData,
    wantedGroups,
    ownedGroups,
    validation: validateImportedGroups(wantedGroups, ownedGroups),
  };
}

export function makeStickerItem(sticker, category = "owned") {
  const normalizedKey = sticker?.normalizedKey || normalizeStickerKey(sticker?.key);

  return {
    rawKey: sticker?.key ?? "",
    normalizedKey,
    key: sticker?.key ?? "",
    name: sticker?.name ?? "",
    number: sticker?.number ?? "",
    imagePath: sticker?.imagePath ?? "",
    category,
    status: sticker ? "ok" : "unknown",
  };
}

export function validateDraftForPublish(importedData, formData) {
  const errors = [];
  const nickname = String(formData?.nickname ?? "").trim();
  const contact = String(formData?.contact ?? "").trim();

  if (!nickname) errors.push("닉네임을 입력하세요.");
  if (!contact) errors.push("연락처를 입력하세요.");
  if (!importedData) errors.push("게시할 가져오기 데이터가 없습니다.");

  if ((importedData?.validation?.wantedCount ?? 0) + (importedData?.validation?.ownedCount ?? 0) < 1) {
    errors.push("구해요 또는 보유중 목록을 하나 이상 등록하세요.");
  }

  if (importedData?.validation?.unknownCount > 0) {
    errors.push("알 수 없는 스티커가 있어 게시할 수 없습니다.");
  }

  if (importedData?.validation?.duplicateCount > 0) {
    errors.push("중복 스티커가 있어 게시할 수 없습니다.");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function buildListing(importedData, formData) {
  const validation = validateDraftForPublish(importedData, formData);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }

  return {
    id: cryptoRandomId(),
    source: importedData.source,
    createdAt: new Date().toISOString(),
    nickname: String(formData.nickname).trim(),
    contact: String(formData.contact).trim(),
    body: String(formData.body ?? "").trim(),
    images: normalizeListingImages(formData),
    image: normalizeListingImages(formData)[0] ?? null,
    transferWilling: Boolean(formData.transferWilling),
    wantedGroups: importedData.wantedGroups,
    ownedGroups: importedData.ownedGroups,
  };
}

function normalizeListingImages(formData) {
  if (Array.isArray(formData?.images)) return formData.images.filter(Boolean);
  return formData?.image ? [formData.image] : [];
}

export function createListingOwnerKey(formData) {
  const contact = normalizeOwnerText(formData?.contact);
  const nickname = normalizeOwnerText(formData?.nickname);

  if (contact) return `contact:${contact}`;
  if (nickname) return `nickname:${nickname}`;
  return "";
}

export function findPersonalListing(listings, formData, options = {}) {
  const matches = findPersonalListingMatches(listings, formData, options);
  return matches[0]?.listing ?? null;
}

export function upsertPersonalListing(listings, draftListing, formData, options = {}) {
  const ownerKey = createListingOwnerKey(formData ?? draftListing);
  const matches = findPersonalListingMatches(listings, formData ?? draftListing, options);
  const existing = matches[0]?.listing ?? null;
  const now = typeof options.now === "function" ? options.now() : new Date().toISOString();

  const listing = existing
    ? {
        ...existing,
        ...draftListing,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
        ownerKey,
      }
    : {
        ...draftListing,
        updatedAt: null,
        ownerKey,
      };

  const matchIndexes = new Set(matches.map((match) => match.index));
  const remaining = (listings || []).filter((_, index) => !matchIndexes.has(index));

  return {
    action: existing ? "updated" : "created",
    listing,
    listings: [listing, ...remaining],
  };
}

export function sortListingsForProfile(listings, profile) {
  const preparedProfile = prepareProfileForSort(profile);

  return [...(listings || [])]
    .map((listing, index) => ({
      listing,
      index,
      score: scoreListingForProfile(listing, preparedProfile),
    }))
    .sort(compareListingScores)
    .map(({ listing }) => listing);
}

function normalizeWantedGroups(rawData, catalogIndex) {
  const priorityIcons = ensureArrayLength(rawData?.priorityIcons, 4, []);
  const prioritySubtitles = ensureArrayLength(rawData?.prioritySubtitles, 4, "");

  return priorityIcons.map((items, index) => ({
    id: `priority-${index}`,
    label: `${index + 1}순위`,
    subtitle: String(prioritySubtitles[index] ?? "").trim(),
    items: normalizeItems(items, catalogIndex, "wanted"),
  }));
}

function normalizeOwnedGroups(rawData, catalogIndex) {
  if (rawData?.haveLayoutMode === "single") {
    return [
      {
        id: "have-single",
        label: "통합",
        subtitle: "",
        items: normalizeItems(rawData?.otherIcons, catalogIndex, "owned"),
      },
    ];
  }

  const splitIcons = ensureArrayLength(rawData?.otherIconsSplit, 4, []);
  const subtitles = ensureArrayLength(rawData?.haveSplitSubtitles, 4, "");

  return splitIcons.map((items, index) => ({
    id: `have-split-${index}`,
    label: `보유 ${index + 1}`,
    subtitle: String(subtitles[index] ?? "").trim(),
    items: normalizeItems(items, catalogIndex, "owned"),
  }));
}

function normalizeItems(items, catalogIndex, category) {
  return toArray(items).map((rawKey) => {
    const normalizedKey = normalizeStickerKey(rawKey);
    const sticker = catalogIndex?.byNormalizedKey?.get(normalizedKey);

    return sticker
      ? makeStickerItem(sticker, category)
      : {
          rawKey: String(rawKey ?? ""),
          normalizedKey,
          key: String(rawKey ?? ""),
          name: "",
          number: "",
          imagePath: "",
          category,
          status: "unknown",
        };
  });
}

function validateImportedGroups(wantedGroups, ownedGroups) {
  const allWanted = wantedGroups.flatMap((group) => group.items);
  const allOwned = ownedGroups.flatMap((group) => group.items);
  const allItems = [...allWanted, ...allOwned];

  for (const item of allItems) {
    if (item.status !== "unknown") item.status = "ok";
  }

  const duplicateKeys = new Set([
    ...findDuplicateKeys(allWanted),
    ...findDuplicateKeys(allOwned),
  ]);

  for (const item of allItems) {
    if (duplicateKeys.has(item.normalizedKey)) {
      item.status = item.status === "unknown" ? "unknown" : "duplicate";
    }
  }

  return {
    wantedCount: allWanted.length,
    ownedCount: allOwned.length,
    unknownCount: allItems.filter((item) => item.status === "unknown").length,
    duplicateCount: allItems.filter((item) => item.status === "duplicate").length,
  };
}

function findDuplicateKeys(items) {
  const seen = new Set();
  const duplicates = new Set();

  for (const item of items) {
    if (!item.normalizedKey) continue;
    if (seen.has(item.normalizedKey)) {
      duplicates.add(item.normalizedKey);
    } else {
      seen.add(item.normalizedKey);
    }
  }

  return duplicates;
}

function ensureArrayLength(value, length, fallbackValue) {
  const array = Array.isArray(value) ? [...value] : [];
  while (array.length < length) {
    array.push(Array.isArray(fallbackValue) ? [...fallbackValue] : fallbackValue);
  }
  return array.slice(0, length);
}

function toArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null && String(item).trim()) : [];
}

function prepareProfileForSort(profile) {
  return {
    wanted: createPriorityIndex(profile?.wantedGroups),
    owned: createItemSet(profile?.ownedGroups),
  };
}

function scoreListingForProfile(listing, profile) {
  const date = getListingDateValue(listing);

  if (profile.wanted.size === 0) {
    return {
      category: 0,
      wantedPriority: Number.MAX_SAFE_INTEGER,
      wantedMatchCount: 0,
      ownedMatchCount: 0,
      date,
    };
  }

  const listingOwned = createItemSet(listing?.ownedGroups);
  const listingWanted = createItemSet(listing?.wantedGroups);
  const wantedMatch = getWantedMatchScore(profile.wanted, listingOwned);
  const ownedMatchCount = countIntersection(profile.owned, listingWanted);

  if (profile.owned.size === 0) {
    return {
      category: wantedMatch.count > 0 ? (listing?.transferWilling ? 0 : 1) : 2,
      wantedPriority: wantedMatch.priority,
      wantedMatchCount: wantedMatch.count,
      ownedMatchCount,
      date,
    };
  }

  let category = 3;
  if (wantedMatch.count > 0 && ownedMatchCount > 0) {
    category = 0;
  } else if (wantedMatch.count > 0) {
    category = 1;
  } else if (ownedMatchCount > 0) {
    category = 2;
  }

  return {
    category,
    wantedPriority: wantedMatch.priority,
    wantedMatchCount: wantedMatch.count,
    ownedMatchCount,
    date,
  };
}

function compareListingScores(left, right) {
  return (
    left.score.category - right.score.category ||
    left.score.wantedPriority - right.score.wantedPriority ||
    right.score.wantedMatchCount - left.score.wantedMatchCount ||
    right.score.ownedMatchCount - left.score.ownedMatchCount ||
    right.score.date - left.score.date ||
    left.index - right.index
  );
}

function createPriorityIndex(groups) {
  const index = new Map();

  for (const [groupIndex, group] of (groups || []).entries()) {
    for (const item of group?.items || []) {
      const key = getItemKey(item);
      if (key && !index.has(key)) index.set(key, groupIndex);
    }
  }

  return index;
}

function createItemSet(groups) {
  const set = new Set();

  for (const group of groups || []) {
    for (const item of group?.items || []) {
      const key = getItemKey(item);
      if (key) set.add(key);
    }
  }

  return set;
}

function getWantedMatchScore(wantedPriorityIndex, listingOwnedSet) {
  let priority = Number.MAX_SAFE_INTEGER;
  let count = 0;

  for (const key of listingOwnedSet) {
    if (!wantedPriorityIndex.has(key)) continue;
    count += 1;
    priority = Math.min(priority, wantedPriorityIndex.get(key));
  }

  return { priority, count };
}

function countIntersection(left, right) {
  let count = 0;

  for (const value of left) {
    if (right.has(value)) count += 1;
  }

  return count;
}

function getListingDateValue(listing) {
  const time = Date.parse(listing?.updatedAt || listing?.createdAt || "");
  return Number.isNaN(time) ? 0 : time;
}

function getItemKey(item) {
  return item?.normalizedKey || normalizeStickerKey(item?.key || item?.rawKey);
}

function findPersonalListingMatches(listings, formData, options = {}) {
  const knownListingId = String(options.knownListingId ?? "");
  const ownerKey = createListingOwnerKey(formData);

  return (listings || [])
    .map((listing, index) => ({ listing, index }))
    .filter(({ listing }) => {
      if (knownListingId && listing.id === knownListingId) return true;
      if (!ownerKey) return false;
      if (listing.ownerKey === ownerKey) return true;
      return !listing.ownerKey && createListingOwnerKey(listing) === ownerKey;
    })
    .sort((left, right) => {
      if (!knownListingId) return 0;
      if (left.listing.id === knownListingId) return -1;
      if (right.listing.id === knownListingId) return 1;
      return 0;
    });
}

function normalizeOwnerText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function looksLikeJson(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function extractSharePayload(value) {
  if (!value) return "";

  try {
    const url = new URL(value);
    const candidates = ["code", "share", "data", "import"];
    for (const key of candidates) {
      const found = url.searchParams.get(key);
      if (found) return found.trim();
    }

    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const hashParams = new URLSearchParams(hash);
    for (const key of candidates) {
      const found = hashParams.get(key);
      if (found) return found.trim();
    }
  } catch {
    return value;
  }

  return value;
}

function decodeBase64Text(value) {
  try {
    if (typeof atob === "function") {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }

    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `listing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
