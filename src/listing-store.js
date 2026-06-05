import { firebaseConfig, firebaseOptions } from "./firebase-config.js";
import { createListingOwnerKey, upsertPersonalListing } from "./importer.js";

const FIREBASE_SDK_VERSION = "12.7.0";
const LISTINGS_KEY = "pokemon-market-listings";
const LISTINGS_SYNC_KEY = "pokemon-market-listings-sync";
const LISTINGS_COLLECTION = "listings";
const META_COLLECTION = "meta";
const LISTINGS_META_DOCUMENT = "listings";
const IMAGE_FOLDER = "listing-images";
const SYNC_CACHE_VERSION = 3;
const STORAGE_CACHE_CONTROL = "public,max-age=31536000,immutable";

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

export async function syncListingsCache(firebase, cachedListings = [], syncState = {}) {
  const activeCachedListings = filterActiveListings(cachedListings);
  const remoteMeta = await loadRemoteListingsMeta(firebase);

  if (remoteMeta && shouldUseCachedListings(syncState, remoteMeta)) {
    return {
      listings: activeCachedListings,
      syncState,
      shouldSave: false,
      source: "cache",
    };
  }

  if (remoteMeta && canLoadIncrementalChanges(syncState)) {
    const changedListings = await loadRemoteListingChanges(firebase, syncState.lastSyncAt);
    const listings = mergeListingChanges(activeCachedListings, changedListings);

    return {
      listings,
      syncState: createListingsSyncState(listings, remoteMeta, syncState),
      source: "incremental",
    };
  }

  if (!remoteMeta && syncState.cacheVersion === SYNC_CACHE_VERSION && (activeCachedListings.length > 0 || syncState.initialized)) {
    return {
      listings: activeCachedListings,
      syncState,
      shouldSave: false,
      source: "cache-without-meta",
    };
  }

  const listings = await loadAllRemoteListings(firebase);

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
      && Number(syncState.revision || 0) === Number(remoteMeta.revision || 0),
  );
}

export function mergeListingChanges(cachedListings = [], changedListings = []) {
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

  return [...byId.values()].filter((listing) => listing.active !== false);
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
    const result = upsertPersonalListing(loadLocalListings(), draftListing, formData, options);
    saveLocalListings(result.listings);
    return result;
  }

  const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
  const listingRef = firebase.doc(firebase.db, LISTINGS_COLLECTION, user.uid);
  const existingSnapshot = await firebase.getDoc(listingRef);
  const existing = existingSnapshot.exists() ? normalizeRemoteListing(existingSnapshot.id, existingSnapshot.data()) : null;
  const existingIsActive = Boolean(existing && existing.active !== false);
  const now = new Date().toISOString();
  const images = await prepareRemoteImages(firebase, user.uid, draftListing.images ?? (draftListing.image ? [draftListing.image] : []));
  const obsoleteStoragePaths = collectObsoleteStoragePaths(existing?.images, images);

  const listing = {
    ...(existingIsActive ? existing : {}),
    ...draftListing,
    id: user.uid,
    ownerUid: user.uid,
    ownerKey: createListingOwnerKey(formData ?? draftListing),
    active: true,
    deletedAt: null,
    images,
    image: images[0] ?? null,
    wantedKeys: collectGroupKeys(draftListing.wantedGroups),
    ownedKeys: collectGroupKeys(draftListing.ownedGroups),
    createdAt: existingIsActive ? existing.createdAt : draftListing.createdAt || now,
    updatedAt: now,
  };
  const activeCountDelta = existingIsActive ? 0 : 1;

  await writeListingAndMeta(firebase, listingRef, listing, activeCountDelta, now);
  await deleteStoragePaths(firebase, obsoleteStoragePaths);

  const localResult = upsertPersonalListing(loadLocalListings(), listing, formData ?? listing, {
    knownListingId: user.uid,
  });
  const localListings = [listing, ...localResult.listings.filter((localListing) => localListing.id !== listing.id)];
  saveLocalListings(localListings, createListingsSyncState(localListings, null, loadLocalSyncState()));

  return {
    action: existingIsActive ? "updated" : "created",
    listing,
    listings: localListings,
  };
}

