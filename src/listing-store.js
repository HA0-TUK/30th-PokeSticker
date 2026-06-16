import { firebaseConfig, firebaseOptions } from "./firebase-config.js";
import {
  CATALOG_SCHEMA_VERSION,
  createListingOwnerKey,
  upsertPersonalListing,
} from "./importer.js";
import {
  collectGroupKeys,
  compactListingDetailForStorage,
  compactListingForStorage,
  mergeListingDetail,
  normalizeListingBody,
  normalizeListingCatalogFields,
  normalizeRemoteListing,
  normalizeRemoteListingDetail,
  normalizeStoredImageMetadata,
} from "./listing-schema.js";

const FIREBASE_SDK_VERSION = "12.7.0";
const LISTINGS_KEY = "pokemon-market-listings";
const LISTINGS_SYNC_KEY = "pokemon-market-listings-sync";
const FIREBASE_UID_KEY = "pokemon-market-firebase-uid";
const LISTING_CONTROL_GRANTS_KEY = "pokemon-market-listing-control-grants";
export const LISTINGS_REFRESH_KEY = "pokemon-market-listings-refresh";
export const LISTINGS_BROADCAST_CHANNEL = "pokemon-market-listings";
const LISTINGS_COLLECTION = "listings";
const LISTING_DETAILS_COLLECTION = "listingDetails";
const DELETED_LISTINGS_COLLECTION = "deletedListings";
const LISTING_SECRETS_COLLECTION = "listingSecrets";
const LISTING_CONTROL_GRANTS_COLLECTION = "listingControlGrants";
const LISTING_CONTROL_GRANT_UIDS_COLLECTION = "uids";
const META_COLLECTION = "meta";
const LISTINGS_META_DOCUMENT = "listings";
const IMAGE_FOLDER = "listing-images";
const SYNC_CACHE_VERSION = 5;
const INCREMENTAL_SYNC_MAX_AGE_DAYS = 25;
export const DEFAULT_LISTINGS_PAGE_SIZE = 10;
export const DEFAULT_LISTING_SORT_CANDIDATE_LIMIT = 200;
const STORAGE_CACHE_CONTROL = "public,max-age=31536000,immutable";
const CONTROL_PIN_HASH_ITERATIONS = 120000;
const CONTROL_PIN_HASH_ALGORITHM = "PBKDF2-SHA256";

let firebaseStatePromise = null;
let firebaseReadStatePromise = null;

