import { stickers } from "./catalog-data.js";
import {
  CATALOG_SCHEMA_VERSION,
  LISTING_BODY_MAX_LENGTH,
  canonicalizeListingData,
  collectGroupItemKeys,
  compactGroupsForStorage,
  createCatalogIndex,
} from "./importer.js";

const catalogIndex = createCatalogIndex(stickers);

export function normalizeListingBody(value) {
  return normalizeLimitedString(value, LISTING_BODY_MAX_LENGTH);
}

export function normalizeListingCatalogFields(listing = {}) {
  return canonicalizeListingData(listing, catalogIndex);
}

export function compactListingForStorage(listing = {}) {
  const wantedGroups = compactGroupsForStorage(listing.wantedGroups, catalogIndex, "wanted");
  const ownedGroups = compactGroupsForStorage(listing.ownedGroups, catalogIndex, "owned");
  const images = normalizeStoredImages(listing.images ?? (listing.image ? [listing.image] : []));
  const firstImage = images[0] ?? null;

  return stripUndefinedFields({
    id: normalizeListingId(listing.id),
    ownerUid: String(listing.ownerUid || ""),
    nickname: normalizeLimitedString(listing.nickname, 30),
    contact: normalizeLimitedString(listing.contact, 200),
    body: normalizeListingBody(listing.body),
    transferWilling: Boolean(listing.transferWilling),
    active: listing.active !== false,
    deletedAt: listing.deletedAt || null,
    firstImage,
    imageCount: images.length,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    wantedGroups,
    ownedGroups,
    wantedIds: collectGroupKeys(wantedGroups),
    ownedIds: collectGroupKeys(ownedGroups),
    wantedKeys: collectGroupKeys(wantedGroups),
    ownedKeys: collectGroupKeys(ownedGroups),
    hasControlPin: listing.hasControlPin === true,
    controlSalt: listing.controlSalt ? String(listing.controlSalt) : "",
    pinVersion: listing.pinVersion != null && Number.isFinite(Number(listing.pinVersion)) ? Number(listing.pinVersion) : null,
    createdAt: listing.createdAt || new Date().toISOString(),
    updatedAt: listing.updatedAt || null,
  });
}

export function compactListingDetailForStorage(listing = {}) {
  const images = normalizeStoredImages(listing.images ?? (listing.image ? [listing.image] : []));

  return stripUndefinedFields({
    id: normalizeListingId(listing.id),
    ownerUid: String(listing.ownerUid || ""),
    images,
    storagePaths: collectStoragePaths(images),
    imageCount: images.length,
    updatedAt: listing.updatedAt || null,
  });
}

export function normalizeRemoteListing(id, data) {
  const firstImage = normalizeStoredImageMetadata(data?.firstImage || data?.image, 0);
  const images = Array.isArray(data?.images) && data.images.length > 0
    ? normalizeStoredImages(data.images)
    : firstImage
      ? [firstImage]
      : [];

  return normalizeListingCatalogFields({
    ...data,
    id: data?.id || id,
    active: data?.active !== false,
    images,
    image: images[0] ?? null,
    firstImage: images[0] ?? null,
    imageCount: Number.isFinite(Number(data?.imageCount)) ? Number(data.imageCount) : images.length,
    body: normalizeListingBody(data?.body),
    hasControlPin: data?.hasControlPin === true,
    controlSalt: data?.controlSalt ? String(data.controlSalt) : "",
    pinVersion: data?.pinVersion != null && Number.isFinite(Number(data.pinVersion)) ? Number(data.pinVersion) : null,
    createdAt: normalizeDateValue(data?.createdAt),
    updatedAt: data?.updatedAt ? normalizeDateValue(data.updatedAt) : null,
    deletedAt: data?.deletedAt ? normalizeDateValue(data.deletedAt) : null,
  });
}

export function normalizeRemoteListingDetail(id, data) {
  const images = normalizeStoredImages(Array.isArray(data?.images) ? data.images : []);

  return {
    id: data?.id || id,
    ownerUid: data?.ownerUid || "",
    images,
    image: images[0] ?? null,
    firstImage: images[0] ?? null,
    imageCount: Number.isFinite(Number(data?.imageCount)) ? Number(data.imageCount) : images.length,
    storagePaths: Array.isArray(data?.storagePaths) ? data.storagePaths.filter(Boolean).map(String) : collectStoragePaths(images),
    updatedAt: data?.updatedAt ? normalizeDateValue(data.updatedAt) : null,
  };
}

export function mergeListingDetail(listing, detail) {
  if (!listing) return null;
  if (!detail || !Array.isArray(detail.images) || detail.images.length === 0) return normalizeListingCatalogFields(listing);

  return normalizeListingCatalogFields({
    ...listing,
    images: detail.images,
    image: detail.images[0] ?? listing.image ?? null,
    firstImage: detail.images[0] ?? listing.firstImage ?? null,
    imageCount: Number.isFinite(Number(detail.imageCount)) ? Number(detail.imageCount) : detail.images.length,
  });
}

export function normalizeStoredImages(images = []) {
  return (Array.isArray(images) ? images : [])
    .map((image, index) => normalizeStoredImageMetadata(image, index))
    .filter(Boolean);
}

export function normalizeStoredImageMetadata(image, index = 0) {
  if (!image || typeof image !== "object") return null;
  const url = normalizeLimitedString(image.url, 4096);
  if (!url) return null;

  return stripUndefinedFields({
    name: normalizeLimitedString(image.name || image.originalName || "attachment", 160),
    type: normalizeLimitedString(image.type || image.originalType || "image/png", 120),
    url,
    storagePath: normalizeLimitedString(image.storagePath, 1024),
    generated: Boolean(image.generated),
    profileSignature: normalizeLimitedString(image.profileSignature, 256),
    sheetPageIndex: normalizeNullableInteger(image.sheetPageIndex),
    sheetPageCount: normalizeNullableInteger(image.sheetPageCount),
    size: normalizeNullableInteger(image.size || image.originalSize),
    width: normalizeNullableInteger(image.width),
    height: normalizeNullableInteger(image.height),
    order: normalizeNullableInteger(image.order) ?? index,
  });
}

export function collectGroupKeys(groups) {
  return collectGroupItemKeys(groups);
}

function normalizeLimitedString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeNullableInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function stripUndefinedFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));
}

function normalizeListingId(value) {
  return String(value ?? "").trim();
}

function normalizeDateValue(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

function collectStoragePaths(images = []) {
  return (images || []).flatMap((image) => (image?.storagePath ? [image.storagePath] : []));
}