export async function deletePersonalListing() {
  const firebase = await getFirebaseState();

  if (!firebase) {
    localStorage.removeItem(LISTINGS_KEY);
    localStorage.removeItem(LISTINGS_SYNC_KEY);
    return;
  }

  const user = firebase.auth.currentUser || (await firebase.signInAnonymously(firebase.auth)).user;
  const listingRef = firebase.doc(firebase.db, LISTINGS_COLLECTION, user.uid);
  const existingSnapshot = await firebase.getDoc(listingRef);
  const existing = existingSnapshot.exists() ? normalizeRemoteListing(existingSnapshot.id, existingSnapshot.data()) : null;
  const now = new Date().toISOString();

  if (existing && existing.active !== false) {
    await writeListingAndMeta(firebase, listingRef, {
      ...existing,
      active: false,
      deletedAt: now,
      updatedAt: now,
    }, -1, now);
    await deleteStoragePaths(firebase, collectStoragePaths(existing.images));
  }

  const remaining = loadLocalListings().filter((listing) => listing.id !== user.uid && listing.ownerUid !== user.uid);
  saveLocalListings(remaining, createListingsSyncState(remaining, null, loadLocalSyncState()));
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
    getDoc: firestoreModule.getDoc,
    getDocs: firestoreModule.getDocs,
    query: firestoreModule.query,
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
    query: firestoreModule.query,
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
  const prepared = await Promise.all(
    (images || []).filter(Boolean).map((image, index) => prepareRemoteImage(firebase, ownerUid, image, index)),
  );

  return prepared.filter(Boolean);
}

async function prepareRemoteImage(firebase, ownerUid, image, index = 0) {
  if (!image) return null;
  if (image.url) return createStoredImageMetadata(image, index);
  if (!image.dataUrl) return null;

  const imageRef = firebase.ref(firebase.storage, `${IMAGE_FOLDER}/${ownerUid}/${String(index).padStart(2, "0")}-${sanitizeImageName(image.name || "attachment")}`);
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
    size: image.size || null,
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
    thumbnailUrl: "",
    thumbnailStoragePath: "",
    thumbnailSize: null,
    thumbnailType: "",
    order: index,
  };
}

function createStoredImageMetadata(image, index = 0) {
  return {
    name: image.name || image.originalName || "attachment",
    type: image.type || image.originalType || "image/png",
    url: image.url,
    storagePath: image.storagePath || "",
    generated: Boolean(image.generated),
    compressed: Boolean(image.compressed),
    resolutionReduced: Boolean(image.resolutionReduced),
    profileSignature: image.profileSignature || "",
    size: image.size || image.originalSize || null,
    width: Number.isFinite(Number(image.width)) ? Number(image.width) : null,
    height: Number.isFinite(Number(image.height)) ? Number(image.height) : null,
    thumbnailUrl: "",
    thumbnailStoragePath: "",
    thumbnailSize: null,
    thumbnailType: "",
    order: Number.isFinite(Number(image.order)) ? Number(image.order) : index,
  };
}

async function prepareRemoteThumbnail(firebase, ownerUid, image, index = 0) {
  const thumbnail = await createImageThumbnail(image);
  if (!thumbnail) return null;

  try {
    const baseName = removeFileExtension(image.name || "attachment");
    const thumbnailRef = firebase.ref(
      firebase.storage,
      `${IMAGE_FOLDER}/${ownerUid}/thumb-${String(index).padStart(2, "0")}-${sanitizeImageName(baseName)}.webp`,
    );

    await firebase.uploadString(thumbnailRef, thumbnail.dataUrl, "data_url", {
      contentType: thumbnail.type,
      cacheControl: STORAGE_CACHE_CONTROL,
    });

    return {
      url: await firebase.getDownloadURL(thumbnailRef),
      storagePath: thumbnailRef.fullPath,
      size: thumbnail.size,
      type: thumbnail.type,
    };
  } catch (error) {
    console.warn("목록 썸네일을 업로드하지 못해 원본 이미지를 사용합니다.", error);
    return null;
  }
}