export function isFirebaseEnabled() {
  return Boolean(firebaseOptions.enabled && firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

export async function getListingStoreMode() {
  return isFirebaseEnabled() ? "firebase" : "local";
}

export async function loadListings() {
  const firebase = await getFirebaseReadState();

  if (!firebase) return loadLocalListings();

  try {
    const result = await syncListingsCache(firebase, loadLocalListings(), loadLocalSyncState());
    if (result.shouldSave !== false) saveLocalListings(result.listings, result.syncState);
    return result.listings;
  } catch (error) {
    console.warn("Firebase 목록을 불러오지 못해 로컬 캐시를 사용합니다.", error);
    return loadLocalListings();
  }
}

export function loadCachedListings() {
  if (loadLocalSyncState().cacheVersion !== SYNC_CACHE_VERSION) return [];
  return loadLocalListings();
}

export function clearListingCache() {
  try {
    localStorage.removeItem(LISTINGS_KEY);
    localStorage.removeItem(LISTINGS_SYNC_KEY);
  } catch {
    // Blocked storage should not prevent importing a new profile list.
  }
}

export async function loadListingPage(options = {}) {
  const pageSize = Number.isFinite(Number(options.pageSize)) && Number(options.pageSize) > 0
    ? Number(options.pageSize)
    : DEFAULT_LISTINGS_PAGE_SIZE;
  const pageIndex = Number.isFinite(Number(options.pageIndex)) && Number(options.pageIndex) > 0
    ? Math.floor(Number(options.pageIndex))
    : 0;
  const requiredCount = (pageIndex + 1) * pageSize;
  const candidateLimit = Number.isFinite(Number(options.candidateLimit)) && Number(options.candidateLimit) > 0
    ? Math.max(pageSize, Math.floor(Number(options.candidateLimit)))
    : DEFAULT_LISTING_SORT_CANDIDATE_LIMIT;
  const firebase = await getFirebaseReadState();

  if (!firebase) {
    const listings = sortListingsByCreatedAtDesc(loadLocalListings());
    return createListingPageResult(listings, listings.length, "local", pageIndex, pageSize);
  }

  try {
    const cachedListings = loadLocalListings();
    const syncState = loadLocalSyncState();
    const activeCachedListings = sortListingsByCreatedAtDesc(cachedListings);
    let remoteMeta = await loadRemoteListingsMeta(firebase);
    const cacheCountMismatch = hasListingCountMismatch(activeCachedListings, syncState, remoteMeta);
    const requiredCandidateCount = getRequiredListingCandidateCount(remoteMeta, requiredCount, candidateLimit);
    let listings = cacheCountMismatch ? [] : activeCachedListings;
    let source = cacheCountMismatch ? "page" : "cache";
    let exhausted = false;

    if (!remoteMeta) {
      listings = [];
      source = "page";
    }

    if (!cacheCountMismatch && remoteMeta && shouldUseCachedListings(syncState, remoteMeta) && hasEnoughListingsForPage(activeCachedListings, remoteMeta, requiredCandidateCount)) {
      return createListingPageResult(activeCachedListings, remoteMeta.activeCount, source, pageIndex, pageSize);
    }

    if (!cacheCountMismatch && remoteMeta && !shouldUseCachedListings(syncState, remoteMeta) && canLoadIncrementalChanges(syncState) && activeCachedListings.length > 0) {
      const [changedListings, deletedListings] = await Promise.all([
        loadRemoteListingChanges(firebase, syncState.lastSyncAt),
        loadRemoteDeletedListingChanges(firebase, syncState.lastSyncAt),
      ]);
      listings = sortListingsByCreatedAtDesc(mergeListingChanges(activeCachedListings, changedListings, deletedListings));
      saveLocalListings(listings, createListingsSyncState(listings, remoteMeta, syncState));
      source = "incremental";

      if (hasEnoughListingsForPage(listings, remoteMeta, requiredCandidateCount)) {
        return createListingPageResult(listings, remoteMeta.activeCount, source, pageIndex, pageSize);
      }
    } else if (remoteMeta && !shouldUseCachedListings(syncState, remoteMeta) && !canLoadIncrementalChanges(syncState)) {
      listings = [];
      source = "page";
    }

    if (!cacheCountMismatch && remoteMeta && shouldUseCachedListings(syncState, remoteMeta) && !hasEnoughListingsForPage(listings, remoteMeta, requiredCandidateCount)) {
      source = "cache-page";
    }

    while (!hasEnoughListingsForPage(listings, remoteMeta, requiredCandidateCount)) {
      const loadPageSize = Math.max(
        pageSize,
        Math.min(requiredCandidateCount - filterActiveListings(listings).length, candidateLimit),
      );
      const nextListings = await loadRemoteListingPage(firebase, {
        cursor: getListingPageCursor(listings),
        pageSize: loadPageSize,
      });

      if (nextListings.length === 0) {
        exhausted = true;
        break;
      }

      listings = sortListingsByCreatedAtDesc(mergeListingChanges(listings, nextListings));
      source = source === "incremental" ? "incremental-page" : "page";

      if (nextListings.length < loadPageSize) {
        exhausted = true;
        break;
      }
    }

    saveLocalListings(listings, createListingsSyncState(listings, remoteMeta, syncState));
    return createListingPageResult(listings, remoteMeta?.activeCount, source, pageIndex, pageSize, { exhausted });
  } catch (error) {
    console.warn("Firebase 페이지 목록을 불러오지 못해 로컬 캐시를 사용합니다.", error);
    const listings = sortListingsByCreatedAtDesc(loadLocalListings());
    return createListingPageResult(listings, listings.length, "cache-fallback", pageIndex, pageSize);
  }
}

export async function loadPersonalListing() {
  const firebase = await getFirebaseState();
  if (!firebase) return null;

  try {
    const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
    const listingRef = firebase.doc(firebase.db, LISTINGS_COLLECTION, user.uid);
    const snapshot = await firebase.getDoc(listingRef);
    const localListings = loadLocalListings();
    const remaining = localListings.filter((listing) => listing.id !== user.uid && listing.ownerUid !== user.uid);

    if (!snapshot.exists()) {
      saveLocalListings(remaining, loadLocalSyncState());
      return null;
    }

    const summaryListing = normalizeRemoteListing(snapshot.id, snapshot.data());
    const detail = await loadRemoteListingDetail(firebase, user.uid);
    const listing = mergeListingDetail(summaryListing, detail);
    if (listing.active === false) {
      saveLocalListings(remaining, loadLocalSyncState());
      return null;
    }

    saveLocalListings([listing, ...remaining], loadLocalSyncState());
    return listing;
  } catch (error) {
    console.warn("내 교환 글을 불러오지 못했습니다.", error);
    return null;
  }
}

export async function loadListingWithDetails(listingOrId) {
  const listingId = normalizeListingId(typeof listingOrId === "string" ? listingOrId : listingOrId?.id);
  if (!listingId) return typeof listingOrId === "object" && listingOrId ? normalizeListingCatalogFields(listingOrId) : null;

  const firebase = await getFirebaseReadState();
  if (!firebase) {
    const localListing = typeof listingOrId === "object" && listingOrId
      ? listingOrId
      : loadLocalListings().find((listing) => listing.id === listingId);
    return localListing ? normalizeListingCatalogFields(localListing) : null;
  }

  const baseListing = typeof listingOrId === "object" && listingOrId
    ? normalizeListingCatalogFields(listingOrId)
    : await loadRemoteListingById(firebase, listingId);
  if (!baseListing) return null;

  const detail = await loadRemoteListingDetail(firebase, listingId);
  return mergeListingDetail(baseListing, detail);
}

export function isValidControlPin(pin) {
  return /^\d{4}$/.test(String(pin ?? "").trim());
}

export async function ensureListingControl(listingId, pin = "", options = {}) {
  const normalizedListingId = normalizeListingId(listingId);
  if (!normalizedListingId) throw createControlError("missing-listing", "게시글을 찾을 수 없습니다.");

  const firebase = await getFirebaseState();
  if (!firebase) throw createControlError("firebase-disabled", "Firebase 연결이 필요합니다.");

  const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
  let listing = normalizeKnownListingForControl(options.knownListing, normalizedListingId);
  if (listing && listing.ownerUid === user.uid) {
    return { listing, granted: false, owner: true };
  }
  if (listing && hasLocalListingControlGrant(listing, user.uid)) {
    return { listing, granted: true, owner: false, cached: true };
  }

  if (!listing) {
    listing = await loadRemoteListingById(firebase, normalizedListingId);
  }
  if (!listing) throw createControlError("missing-listing", "게시글을 찾을 수 없습니다.");
  if (listing.ownerUid === user.uid) {
    return { listing, granted: false, owner: true };
  }
  if (hasLocalListingControlGrant(listing, user.uid)) {
    return { listing, granted: true, owner: false, cached: true };
  }

  if (!hasUsableControlPinFields(listing) && options.knownListing) {
    listing = await loadRemoteListingById(firebase, normalizedListingId);
    if (!listing) throw createControlError("missing-listing", "寃뚯떆湲??李얠쓣 ???놁뒿?덈떎.");
    if (listing.ownerUid === user.uid) {
      return { listing, granted: false, owner: true };
    }
    if (hasLocalListingControlGrant(listing, user.uid)) {
      return { listing, granted: true, owner: false, cached: true };
    }
  }

  if (!listing.hasControlPin || !listing.controlSalt || !listing.pinVersion) {
    throw createControlError("pin-unavailable", "이 게시글은 아직 관리 PIN이 설정되지 않아 다른 브라우저에서 제어할 수 없습니다.");
  }

  const normalizedPin = normalizeControlPin(pin);
  if (!normalizedPin) throw createControlError("pin-required", "게시글 관리 PIN을 입력하세요.");
  if (!isValidControlPin(normalizedPin)) {
    throw createControlError("pin-format", "게시글 관리 PIN은 숫자 4자리여야 합니다.");
  }

  const pinHash = await hashControlPin(normalizedPin, listing.controlSalt);
  const now = new Date().toISOString();
  const grantRef = firebase.doc(
    firebase.db,
    LISTING_CONTROL_GRANTS_COLLECTION,
    normalizedListingId,
    LISTING_CONTROL_GRANT_UIDS_COLLECTION,
    user.uid,
  );

  try {
    await firebase.setDoc(grantRef, {
      listingId: normalizedListingId,
      uid: user.uid,
      ownerUid: listing.ownerUid || "",
      pinHash,
      pinVersion: Number(listing.pinVersion),
      grantedAt: now,
      updatedAt: now,
    });
  } catch (error) {
    throw createControlError("pin-invalid", "관리 PIN이 일치하지 않습니다.");
  }

  rememberLocalListingControlGrant(listing, user.uid, now);
  return { listing, granted: true, owner: false };
}

function normalizeKnownListingForControl(listing, listingId) {
  if (!listing || listing.id !== listingId) return null;
  return normalizeListingCatalogFields(listing);
}

function hasUsableControlPinFields(listing) {
  return Boolean(listing?.hasControlPin && listing?.controlSalt && listing?.pinVersion);
}

function getLocalControlGrantKey(listingId, uid) {
  return `${listingId}:${uid}`;
}

function loadLocalControlGrants() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LISTING_CONTROL_GRANTS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalControlGrants(grants) {
  try {
    localStorage.setItem(LISTING_CONTROL_GRANTS_KEY, JSON.stringify(grants));
  } catch {
    // A missing local grant only means the user may need to enter the PIN again.
  }
}

function hasLocalListingControlGrant(listing, uid) {
  if (!listing?.id || !uid || !listing.ownerUid || !listing.pinVersion) return false;
  const grant = loadLocalControlGrants()[getLocalControlGrantKey(listing.id, uid)];
  return Boolean(
    grant
      && grant.uid === uid
      && grant.ownerUid === listing.ownerUid
      && Number(grant.pinVersion) === Number(listing.pinVersion),
  );
}

function rememberLocalListingControlGrant(listing, uid, grantedAt) {
  if (!listing?.id || !uid || !listing.ownerUid || !listing.pinVersion) return;
  const grants = loadLocalControlGrants();
  grants[getLocalControlGrantKey(listing.id, uid)] = {
    listingId: listing.id,
    uid,
    ownerUid: listing.ownerUid,
    pinVersion: Number(listing.pinVersion),
    grantedAt,
  };
  saveLocalControlGrants(pruneLocalControlGrants(grants));
}

function pruneLocalControlGrants(grants, limit = 80) {
  const entries = Object.entries(grants || {});
  if (entries.length <= limit) return grants;

  return Object.fromEntries(
    entries
      .sort(([, a], [, b]) => String(b?.grantedAt || "").localeCompare(String(a?.grantedAt || "")))
      .slice(0, limit),
  );
}

function updateLocalListingCache(updatedListing) {
  const localListings = loadLocalListings();
  let found = false;
  const nextListings = localListings.map((listing) => {
    if (listing.id !== updatedListing.id) return listing;
    found = true;
    return updatedListing;
  });

  if (!found) nextListings.unshift(updatedListing);
  saveLocalListings(nextListings, createListingsSyncState(nextListings, null, loadLocalSyncState()));
}

export async function deleteControlledListing(listingId) {
  const normalizedListingId = normalizeListingId(listingId);
  if (!normalizedListingId) throw new Error("삭제할 게시글을 찾을 수 없습니다.");

  const firebase = await getFirebaseState();
  if (!firebase) {
    const remaining = loadLocalListings().filter((listing) => listing.id !== normalizedListingId);
    saveLocalListings(remaining, createListingsSyncState(remaining, null, loadLocalSyncState()));
    announceListingsChanged({ action: "deleted-local", listingId: normalizedListingId });
    return;
  }

  const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
  const listingRef = firebase.doc(firebase.db, LISTINGS_COLLECTION, normalizedListingId);
  const detailRef = firebase.doc(firebase.db, LISTING_DETAILS_COLLECTION, normalizedListingId);
  const deletionRef = firebase.doc(firebase.db, DELETED_LISTINGS_COLLECTION, normalizedListingId);
  const existingSnapshot = await firebase.getDoc(listingRef);
  const existing = existingSnapshot.exists() ? normalizeRemoteListing(existingSnapshot.id, existingSnapshot.data()) : null;
  const existingDetail = existing ? await loadRemoteListingDetail(firebase, normalizedListingId) : null;
  const existingWithDetails = mergeListingDetail(existing, existingDetail);
  const now = new Date().toISOString();

  if (existing && existing.active !== false) {
    const storagePaths = collectDeletionStoragePaths(existingDetail, existingWithDetails);
    const nextRevision = await writeListingDeletionAndMeta(firebase, listingRef, detailRef, deletionRef, {
      listingId: normalizedListingId,
      ownerUid: existing.ownerUid || normalizedListingId,
      deletedByUid: user.uid,
      deletedAt: now,
      updatedAt: now,
      storagePaths,
      storageBytes: sumImageSizes(existingWithDetails.images),
    }, now);
    await refreshRemoteListingsCount(firebase, nextRevision);
  }

  const remaining = loadLocalListings().filter((listing) =>
    listing.id !== normalizedListingId && listing.ownerUid !== normalizedListingId,
  );
  saveLocalListings(remaining, createListingsSyncState(remaining, null, loadLocalSyncState()));
  announceListingsChanged({
    action: "deleted",
    listingId: normalizedListingId,
    updatedAt: now,
  });
}

export async function resolveListingShareTarget(listingId, pageSize = DEFAULT_LISTINGS_PAGE_SIZE) {
  const normalizedListingId = normalizeListingId(listingId);
  if (!normalizedListingId) return null;

  const firebase = await getFirebaseReadState();
  const safePageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Number(pageSize)
    : DEFAULT_LISTINGS_PAGE_SIZE;

  if (!firebase) {
    const listings = sortListingsByCreatedAtDesc(loadLocalListings());
    const index = listings.findIndex((listing) => listing.id === normalizedListingId);
    if (index < 0) return null;

    return {
      listing: listings[index],
      pageIndex: Math.floor(index / safePageSize),
    };
  }

  try {
    const listing = await loadRemoteListingById(firebase, normalizedListingId);
    if (!listing) return null;

    const newerCount = await countRemoteListingsNewerThan(firebase, listing);
    return {
      listing,
      pageIndex: Math.floor(newerCount / safePageSize),
    };
  } catch (error) {
    console.warn("공유 링크 대상 게시글 위치를 찾지 못했습니다.", error);
    return null;
  }
}

export async function syncListingsCache(firebase, cachedListings = [], syncState = {}) {
  const activeCachedListings = filterActiveListings(cachedListings);
  const remoteMeta = await loadRemoteListingsMeta(firebase);
  const cacheCountMismatch = hasListingCountMismatch(activeCachedListings, syncState, remoteMeta);

  if (!cacheCountMismatch && remoteMeta && shouldUseCachedListings(syncState, remoteMeta)) {
    return {
      listings: activeCachedListings,
      syncState,
      shouldSave: false,
      source: "cache",
    };
  }

  if (!cacheCountMismatch && remoteMeta && canLoadIncrementalChanges(syncState)) {
    const [changedListings, deletedListings] = await Promise.all([
      loadRemoteListingChanges(firebase, syncState.lastSyncAt),
      loadRemoteDeletedListingChanges(firebase, syncState.lastSyncAt),
    ]);
    const listings = mergeListingChanges(activeCachedListings, changedListings, deletedListings);

    return {
      listings,
      syncState: createListingsSyncState(listings, remoteMeta, syncState),
      source: "incremental",
    };
  }

  if (!remoteMeta && syncState.cacheVersion === SYNC_CACHE_VERSION && activeCachedListings.length === 0 && syncState.initialized) {
    return {
      listings: activeCachedListings,
      syncState,
      shouldSave: false,
      source: "cache-without-meta",
    };
  }

  const listings = remoteMeta
    ? await loadRemoteListingPage(firebase, {
      pageSize: getRequiredListingCandidateCount(
        remoteMeta,
        DEFAULT_LISTINGS_PAGE_SIZE,
        DEFAULT_LISTING_SORT_CANDIDATE_LIMIT,
      ),
    })
    : await loadAllRemoteListings(firebase);

  return {
    listings,
    syncState: createListingsSyncState(listings, remoteMeta, syncState),
    source: "full",
  };
}

export function shouldUseCachedListings(syncState = {}, remoteMeta = null) {
  return Boolean(
    syncState.initialized
      && syncState.cacheVersion === SYNC_CACHE_VERSION
      && remoteMeta
      && Number(syncState.revision || 0) === Number(remoteMeta.revision || 0)
      && !hasSyncActiveCountMismatch(syncState, remoteMeta),
  );
}

function hasListingCountMismatch(listings = [], syncState = {}, remoteMeta = null) {
  return hasCachedListingOverflow(listings, remoteMeta) || hasSyncActiveCountMismatch(syncState, remoteMeta);
}

function hasCachedListingOverflow(listings = [], remoteMeta = null) {
  const activeCount = getRemoteActiveCount(remoteMeta);
  if (activeCount == null) return false;
  return filterActiveListings(listings).length > activeCount;
}

function hasSyncActiveCountMismatch(syncState = {}, remoteMeta = null) {
  const activeCount = getRemoteActiveCount(remoteMeta);
  if (activeCount == null || !syncState.initialized || syncState.cacheVersion !== SYNC_CACHE_VERSION) return false;

  const syncActiveCount = Number(syncState.activeCount);
  return !Number.isFinite(syncActiveCount) || Math.floor(syncActiveCount) !== activeCount;
}

function getRemoteActiveCount(remoteMeta = null) {
  if (remoteMeta?.activeCount == null || !Number.isFinite(Number(remoteMeta.activeCount))) return null;
  return Math.max(0, Math.floor(Number(remoteMeta.activeCount)));
}

export function mergeListingChanges(cachedListings = [], changedListings = [], deletedListings = []) {
  const byId = new Map();

  for (const listing of cachedListings || []) {
    if (!listing?.id || listing.active === false) continue;
    byId.set(listing.id, listing);
  }

  for (const listing of changedListings || []) {
    if (!listing?.id) continue;
    if (listing.active === false) {
      byId.delete(listing.id);
    } else {
      byId.set(listing.id, listing);
    }
  }

  for (const deletion of deletedListings || []) {
    const listingId = deletion?.listingId || deletion?.id;
    if (!listingId) continue;
    const current = byId.get(listingId);
    if (!current || compareListingFreshness(current, deletion) <= 0) {
      byId.delete(listingId);
    }
  }

  return [...byId.values()].filter((listing) => listing.active !== false);
}

function compareListingFreshness(listing, deletion) {
  const listingTime = Date.parse(normalizeOptionalDateValue(listing?.updatedAt || listing?.createdAt));
  const deletionTime = Date.parse(normalizeOptionalDateValue(deletion?.updatedAt || deletion?.deletedAt));

  if (Number.isNaN(deletionTime)) return 1;
  if (Number.isNaN(listingTime)) return -1;
  if (listingTime === deletionTime) return 0;
  return listingTime > deletionTime ? 1 : -1;
}

function getRequiredListingCandidateCount(remoteMeta = null, requiredCount = DEFAULT_LISTINGS_PAGE_SIZE, candidateLimit = DEFAULT_LISTING_SORT_CANDIDATE_LIMIT) {
  const safeRequiredCount = Number.isFinite(Number(requiredCount)) && Number(requiredCount) > 0
    ? Math.floor(Number(requiredCount))
    : DEFAULT_LISTINGS_PAGE_SIZE;
  const safeCandidateLimit = Number.isFinite(Number(candidateLimit)) && Number(candidateLimit) > 0
    ? Math.max(DEFAULT_LISTINGS_PAGE_SIZE, Math.floor(Number(candidateLimit)))
    : DEFAULT_LISTING_SORT_CANDIDATE_LIMIT;
  const activeCount = remoteMeta?.activeCount != null && Number.isFinite(Number(remoteMeta.activeCount))
    ? Math.max(0, Math.floor(Number(remoteMeta.activeCount)))
    : null;
  const cappedCandidateCount = activeCount == null
    ? safeCandidateLimit
    : Math.min(activeCount, safeCandidateLimit);

  return Math.max(safeRequiredCount, cappedCandidateCount);
}

function createListingPageResult(
  listings = [],
  totalCount = null,
  source = "unknown",
  pageIndex = 0,
  pageSize = DEFAULT_LISTINGS_PAGE_SIZE,
  options = {},
) {
  const activeListings = filterActiveListings(listings);
  const normalizedTotalCount = totalCount != null && Number.isFinite(Number(totalCount))
    ? Math.max(0, Math.floor(Number(totalCount)))
    : activeListings.length;
  const displayTotalCount = normalizedTotalCount;
  const totalPages = Math.max(1, Math.ceil(displayTotalCount / pageSize));
  const safePageIndex = Math.min(Math.max(0, pageIndex), totalPages - 1);
  const startIndex = safePageIndex * pageSize;
  const endIndex = Math.min(startIndex + pageSize, displayTotalCount);
  const pageListings = activeListings.slice(startIndex, endIndex);

  return {
    listings: pageListings,
    candidates: activeListings,
    candidateCount: activeListings.length,
    cachedCount: activeListings.length,
    loadedCount: pageListings.length,
    pageIndex: safePageIndex,
    pageSize,
    startItem: pageListings.length > 0 ? startIndex + 1 : 0,
    endItem: pageListings.length > 0 ? startIndex + pageListings.length : 0,
    totalCount: displayTotalCount,
    totalPages,
    hasNextPage: safePageIndex < totalPages - 1,
    hasPreviousPage: safePageIndex > 0,
    hasMore: activeListings.length < displayTotalCount,
    exhausted: Boolean(options.exhausted),
    source,
  };
}

function hasEnoughListingsForPage(listings = [], remoteMeta = null, requiredCount = DEFAULT_LISTINGS_PAGE_SIZE) {
  const activeListings = filterActiveListings(listings);
  return activeListings.length >= requiredCount;
}

function getListingPageCursor(listings = []) {
  const sortedListings = sortListingsByCreatedAtDesc(listings);
  const lastListing = sortedListings[sortedListings.length - 1];
  return normalizeOptionalDateValue(lastListing?.createdAt);
}

function sortListingsByCreatedAtDesc(listings = []) {
  return [...filterActiveListings(listings)].sort((a, b) => {
    const aTime = Date.parse(normalizeOptionalDateValue(a?.createdAt));
    const bTime = Date.parse(normalizeOptionalDateValue(b?.createdAt));
    if (Number.isNaN(aTime) && Number.isNaN(bTime)) return String(a?.id || "").localeCompare(String(b?.id || ""));
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    if (aTime === bTime) return String(a?.id || "").localeCompare(String(b?.id || ""));
    return bTime - aTime;
  });
}

export function createListingsSyncState(listings = [], remoteMeta = null, previousState = {}) {
  const remoteUpdatedAt = normalizeOptionalDateValue(remoteMeta?.updatedAt);
  const maxListingUpdatedAt = getMaxListingUpdatedAt(listings);
  const previousLastSyncAt = normalizeOptionalDateValue(previousState?.lastSyncAt);

  return {
    cacheVersion: SYNC_CACHE_VERSION,
    initialized: true,
    revision: Number(remoteMeta?.revision ?? previousState?.revision ?? 0),
    activeCount: remoteMeta?.activeCount != null && Number.isFinite(Number(remoteMeta.activeCount))
      ? Number(remoteMeta.activeCount)
      : listings.length,
    lastSyncAt: getMaxIsoDate([previousLastSyncAt, maxListingUpdatedAt, remoteUpdatedAt]),
  };
}

export async function savePersonalListing(draftListing, formData, options = {}) {
  const firebase = await getFirebaseState();

  if (!firebase) {
    const normalizedDraftListing = normalizeListingCatalogFields({
      ...draftListing,
      body: normalizeListingBody(draftListing?.body),
    });
    const result = upsertPersonalListing(loadLocalListings(), normalizedDraftListing, formData, options);
    saveLocalListings(result.listings);
    announceListingsChanged({ action: result.action || "saved", listingId: result.listing?.id || "" });
    return result;
  }

  const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
  const requestedListingId = normalizeListingId(options.knownListingId);
  const listingId = requestedListingId || user.uid;
  const listingRef = firebase.doc(firebase.db, LISTINGS_COLLECTION, listingId);
  const detailRef = firebase.doc(firebase.db, LISTING_DETAILS_COLLECTION, listingId);
  const secretRef = firebase.doc(firebase.db, LISTING_SECRETS_COLLECTION, listingId);
  
  // 최신 상태 확인 필요: 이미지 diff 계산, 중복 저장 방지
  const existingSnapshot = await firebase.getDoc(listingRef);
  const existing = existingSnapshot.exists() ? normalizeRemoteListing(existingSnapshot.id, existingSnapshot.data()) : null;
  const existingDetail = existing ? await loadRemoteListingDetail(firebase, listingId) : null;
  const existingWithDetails = mergeListingDetail(existing, existingDetail);
  const existingIsActive = Boolean(existing && existing.active !== false);
  const now = new Date().toISOString();
  const uploadImages = collectListingUploadImages(draftListing, formData).filter(isUserAttachmentImage);
  const images = await prepareRemoteImages(firebase, user.uid, uploadImages);
  const obsoleteStoragePaths = collectObsoleteStoragePaths((existingWithDetails?.images || []).filter(isUserAttachmentImage), images)
    .filter((storagePath) => isUserStoragePath(storagePath, user.uid));
  const normalizedDraftListing = normalizeListingCatalogFields(draftListing);
  const ownerUid = existing?.ownerUid || user.uid;
  const controlPin = await prepareControlPinFields(formData?.controlPin, existing, ownerUid, now);

  const listing = {
    ...(existingIsActive ? existing : {}),
    ...normalizedDraftListing,
    ...controlPin.listingFields,
    id: listingId,
    ownerUid,
    ownerKey: createListingOwnerKey(formData ?? draftListing),
    body: normalizeListingBody(normalizedDraftListing.body),
    active: true,
    deletedAt: null,
    images,
    image: images[0] ?? null,
    firstImage: images[0] ?? null,
    imageCount: images.length,
    wantedIds: collectGroupKeys(normalizedDraftListing.wantedGroups),
    ownedIds: collectGroupKeys(normalizedDraftListing.ownedGroups),
    wantedKeys: collectGroupKeys(normalizedDraftListing.wantedGroups),
    ownedKeys: collectGroupKeys(normalizedDraftListing.ownedGroups),
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    createdAt: existingIsActive ? existing.createdAt : draftListing.createdAt || now,
    updatedAt: now,
  };
  const secret = controlPin.secret
    ? {
        ...controlPin.secret,
        ownerUid,
      }
    : null;
  const grantRef = secret && user.uid !== ownerUid
    ? firebase.doc(
        firebase.db,
        LISTING_CONTROL_GRANTS_COLLECTION,
        listingId,
        LISTING_CONTROL_GRANT_UIDS_COLLECTION,
        user.uid,
      )
    : null;
  const grant = grantRef
    ? {
        listingId,
        uid: user.uid,
        ownerUid,
        pinHash: secret.pinHash,
        pinVersion: Number(secret.pinVersion),
        grantedAt: now,
        updatedAt: now,
      }
    : null;
  const nextRevision = await writeListingAndMeta(firebase, listingRef, compactListingForStorage(listing), now, {
    detailRef,
    detail: compactListingDetailForStorage(listing),
    secretRef,
    secret,
    grantRef,
    grant,
  });
  await refreshRemoteListingsCount(firebase, nextRevision);
  await deleteStoragePaths(firebase, obsoleteStoragePaths);

  const localResult = upsertPersonalListing(loadLocalListings(), listing, formData ?? listing, {
    knownListingId: listingId,
  });
  if (user.uid !== ownerUid && hasUsableControlPinFields(listing)) {
    rememberLocalListingControlGrant(listing, user.uid, now);
  }
  const localListings = [listing, ...localResult.listings.filter((localListing) => localListing.id !== listing.id)];
  saveLocalListings(localListings, createListingsSyncState(localListings, null, loadLocalSyncState()));
  announceListingsChanged({
    action: existingIsActive ? "updated" : "created",
    listingId: listing.id,
    updatedAt: now,
  });

  return {
    action: existingIsActive ? "updated" : "created",
    listing,
    listings: localListings,
  };
}

function collectListingUploadImages(draftListing = {}, formData = {}) {
  const draftImages = getListingImageList(draftListing);
  const formImages = getListingImageList(formData);
  return mergeListingImageLists(formImages, draftImages);
}

function getListingImageList(source = {}) {
  if (Array.isArray(source?.images)) return source.images.filter(Boolean);
  return source?.image ? [source.image] : [];
}

function mergeListingImageLists(...imageLists) {
  const seen = new Set();
  const merged = [];

  for (const image of imageLists.flat()) {
    if (!image) continue;
    const key = getListingImageIdentity(image);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(image);
  }

  return merged;
}

function getListingImageIdentity(image) {
  return [
    image.storagePath || "",
    image.url || "",
    image.dataUrl || "",
    image.name || image.originalName || "",
    image.size || image.originalSize || "",
    image.width || "",
    image.height || "",
  ].join("|");
}

export async function deletePersonalListing() {
  const firebase = await getFirebaseState();

  if (!firebase) {
    localStorage.removeItem(LISTINGS_KEY);
    localStorage.removeItem(LISTINGS_SYNC_KEY);
    announceListingsChanged({ action: "deleted-local" });
    return;
  }

  const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
  const listingRef = firebase.doc(firebase.db, LISTINGS_COLLECTION, user.uid);
  const detailRef = firebase.doc(firebase.db, LISTING_DETAILS_COLLECTION, user.uid);
  const deletionRef = firebase.doc(firebase.db, DELETED_LISTINGS_COLLECTION, user.uid);
  const existingSnapshot = await firebase.getDoc(listingRef);
  const existing = existingSnapshot.exists() ? normalizeRemoteListing(existingSnapshot.id, existingSnapshot.data()) : null;
  const existingDetail = existing ? await loadRemoteListingDetail(firebase, user.uid) : null;
  const existingWithDetails = mergeListingDetail(existing, existingDetail);
  const now = new Date().toISOString();

  if (existing && existing.active !== false) {
    const storagePaths = collectDeletionStoragePaths(existingDetail, existingWithDetails);
    const nextRevision = await writeListingDeletionAndMeta(firebase, listingRef, detailRef, deletionRef, {
      listingId: user.uid,
      ownerUid: user.uid,
      deletedAt: now,
      updatedAt: now,
      storagePaths,
      storageBytes: sumImageSizes(existingWithDetails.images),
    }, now);
    await refreshRemoteListingsCount(firebase, nextRevision);
  }

  const remaining = loadLocalListings().filter((listing) => listing.id !== user.uid && listing.ownerUid !== user.uid);
  saveLocalListings(remaining, createListingsSyncState(remaining, null, loadLocalSyncState()));
  announceListingsChanged({
    action: "deleted",
    listingId: user.uid,
    updatedAt: now,
  });
}

async function prepareControlPinFields(pin, existing, ownerUid, now) {
  const normalizedPin = normalizeControlPin(pin);
  if (normalizedPin && !isValidControlPin(normalizedPin)) {
    throw new Error("게시글 관리 PIN은 숫자 4자리여야 합니다.");
  }

  if (!normalizedPin && existing?.hasControlPin && existing?.controlSalt && existing?.pinVersion) {
    return {
      listingFields: {
        hasControlPin: true,
        controlSalt: existing.controlSalt,
        pinVersion: Number(existing.pinVersion),
      },
      secret: null,
    };
  }

  if (!normalizedPin) {
    throw new Error("게시글 관리를 위해 숫자 4자리 PIN을 입력하세요.");
  }

  const controlSalt = createControlSalt();
  const pinVersion = createPinVersion();
  const pinHash = await hashControlPin(normalizedPin, controlSalt);

  return {
    listingFields: {
      hasControlPin: true,
      controlSalt,
      pinVersion,
    },
    secret: {
      ownerUid,
      pinHash,
      pinVersion,
      algorithm: CONTROL_PIN_HASH_ALGORITHM,
      iterations: CONTROL_PIN_HASH_ITERATIONS,
      ...(existing?.hasControlPin ? {} : { createdAt: now }),
      updatedAt: now,
    },
  };
}

function normalizeControlPin(pin) {
  return String(pin ?? "").trim();
}

function createPinVersion() {
  return Date.now();
}

function createControlSalt() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function hashControlPin(pin, salt) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("이 브라우저에서는 게시글 관리 PIN을 사용할 수 없습니다.");
  }

  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(String(pin)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(String(salt)),
      iterations: CONTROL_PIN_HASH_ITERATIONS,
    },
    key,
    256,
  );
  return `${CONTROL_PIN_HASH_ALGORITHM}:${CONTROL_PIN_HASH_ITERATIONS}:${salt}:${bytesToBase64Url(new Uint8Array(bits))}`;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createControlError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function announceListingsChanged(detail = {}) {
  const payload = {
    type: "listings-changed",
    action: detail.action || "changed",
    listingId: detail.listingId || "",
    updatedAt: detail.updatedAt || new Date().toISOString(),
  };

  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LISTINGS_REFRESH_KEY, JSON.stringify(payload));
    }
  } catch {
    // A private browsing mode or blocked storage should not break listing writes.
  }

  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(LISTINGS_BROADCAST_CHANNEL);
      channel.postMessage(payload);
      channel.close();
    } catch {
      // Older browsers can rely on storage/focus refresh paths.
    }
  }

  try {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent(LISTINGS_REFRESH_KEY, { detail: payload }));
    }
  } catch {
    // Ignore local notification failures after the write has already succeeded.
  }
}