async function createImageThumbnail(image) {
  if (!image?.dataUrl || typeof document === "undefined") return null;

  try {
    const source = await loadImageForThumbnail(image.dataUrl);
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const longestSide = Math.max(width, height);
    if (!longestSide) return null;

    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / longestSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas, "image/webp", THUMBNAIL_QUALITY)
      || await canvasToBlob(canvas, "image/jpeg", 0.78);
    if (!blob) return null;

    return {
      dataUrl: await blobToDataUrl(blob),
      size: blob.size,
      type: blob.type || "image/webp",
    };
  } catch (error) {
    console.warn("목록 썸네일을 만들지 못해 원본 이미지를 사용합니다.", error);
    return null;
  }
}

function loadImageForThumbnail(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 썸네일로 변환하지 못했습니다."));
    image.src = src;
  });
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

function collectImageStoragePaths(image) {
  return [image?.storagePath, image?.thumbnailStoragePath].filter(Boolean);
}

async function deleteStoragePaths(firebase, storagePaths) {
  await Promise.all((storagePaths || []).map(async (storagePath) => {
    try {
      await firebase.deleteObject(firebase.ref(firebase.storage, storagePath));
    } catch (error) {
      console.warn("이전 첨부 이미지를 삭제하지 못했습니다.", storagePath, error);
    }
  }));
}

async function loadRemoteListingsMeta(firebase) {
  const snapshot = await firebase.getDoc(firebase.doc(firebase.db, META_COLLECTION, LISTINGS_META_DOCUMENT));
  return snapshot.exists() ? normalizeRemoteListingsMeta(snapshot.data()) : null;
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
      firebase.where("updatedAt", ">", lastSyncAt),
    ),
  );

  return snapshot.docs.map((document) => normalizeRemoteListing(document.id, document.data()));
}

async function writeListingAndMeta(firebase, listingRef, listing, activeCountDelta, updatedAt) {
  const metaRef = firebase.doc(firebase.db, META_COLLECTION, LISTINGS_META_DOCUMENT);
  const metaPatch = {
    revision: firebase.increment(1),
    updatedAt,
  };

  if (activeCountDelta !== 0) {
    metaPatch.activeCount = firebase.increment(activeCountDelta);
  }

  if (firebase.writeBatch) {
    const batch = firebase.writeBatch(firebase.db);
    batch.set(listingRef, listing);
    batch.set(metaRef, metaPatch, { merge: true });
    await batch.commit();
    return;
  }

  await firebase.setDoc(listingRef, listing);
  await firebase.setDoc(metaRef, metaPatch, { merge: true });
}

function normalizeRemoteListing(id, data) {
  const images = Array.isArray(data?.images) ? data.images : data?.image ? [data.image] : [];

  return {
    ...data,
    id: data?.id || id,
    active: data?.active !== false,
    images,
    image: images[0] ?? null,
    createdAt: normalizeDateValue(data?.createdAt),
    updatedAt: data?.updatedAt ? normalizeDateValue(data.updatedAt) : null,
    deletedAt: data?.deletedAt ? normalizeDateValue(data.deletedAt) : null,
  };
}

function normalizeRemoteListingsMeta(data) {
  return {
    revision: Number(data?.revision || 0),
    updatedAt: normalizeOptionalDateValue(data?.updatedAt),
    activeCount: data?.activeCount != null && Number.isFinite(Number(data.activeCount)) ? Number(data.activeCount) : null,
  };
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

function collectGroupKeys(groups) {
  return [...new Set((groups || []).flatMap((group) => (group.items || []).map((item) => item.normalizedKey).filter(Boolean)))];
}

function loadLocalListings() {
  try {
    return filterActiveListings(JSON.parse(localStorage.getItem(LISTINGS_KEY) || "[]"));
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
  localStorage.setItem(LISTINGS_KEY, JSON.stringify(filterActiveListings(listings)));
  if (syncState) localStorage.setItem(LISTINGS_SYNC_KEY, JSON.stringify(syncState));
}

function filterActiveListings(listings = []) {
  return (Array.isArray(listings) ? listings : []).filter((listing) => listing?.active !== false);
}

function canLoadIncrementalChanges(syncState = {}) {
  return Boolean(syncState.initialized && syncState.cacheVersion === SYNC_CACHE_VERSION && syncState.lastSyncAt);
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