async function getFirebaseState() {
  if (!isFirebaseEnabled()) return null;
  firebaseStatePromise ??= initializeFirebaseState();

  try {
    return await firebaseStatePromise;
  } catch (error) {
    console.warn("Firebase 초기화에 실패해 로컬 저장소로 동작합니다.", error);
    firebaseStatePromise = null;
    return null;
  }
}

async function getFirebaseReadState() {
  if (!isFirebaseEnabled()) return null;
  firebaseReadStatePromise ??= initializeFirebaseReadState();

  try {
    return await firebaseReadStatePromise;
  } catch (error) {
    console.warn("Firebase 읽기 초기화에 실패해 로컬 저장소로 동작합니다.", error);
    firebaseReadStatePromise = null;
    return null;
  }
}

async function initializeFirebaseReadState() {
  const [appModule, firestoreModule] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore-lite.js`),
  ]);

  const app = getFirebaseApp(appModule);

  return {
    db: firestoreModule.getFirestore(app),
    collection: firestoreModule.collection,
    doc: firestoreModule.doc,
    getCountFromServer: firestoreModule.getCountFromServer,
    getDoc: firestoreModule.getDoc,
    getDocs: firestoreModule.getDocs,
    limit: firestoreModule.limit,
    orderBy: firestoreModule.orderBy,
    query: firestoreModule.query,
    startAfter: firestoreModule.startAfter,
    where: firestoreModule.where,
  };
}

async function initializeFirebaseState() {
  const [
    appModule,
    authModule,
    firestoreModule,
    storageModule,
  ] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore-lite.js`),
    import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-storage.js`),
  ]);

  const app = getFirebaseApp(appModule);
  const auth = authModule.getAuth(app);
  const db = firestoreModule.getFirestore(app);
  const storage = storageModule.getStorage(app);

  if (!auth.currentUser) {
    await authModule.signInAnonymously(auth);
  }

  // UID를 로컬 스토리지에 저장하여 세션 간 일관성 유지
  const currentUser = auth.currentUser;
  if (currentUser) {
    const savedUid = localStorage.getItem(FIREBASE_UID_KEY);
    if (!savedUid) {
      localStorage.setItem(FIREBASE_UID_KEY, currentUser.uid);
      console.log("Firebase UID 저장됨:", currentUser.uid);
    } else if (savedUid !== currentUser.uid) {
      console.warn("저장된 UID와 현재 UID가 다릅니다. 저장된 UID를 우선 사용해야 합니다.");
      console.warn("저장된 UID:", savedUid, "현재 UID:", currentUser.uid);
    }
  }

  return {
    auth,
    db,
    storage,
    collection: firestoreModule.collection,
    deleteDoc: firestoreModule.deleteDoc,
    doc: firestoreModule.doc,
    increment: firestoreModule.increment,
    getDoc: firestoreModule.getDoc,
    getDocs: firestoreModule.getDocs,
    getCountFromServer: firestoreModule.getCountFromServer,
    query: firestoreModule.query,
    runTransaction: firestoreModule.runTransaction,
    setDoc: firestoreModule.setDoc,
    signInAnonymously: authModule.signInAnonymously,
    deleteObject: storageModule.deleteObject,
    getDownloadURL: storageModule.getDownloadURL,
    ref: storageModule.ref,
    uploadString: storageModule.uploadString,
    where: firestoreModule.where,
    writeBatch: firestoreModule.writeBatch,
  };
}

function getFirebaseApp(appModule) {
  return appModule.getApps().length ? appModule.getApp() : appModule.initializeApp(firebaseConfig);
}

async function prepareRemoteImages(firebase, ownerUid, images) {
  const uploadBatchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prepared = await Promise.all(
    (images || []).filter(Boolean).map((image, index) => prepareRemoteImage(firebase, ownerUid, image, index, uploadBatchId)),
  );

  return prepared.filter(Boolean);
}

async function prepareRemoteImage(firebase, ownerUid, image, index = 0, uploadBatchId = "default") {
  if (!image) return null;
  if (image.generated) return null;
  if (image.url) return createStoredImageMetadata(image, index);
  if (!image.dataUrl) return null;

  const imageRef = firebase.ref(
    firebase.storage,
    `${IMAGE_FOLDER}/${ownerUid}/${uploadBatchId}/${String(index).padStart(2, "0")}-${sanitizeImageName(image.name || "attachment")}`,
  );
  await firebase.uploadString(imageRef, image.dataUrl, "data_url", {
    contentType: image.type || "image/png",
    cacheControl: STORAGE_CACHE_CONTROL,
  });

  return {
    name: image.name || "attachment",
    type: image.type || "image/png",
    url: await firebase.getDownloadURL(imageRef),
    storagePath: imageRef.fullPath,
    generated: Boolean(image.generated),
    compressed: Boolean(image.compressed),
    resolutionReduced: Boolean(image.resolutionReduced),
    profileSignature: image.profileSignature || "",
    sheetPageIndex: Number.isFinite(Number(image.sheetPageIndex)) ? Number(image.sheetPageIndex) : null,
    sheetPageCount: Number.isFinite(Number(image.sheetPageCount)) ? Number(image.sheetPageCount) : null,
    size: image.size || null,
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
    order: index,
  };
}

function createStoredImageMetadata(image, index = 0) {
  if (image?.generated) return null;
  return normalizeStoredImageMetadata({
    name: image.name || image.originalName || "attachment",
    type: image.type || image.originalType || "image/png",
    url: image.url,
    storagePath: image.storagePath || "",
    generated: Boolean(image.generated),
    compressed: Boolean(image.compressed),
    resolutionReduced: Boolean(image.resolutionReduced),
    profileSignature: image.profileSignature || "",
    sheetPageIndex: Number.isFinite(Number(image.sheetPageIndex)) ? Number(image.sheetPageIndex) : null,
    sheetPageCount: Number.isFinite(Number(image.sheetPageCount)) ? Number(image.sheetPageCount) : null,
    size: image.size || image.originalSize || null,
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
    order: Number.isFinite(Number(image.order)) ? Number(image.order) : index,
  }, index);
}

function isUserAttachmentImage(image) {
  return Boolean(image && !image.generated);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob(resolve, type, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("썸네일을 저장 형식으로 변환하지 못했습니다.")));
    reader.readAsDataURL(blob);
  });
}

function removeFileExtension(name) {
  return String(name ?? "").replace(/\.[^.]+$/, "");
}

function sanitizeImageName(name) {
  return String(name)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
}

function collectObsoleteStoragePaths(existingImages = [], nextImages = []) {
  const nextPaths = new Set((nextImages || []).flatMap(collectImageStoragePaths));

  return (existingImages || [])
    .flatMap(collectImageStoragePaths)
    .filter((storagePath) => !nextPaths.has(storagePath));
}

function collectStoragePaths(images = []) {
  return (images || []).flatMap(collectImageStoragePaths);
}

function collectDeletionStoragePaths(detail, listing) {
  const paths = Array.isArray(detail?.storagePaths) && detail.storagePaths.length > 0
    ? detail.storagePaths
    : collectStoragePaths(listing?.images || []);

  return [...new Set(paths.filter(Boolean).map(String))];
}

function sumImageSizes(images = []) {
  return (images || []).reduce((sum, image) => {
    const size = Number(image?.size || image?.originalSize || 0);
    return Number.isFinite(size) && size > 0 ? sum + size : sum;
  }, 0);
}

function collectImageStoragePaths(image) {
  const paths = [];
  // storagePath가 있으면 추가
  if (image?.storagePath) {
    paths.push(image.storagePath);
  }
  return paths;
}

function isUserStoragePath(storagePath, uid) {
  return String(storagePath || "").startsWith(`${IMAGE_FOLDER}/${uid}/`);
}

async function deleteStoragePaths(firebase, storagePaths) {
  const results = await Promise.allSettled((storagePaths || []).map(async (storagePath) => {
    try {
      await firebase.deleteObject(firebase.ref(firebase.storage, storagePath));
      console.log(`Storage 파일 삭제 완료: ${storagePath}`);
      return { success: true, path: storagePath };
    } catch (error) {
      console.warn(`Storage 파일 삭제 실패: ${storagePath}`, error.code, error.message);
      return { success: false, path: storagePath, error: error.message };
    }
  }));

  // 삭제 결과 요약 로깅
  const successCount = results.filter(r => r.status === 'fulfilled' && r.value?.success).length;
  const failureCount = results.filter(r => r.status === 'fulfilled' && !r.value?.success).length;
  
  if (failureCount > 0) {
    console.warn(`Storage 파일 삭제: ${successCount}개 성공, ${failureCount}개 실패`);
    const failed = results
      .filter(r => r.status === 'fulfilled' && !r.value?.success)
      .map(r => r.value.path);
    console.warn("삭제 실패 파일:", failed);
  }
}

async function loadRemoteListingsMeta(firebase) {
  const snapshot = await firebase.getDoc(firebase.doc(firebase.db, META_COLLECTION, LISTINGS_META_DOCUMENT));
  return snapshot.exists() ? normalizeRemoteListingsMeta(snapshot.data()) : null;
}

async function loadRemoteListingById(firebase, listingId) {
  const normalizedListingId = normalizeListingId(listingId);
  if (!normalizedListingId) return null;

  const snapshot = await firebase.getDoc(firebase.doc(firebase.db, LISTINGS_COLLECTION, normalizedListingId));
  if (!snapshot.exists()) return null;

  const listing = normalizeRemoteListing(snapshot.id, snapshot.data());
  return listing.active === false ? null : listing;
}

async function loadRemoteListingDetail(firebase, listingId) {
  const normalizedListingId = normalizeListingId(listingId);
  if (!normalizedListingId) return null;

  const snapshot = await firebase.getDoc(firebase.doc(firebase.db, LISTING_DETAILS_COLLECTION, normalizedListingId));
  return snapshot.exists() ? normalizeRemoteListingDetail(snapshot.id, snapshot.data()) : null;
}

async function loadAllRemoteListings(firebase) {
  const snapshot = await firebase.getDocs(firebase.collection(firebase.db, LISTINGS_COLLECTION));
  return snapshot.docs
    .map((document) => normalizeRemoteListing(document.id, document.data()))
    .filter((listing) => listing.active !== false);
}

async function loadRemoteListingChanges(firebase, lastSyncAt) {
  const snapshot = await firebase.getDocs(
    firebase.query(
      firebase.collection(firebase.db, LISTINGS_COLLECTION),
      firebase.where("updatedAt", ">=", lastSyncAt),
    ),
  );

  return snapshot.docs.map((document) => normalizeRemoteListing(document.id, document.data()));
}

async function loadRemoteListingPage(firebase, options = {}) {
  const clauses = [
    firebase.orderBy("createdAt", "desc"),
  ];

  if (options.cursor) clauses.push(firebase.startAfter(options.cursor));
  clauses.push(firebase.limit(options.pageSize || DEFAULT_LISTINGS_PAGE_SIZE));

  const snapshot = await firebase.getDocs(
    firebase.query(
      firebase.collection(firebase.db, LISTINGS_COLLECTION),
      ...clauses,
    ),
  );

  return snapshot.docs
    .map((document) => normalizeRemoteListing(document.id, document.data()))
    .filter((listing) => listing.active !== false);
}

async function countRemoteListingsNewerThan(firebase, listing) {
  const createdAt = normalizeOptionalDateValue(listing?.createdAt);
  if (!createdAt) return 0;

  if (firebase.getCountFromServer) {
    const snapshot = await firebase.getCountFromServer(
      firebase.query(
        firebase.collection(firebase.db, LISTINGS_COLLECTION),
        firebase.where("createdAt", ">", createdAt),
      ),
    );
    const count = Number(snapshot.data()?.count ?? 0);
    return Number.isFinite(count) ? count : 0;
  }

  const listings = sortListingsByCreatedAtDesc(loadLocalListings());
  const index = listings.findIndex((candidate) => candidate.id === listing.id);
  return index >= 0 ? index : 0;
}

async function loadRemoteDeletedListingChanges(firebase, lastSyncAt) {
  const snapshot = await firebase.getDocs(
    firebase.query(
      firebase.collection(firebase.db, DELETED_LISTINGS_COLLECTION),
      firebase.where("updatedAt", ">=", lastSyncAt),
    ),
  );

  return snapshot.docs.map((document) => normalizeRemoteDeletedListing(document.id, document.data()));
}

async function loadRemoteListingsCount(firebase) {
  if (firebase.getCountFromServer) {
    const snapshot = await firebase.getCountFromServer(
      firebase.query(
        firebase.collection(firebase.db, LISTINGS_COLLECTION),
        firebase.where("active", "==", true),
      ),
    );
    const count = Number(snapshot.data()?.count ?? 0);
    return Number.isFinite(count) ? count : 0;
  }

  const remoteMeta = await loadRemoteListingsMeta(firebase);
  if (remoteMeta?.activeCount != null && Number.isFinite(Number(remoteMeta.activeCount))) {
    return Number(remoteMeta.activeCount);
  }

  return null;
}

async function refreshRemoteListingsCount(firebase, expectedRevision = null) {
  try {
    const activeCount = await loadRemoteListingsCount(firebase);
    if (activeCount == null) return false;
    const metaRef = firebase.doc(firebase.db, META_COLLECTION, LISTINGS_META_DOCUMENT);
    const countedAt = new Date().toISOString();
    const normalizedExpectedRevision = Number(expectedRevision);

    if (firebase.runTransaction && Number.isFinite(normalizedExpectedRevision)) {
      return firebase.runTransaction(firebase.db, async (transaction) => {
        const metaSnapshot = await transaction.get(metaRef);
        const remoteRevision = normalizeRevision(metaSnapshot.exists() ? metaSnapshot.data()?.revision : 0);

        if (remoteRevision !== normalizedExpectedRevision) return false;

        transaction.set(metaRef, {
          activeCount,
          countedAt,
        }, { merge: true });
        return true;
      });
    }

    await firebase.setDoc(metaRef, {
      activeCount,
      countedAt,
    }, { merge: true });
    return true;
  } catch (error) {
    console.warn("Firebase activeCount를 count() 결과로 갱신하지 못했습니다.", error);
    return false;
  }
}

async function writeListingAndMeta(firebase, listingRef, listing, updatedAt, options = {}) {
  const metaRef = firebase.doc(firebase.db, META_COLLECTION, LISTINGS_META_DOCUMENT);
  const {
    detailRef = null,
    detail = null,
    secretRef = null,
    secret = null,
    grantRef = null,
    grant = null,
  } = options;

  if (firebase.runTransaction) {
    return firebase.runTransaction(firebase.db, async (transaction) => {
      const metaSnapshot = await transaction.get(metaRef);
      const nextRevision = getNextRevision(metaSnapshot);

      transaction.set(listingRef, listing);
      if (detailRef && detail) transaction.set(detailRef, detail);
      if (secretRef && secret) transaction.set(secretRef, secret, { merge: true });
      if (grantRef && grant) transaction.set(grantRef, grant, { merge: true });
      transaction.set(metaRef, {
        revision: nextRevision,
        updatedAt,
      }, { merge: true });

      return nextRevision;
    });
  }

  const metaPatch = {
    revision: firebase.increment(1),
    updatedAt,
  };

  if (firebase.writeBatch) {
    const batch = firebase.writeBatch(firebase.db);
    batch.set(listingRef, listing);
    if (detailRef && detail) batch.set(detailRef, detail);
    if (secretRef && secret) batch.set(secretRef, secret, { merge: true });
    if (grantRef && grant) batch.set(grantRef, grant, { merge: true });
    batch.set(metaRef, metaPatch, { merge: true });
    await batch.commit();
    return null;
  }

  await firebase.setDoc(listingRef, listing);
  if (detailRef && detail) await firebase.setDoc(detailRef, detail);
  if (secretRef && secret) await firebase.setDoc(secretRef, secret, { merge: true });
  if (grantRef && grant) await firebase.setDoc(grantRef, grant, { merge: true });
  await firebase.setDoc(metaRef, metaPatch, { merge: true });
  return null;
}

async function writeListingDeletionAndMeta(firebase, listingRef, detailRef, deletionRef, deletion, updatedAt) {
  const metaRef = firebase.doc(firebase.db, META_COLLECTION, LISTINGS_META_DOCUMENT);

  if (firebase.runTransaction) {
    return firebase.runTransaction(firebase.db, async (transaction) => {
      const metaSnapshot = await transaction.get(metaRef);
      const nextRevision = getNextRevision(metaSnapshot);

      transaction.delete(listingRef);
      if (detailRef) transaction.delete(detailRef);
      transaction.set(deletionRef, deletion, { merge: true });
      transaction.set(metaRef, {
        revision: nextRevision,
        updatedAt,
      }, { merge: true });

      return nextRevision;
    });
  }

  if (firebase.writeBatch) {
    const metaPatch = {
      revision: firebase.increment(1),
      updatedAt,
    };
    const batch = firebase.writeBatch(firebase.db);
    batch.delete(listingRef);
    if (detailRef) batch.delete(detailRef);
    batch.set(deletionRef, deletion, { merge: true });
    batch.set(metaRef, metaPatch, { merge: true });
    await batch.commit();
    return null;
  }

  await firebase.deleteDoc(listingRef);
  if (detailRef) await firebase.deleteDoc(detailRef);
  await firebase.setDoc(deletionRef, deletion, { merge: true });
  await firebase.setDoc(metaRef, {
    revision: firebase.increment(1),
    updatedAt,
  }, { merge: true });
  return null;
}

function getNextRevision(metaSnapshot) {
  const currentRevision = normalizeRevision(metaSnapshot.exists() ? metaSnapshot.data()?.revision : 0);
  return currentRevision + 1;
}

function normalizeRevision(value) {
  const revision = Number(value || 0);
  if (!Number.isFinite(revision) || revision < 0) return 0;
  return Math.floor(revision);
}

function normalizeRemoteDeletedListing(id, data) {
  return {
    id,
    listingId: data?.listingId || id,
    ownerUid: data?.ownerUid || "",
    deletedAt: normalizeOptionalDateValue(data?.deletedAt),
    updatedAt: normalizeOptionalDateValue(data?.updatedAt || data?.deletedAt),
  };
}

function normalizeRemoteListingsMeta(data) {
  return {
    revision: Number(data?.revision || 0),
    updatedAt: normalizeOptionalDateValue(data?.updatedAt),
    activeCount: data?.activeCount != null && Number.isFinite(Number(data.activeCount)) ? Number(data.activeCount) : null,
  };
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

function normalizeOptionalDateValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

function loadLocalListings() {
  try {
    const listings = JSON.parse(localStorage.getItem(LISTINGS_KEY) || "[]");
    return filterActiveListings((Array.isArray(listings) ? listings : []).map(normalizeListingCatalogFields));
  } catch {
    return [];
  }
}

function loadLocalSyncState() {
  try {
    const state = JSON.parse(localStorage.getItem(LISTINGS_SYNC_KEY) || "{}");
    return {
      cacheVersion: Number(state.cacheVersion || 0),
      initialized: Boolean(state.initialized),
      revision: Number(state.revision || 0),
      activeCount: state.activeCount != null && Number.isFinite(Number(state.activeCount)) ? Number(state.activeCount) : null,
      lastSyncAt: normalizeOptionalDateValue(state.lastSyncAt),
    };
  } catch {
    return {
      cacheVersion: 0,
      initialized: false,
      revision: 0,
      activeCount: null,
      lastSyncAt: "",
    };
  }
}

function saveLocalListings(listings, syncState = null) {
  localStorage.setItem(LISTINGS_KEY, JSON.stringify(filterActiveListings((listings || []).map(normalizeListingCatalogFields))));
  if (syncState) localStorage.setItem(LISTINGS_SYNC_KEY, JSON.stringify(syncState));
}

function filterActiveListings(listings = []) {
  return (Array.isArray(listings) ? listings : []).filter((listing) => listing?.active !== false);
}

function canLoadIncrementalChanges(syncState = {}) {
  if (!syncState.initialized || syncState.cacheVersion !== SYNC_CACHE_VERSION || !syncState.lastSyncAt) return false;

  const lastSyncTime = Date.parse(syncState.lastSyncAt);
  if (Number.isNaN(lastSyncTime)) return false;

  return Date.now() - lastSyncTime <= INCREMENTAL_SYNC_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function getMaxListingUpdatedAt(listings = []) {
  return getMaxIsoDate((listings || []).map((listing) => listing?.updatedAt || listing?.createdAt || ""));
}

function getMaxIsoDate(values = []) {
  let maxValue = "";
  let maxTime = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const normalized = normalizeOptionalDateValue(value);
    if (!normalized) continue;
    const time = Date.parse(normalized);
    if (Number.isNaN(time) || time < maxTime) continue;
    maxTime = time;
    maxValue = normalized;
  }

  return maxValue;
}
