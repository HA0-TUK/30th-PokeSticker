import { stickers } from "./catalog-data.js";
import {
  createCatalogIndex,
  getItemKey,
  refreshImportedData,
  sortListingsForProfile,
} from "./importer.js";
import {
  SHEET_CARD_RENDER_PURPOSE,
  SHEET_FULL_RENDER_PURPOSE,
  SHEET_LAYOUT_VERSION,
  SHEET_RENDER_CACHE_VERSION,
  createProfileSheetImageDescriptors,
  renderProfileSheetImageBlob,
} from "./profile-sheet.js";
import {
  loadGeneratedSheetBlob,
  saveGeneratedSheetBlob,
} from "./generated-sheet-cache.js";
import {
  DEFAULT_LISTING_SORT_CANDIDATE_LIMIT,
  DEFAULT_LISTINGS_PAGE_SIZE,
  deleteControlledListing,
  deletePersonalListing,
  ensureListingControl,
  getListingStoreMode,
  hasRemoteListingsChanged,
  LISTINGS_BROADCAST_CHANNEL,
  LISTINGS_REFRESH_KEY,
  loadCachedListings,
  loadListingSummariesByIds,
  loadListingWithDetails,
  loadListingPage as loadStoredListingPage,
  resolveListingShareTarget,
} from "./listing-store.js";

const PROFILE_KEY = "pokemon-market-profile";
const TRAINER_KEY = "pokemon-market-trainer";
const RECENT_PRIORITY_KEY = "pokemon-market-listings-recent-priority";
const RECENT_PRIORITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LISTINGS_REFRESH_THROTTLE_MS = 5000;
const LISTING_SHARE_PARAM = "listing";
const catalogIndex = createCatalogIndex(stickers);

const listingList = document.getElementById("listingList");
const listingPagination = document.getElementById("listingPagination");
const listingPaginationSummary = document.getElementById("listingPaginationSummary");
const listingPageButtons = document.getElementById("listingPageButtons");
const previousListingsPageButton = document.getElementById("previousListingsPageButton");
const nextListingsPageButton = document.getElementById("nextListingsPageButton");
const resetListingsButton = document.getElementById("resetListingsButton");
const recentPriorityCheckbox = document.getElementById("recentPriorityCheckbox");
const listingIntro = document.querySelector(".section-title p");
const imageModal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const closeImageModal = document.getElementById("closeImageModal");
const modalPreviousButton = createModalControl("‹", "이전 이미지 크게 보기", "previous");
const modalNextButton = createModalControl("›", "다음 이미지 크게 보기", "next");
const modalCounter = document.createElement("span");
const koreanNameCollator = new Intl.Collator("ko-KR", {
  sensitivity: "base",
  numeric: false,
});
let listingStoreMode = "local";
let currentProfile = loadProfile();
let modalImages = [];
let modalIndex = 0;
let modalListing = null;
let activeCarousel = null;
let carouselObserver = null;
let autoRefreshInitialized = false;
let refreshInFlight = null;
let pageLoadInFlight = null;
let lastRefreshStartedAt = 0;
let listingsBroadcastChannel = null;
let sharedListingId = getSharedListingId();
let highlightedListingId = sharedListingId;
let renderedListingsById = new Map();
let renderedListingsSignature = "";
let lastListingPageResult = null;
let paginationState = {
  pageIndex: 0,
  totalPages: 1,
  startItem: 0,
  endItem: 0,
  totalCount: 0,
  revision: 0,
  matchIndexRevision: 0,
  activeCount: null,
};
const carouselStates = new WeakMap();
const preloadedImageSources = new Set();
const generatedSheetObjectUrls = new Set();
const generatedSheetMemorySources = new Map();
const generatedSheetJobs = [];
const generatedSheetJobKeys = new Set();
const GENERATED_SHEET_RENDER_CONCURRENCY = 1;
let activeGeneratedSheetJobs = 0;

resetListingsButton.addEventListener("click", async () => {
  const message =
    listingStoreMode === "firebase"
      ? "내 교환 글을 목록에서 삭제할까요?\n첨부 이미지는 마이페이지에서 다시 게시할 수 있도록 보존됩니다."
      : "현재 브라우저에 저장된 교환 글을 모두 비울까요?";
  if (!window.confirm(message)) return;

  await deletePersonalListing();
  await renderListings(0);
});

if (recentPriorityCheckbox) {
  recentPriorityCheckbox.checked = loadRecentPriorityPreference();
  recentPriorityCheckbox.addEventListener("change", handleRecentPriorityPreferenceChange);
}

previousListingsPageButton.addEventListener("click", () => goToListingsPage(paginationState.pageIndex - 1));
nextListingsPageButton.addEventListener("click", () => goToListingsPage(paginationState.pageIndex + 1));
listingPageButtons.addEventListener("click", (event) => {
  const button = event.target.closest("[data-page-index]");
  if (!button) return;
  goToListingsPage(Number(button.dataset.pageIndex));
});
listingList.addEventListener("click", handleListingListClick);
listingList.addEventListener("pointerdown", handleCarouselPointerDown);
listingList.addEventListener("pointerup", handleCarouselPointerUp);
listingList.addEventListener("mouseover", handleCarouselMouseOver);
listingList.addEventListener("mouseout", handleCarouselMouseOut);
listingList.addEventListener("focusin", handleCarouselFocusIn);
closeImageModal.addEventListener("click", hideImageModal);
modalPreviousButton.addEventListener("click", () => showModalImageAt(modalIndex - 1));
modalNextButton.addEventListener("click", () => showModalImageAt(modalIndex + 1));
imageModal.addEventListener("click", (event) => {
  if (event.target === imageModal) hideImageModal();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideImageModal();
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;

  if (!imageModal.classList.contains("hidden")) {
    event.preventDefault();
    showModalImageAt(modalIndex + (event.key === "ArrowRight" ? 1 : -1));
    return;
  }

  if (activeCarousel) {
    event.preventDefault();
    stepCarouselWithDetails(activeCarousel, event.key === "ArrowRight" ? 1 : -1);
  }
});
modalCounter.className = "modal-count";
imageModal.append(modalPreviousButton, modalNextButton, modalCounter);

initializeListingsPage();

async function initializeListingsPage() {
  currentProfile = loadProfile();
  listingStoreMode = await getListingStoreMode();
  resetListingsButton.textContent = listingStoreMode === "firebase" ? "내 교환 글 삭제" : "교환 글 비우기";
  listingIntro.textContent =
    listingStoreMode === "firebase"
      ? "현재 교환을 찾고 있는 교환 글입니다."
      : "게시판에 접근할 수 없습니다.";

  if (listingStoreMode === "firebase") {
    const cachedListings = applyRecentPriorityOrdering(
      sortListingsForProfile(
        loadCachedListings().slice(0, DEFAULT_LISTING_SORT_CANDIDATE_LIMIT),
        loadProfile(),
      ),
    ).slice(0, DEFAULT_LISTINGS_PAGE_SIZE);
    if (!sharedListingId && cachedListings.length > 0) {
      await prepareGeneratedSheetSourcesForRender(cachedListings);
      renderListingCards(cachedListings, {
        loading: true,
        preserveGeneratedSheetObjectUrls: true,
      });
    }
  }

  const shareTarget = sharedListingId
    ? await resolveListingShareTarget(sharedListingId, DEFAULT_LISTINGS_PAGE_SIZE)
    : null;
  const initialPageIndex = shareTarget?.pageIndex || 0;

  if (sharedListingId && !shareTarget) {
    listingIntro.textContent = "공유된 교환 글을 찾을 수 없습니다.";
  }

  await renderListings(initialPageIndex, {
    focusListingId: shareTarget?.listing?.id || "",
  });
  setupListingsAutoRefresh();
}

function handleRecentPriorityPreferenceChange() {
  saveRecentPriorityPreference(Boolean(recentPriorityCheckbox?.checked));
  if (!lastListingPageResult) {
    renderListings(0, { forceRender: true });
    return;
  }

  renderListingsFromPageResult({
    ...lastListingPageResult,
    pageIndex: 0,
  }, {
    forceRender: true,
  }).catch((error) => console.warn("최근 글 우선 정렬을 적용하지 못했습니다.", error));
}

function applyRecentPriorityOrdering(listings = []) {
  if (!loadRecentPriorityPreference()) return listings;

  const now = Date.now();
  const recent = [];
  const older = [];
  for (const listing of listings || []) {
    const target = isRecentListing(listing, now) ? recent : older;
    target.push(listing);
  }
  return [...recent, ...older];
}

function isRecentListing(listing, now = Date.now()) {
  const time = Date.parse(listing?.updatedAt || listing?.createdAt || "");
  if (Number.isNaN(time)) return false;
  return now - time <= RECENT_PRIORITY_WINDOW_MS;
}

function loadRecentPriorityPreference() {
  try {
    return localStorage.getItem(RECENT_PRIORITY_KEY) === "true";
  } catch {
    return false;
  }
}

function saveRecentPriorityPreference(enabled) {
  try {
    localStorage.setItem(RECENT_PRIORITY_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures; the current checkbox state is still applied.
  }
}

async function renderListings(pageIndex = paginationState.pageIndex || 0, options = {}) {
  currentProfile = loadProfile();
  const result = await loadStoredListingPage({
    pageIndex,
    pageSize: DEFAULT_LISTINGS_PAGE_SIZE,
    candidateLimit: DEFAULT_LISTING_SORT_CANDIDATE_LIMIT,
  });
  lastListingPageResult = result;
  await renderListingsFromPageResult(result, options);
}

async function renderListingsFromPageResult(result = {}, options = {}) {
  currentProfile = loadProfile();
  const sortedResult = focusListingPageResult(
    createProfileSortedPageResult(result, currentProfile),
    options.focusListingId,
  );
  const listings = sortedResult.needsSummaryHydration
    ? await loadListingSummariesByIds(sortedResult.listings.map((listing) => listing.id), {
      expectedListings: sortedResult.listings,
    })
    : sortedResult.listings;
  const renderResult = {
    ...sortedResult,
    listings,
    loadedCount: listings.length,
    endItem: listings.length > 0 ? sortedResult.startItem + listings.length - 1 : 0,
  };
  if (canReuseRenderedListingCards(listings, options)) {
    rememberRenderedListings(listings);
  } else {
    await prepareGeneratedSheetSourcesForRender(listings);
    renderListingCards(listings, {
      preserveGeneratedSheetObjectUrls: true,
    });
  }
  renderPagination(renderResult);

  if (options.focusListingId) {
    requestAnimationFrame(() => scrollToListingCard(options.focusListingId));
  }
}

function createProfileSortedPageResult(result = {}, profile = null) {
  const candidates = Array.isArray(result.candidates) ? result.candidates : result.listings || [];
  const sortedCandidates = applyRecentPriorityOrdering(sortListingsForProfile(candidates, profile));
  const pageSize = Number.isFinite(Number(result.pageSize)) && Number(result.pageSize) > 0
    ? Math.floor(Number(result.pageSize))
    : DEFAULT_LISTINGS_PAGE_SIZE;
  const hasAuthoritativeTotal = Number.isFinite(Number(result.totalCount));
  const normalizedTotalCount = hasAuthoritativeTotal
    ? Math.max(0, Math.floor(Number(result.totalCount)))
    : sortedCandidates.length;
  let totalCount = normalizedTotalCount;
  let pageCandidates = hasAuthoritativeTotal && sortedCandidates.length > totalCount
    ? sortedCandidates.slice(0, totalCount)
    : sortedCandidates;
  let totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  let pageIndex = Math.min(Math.max(0, Number(result.pageIndex || 0)), totalPages - 1);
  let startIndex = pageIndex * pageSize;
  let listings = pageCandidates.slice(startIndex, Math.min(startIndex + pageSize, totalCount));

  if (result.exhausted && listings.length === 0 && pageCandidates.length > 0 && pageIndex > 0) {
    totalCount = pageCandidates.length;
    totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    pageIndex = Math.min(pageIndex, totalPages - 1);
    startIndex = pageIndex * pageSize;
    listings = pageCandidates.slice(startIndex, startIndex + pageSize);
  }

  return {
    ...result,
    listings,
    candidates: pageCandidates,
    candidateCount: pageCandidates.length,
    loadedCount: listings.length,
    pageIndex,
    pageSize,
    startItem: listings.length > 0 ? startIndex + 1 : 0,
    endItem: listings.length > 0 ? startIndex + listings.length : 0,
    totalCount,
    totalPages,
    hasNextPage: pageIndex < totalPages - 1,
    hasPreviousPage: pageIndex > 0,
    hasMore: pageCandidates.length < totalCount,
  };
}

function focusListingPageResult(result = {}, listingId = "") {
  if (!listingId || !Array.isArray(result.candidates) || result.candidates.length === 0) return result;

  const candidateIndex = result.candidates.findIndex((listing) => listing?.id === listingId);
  if (candidateIndex < 0) return result;

  const pageSize = Number.isFinite(Number(result.pageSize)) && Number(result.pageSize) > 0
    ? Math.floor(Number(result.pageSize))
    : DEFAULT_LISTINGS_PAGE_SIZE;
  const pageIndex = Math.floor(candidateIndex / pageSize);
  if (pageIndex === result.pageIndex) return result;

  const startIndex = pageIndex * pageSize;
  const listings = result.candidates.slice(startIndex, startIndex + pageSize);
  return {
    ...result,
    listings,
    loadedCount: listings.length,
    pageIndex,
    startItem: listings.length > 0 ? startIndex + 1 : 0,
    endItem: listings.length > 0 ? startIndex + listings.length : 0,
    hasNextPage: pageIndex < result.totalPages - 1,
    hasPreviousPage: pageIndex > 0,
  };
}

async function goToListingsPage(pageIndex) {
  if (pageLoadInFlight) return pageLoadInFlight;
  if (!Number.isInteger(pageIndex)) return null;
  if (pageIndex < 0 || pageIndex >= paginationState.totalPages) return null;
  if (pageIndex === paginationState.pageIndex) return null;

  setPaginationBusy(true);
  pageLoadInFlight = renderListings(pageIndex)
    .catch((error) => console.warn("교환 글 페이지를 불러오지 못했습니다.", error))
    .finally(() => {
      pageLoadInFlight = null;
      setPaginationBusy(false);
    });

  return pageLoadInFlight;
}

function queueListingsRefresh(reason = "manual", options = {}) {
  const now = Date.now();
  if (!options.force && now - lastRefreshStartedAt < LISTINGS_REFRESH_THROTTLE_MS) {
    return refreshInFlight;
  }
  if (refreshInFlight) return refreshInFlight;

  lastRefreshStartedAt = now;
  refreshInFlight = (async () => {
    if (listingStoreMode === "firebase" && options.checkRemote !== false) {
      const changed = await hasRemoteListingsChanged(paginationState);
      if (!changed) return null;
    }
    return renderListings(paginationState.pageIndex || 0, {
      forceRender: true,
    });
  })()
    .catch((error) => console.warn("교환 글 목록을 새로고침하지 못했습니다.", reason, error))
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

function setupListingsAutoRefresh() {
  if (autoRefreshInitialized) return;
  autoRefreshInitialized = true;

  window.addEventListener("focus", () => queueListingsRefresh("focus"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) queueListingsRefresh("visible");
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LISTINGS_REFRESH_KEY) queueListingsRefresh("storage");
  });
  window.addEventListener(LISTINGS_REFRESH_KEY, () => queueListingsRefresh("local-event"));

  if (typeof BroadcastChannel !== "undefined") {
    try {
      listingsBroadcastChannel = new BroadcastChannel(LISTINGS_BROADCAST_CHANNEL);
      listingsBroadcastChannel.addEventListener("message", () => {
        queueListingsRefresh("broadcast");
      });
    } catch {
      listingsBroadcastChannel = null;
    }
  }
}

function renderListingCards(listings, options = {}) {
  if (!options.preserveGeneratedSheetObjectUrls) revokeGeneratedSheetObjectUrls();
  listingList.innerHTML = "";
  rememberRenderedListings(listings || []);

  if (listings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state light";
    empty.textContent = options.loading
      ? "교환 글을 불러오는 중입니다."
      : "아직 등록된 교환 글이 없습니다. 마이페이지에서 공유 목록을 가져오거나 직접 목록을 만든 뒤 첫 글을 작성해보세요.";
    listingList.append(empty);
    return;
  }

  for (const listing of listings) {
    listingList.append(createListingCard(listing));
  }
}

function rememberRenderedListings(listings) {
  renderedListingsById = new Map((listings || []).map((listing) => [listing.id, listing]));
  renderedListingsSignature = createListingsRenderSignature(listings || []);
}

function canReuseRenderedListingCards(listings, options = {}) {
  if (options.forceRender || options.loading || !Array.isArray(listings) || listings.length === 0) return false;
  if (!renderedListingsSignature || listingList.children.length === 0) return false;
  return renderedListingsSignature === createListingsRenderSignature(listings);
}

function createListingsRenderSignature(listings = []) {
  return JSON.stringify({
    profile: {
      wanted: createGroupsRenderSignature(currentProfile?.wantedGroups),
      owned: createGroupsRenderSignature(currentProfile?.ownedGroups),
    },
    listings: (listings || []).map((listing) => ({
      id: listing?.id || "",
      ownerUid: listing?.ownerUid || "",
      nickname: listing?.nickname || "",
      contact: listing?.contact || "",
      body: listing?.body || "",
      transferWilling: Boolean(listing?.transferWilling),
      createdAt: listing?.createdAt || "",
      updatedAt: listing?.updatedAt || "",
      imageCount: Number(listing?.imageCount || 0),
      attachmentImageCount: Number(listing?.attachmentImageCount || 0),
      sheetPageCount: Number(listing?.sheetPageCount || 0),
      sheetProfileSignature: listing?.sheetProfileSignature || "",
      sheetLayoutVersion: listing?.sheetLayoutVersion || "",
      catalogSchemaVersion: listing?.catalogSchemaVersion || "",
      wanted: createGroupsRenderSignature(listing?.wantedGroups),
      owned: createGroupsRenderSignature(listing?.ownedGroups),
      firstImage: createImageRenderSignature(listing?.firstImage || listing?.image),
      attachments: getListingAttachmentImages(listing).map(createImageRenderSignature),
    })),
  });
}

function createGroupsRenderSignature(groups = []) {
  return (groups || []).map((group) => ({
    id: group?.id || "",
    label: group?.label || "",
    subtitle: group?.subtitle || "",
    items: (group?.items || []).map((item) => getItemKey(item) || item?.key || item?.rawKey || item?.name || ""),
  }));
}

function createImageRenderSignature(image) {
  if (!image) return null;
  return {
    url: image.url || "",
    storagePath: image.storagePath || "",
    name: image.name || image.originalName || "",
    size: Number(image.size || image.originalSize || 0),
    width: Number(image.width || 0),
    height: Number(image.height || 0),
    generated: Boolean(image.generated),
    order: Number(image.order || 0),
  };
}

function renderPagination(result = {}) {
  paginationState = {
    pageIndex: Number(result.pageIndex || 0),
    totalPages: Math.max(1, Number(result.totalPages || 1)),
    startItem: Number(result.startItem || 0),
    endItem: Number(result.endItem || 0),
    totalCount: Number(result.totalCount || result.loadedCount || result.listings?.length || 0),
    revision: Number(result.revision || 0),
    matchIndexRevision: Number(result.matchIndexRevision || 0),
    activeCount: result.activeCount != null && Number.isFinite(Number(result.activeCount))
      ? Math.max(0, Math.floor(Number(result.activeCount)))
      : null,
  };

  const shouldShow = paginationState.totalCount > 0;
  listingPagination.hidden = !shouldShow;
  if (!shouldShow) return;

  listingPaginationSummary.textContent = `총 ${paginationState.totalCount.toLocaleString("ko-KR")}개 · ${paginationState.pageIndex + 1} / ${paginationState.totalPages}페이지`;
  previousListingsPageButton.disabled = paginationState.pageIndex <= 0 || Boolean(pageLoadInFlight);
  nextListingsPageButton.disabled = paginationState.pageIndex >= paginationState.totalPages - 1 || Boolean(pageLoadInFlight);
  renderPageButtons();
}

function renderPageButtons() {
  listingPageButtons.innerHTML = "";

  for (const item of createVisiblePageItems(paginationState.pageIndex, paginationState.totalPages)) {
    if (item === "ellipsis") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "page-ellipsis";
      ellipsis.textContent = "…";
      listingPageButtons.append(ellipsis);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-number";
    button.dataset.pageIndex = String(item);
    button.textContent = String(item + 1);
    button.disabled = Boolean(pageLoadInFlight);
    button.classList.toggle("active", item === paginationState.pageIndex);
    button.setAttribute("aria-current", item === paginationState.pageIndex ? "page" : "false");
    listingPageButtons.append(button);
  }
}

function createVisiblePageItems(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index);
  }

  const pages = new Set([0, totalPages - 1]);
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages - 2, currentPage + 2);

  for (let index = start; index <= end; index += 1) {
    pages.add(index);
  }

  const sortedPages = [...pages].sort((a, b) => a - b);
  const items = [];

  for (const page of sortedPages) {
    const previous = items[items.length - 1];
    if (typeof previous === "number" && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
  }

  return items;
}

function setPaginationBusy(isBusy) {
  previousListingsPageButton.disabled = isBusy || paginationState.pageIndex <= 0;
  nextListingsPageButton.disabled = isBusy || paginationState.pageIndex >= paginationState.totalPages - 1;
  for (const button of listingPageButtons.querySelectorAll("button")) {
    button.disabled = isBusy;
  }
}

async function editControlledListing(listingId, knownListing = null) {
  try {
    const { listing } = await requestListingControl(listingId, knownListing);
    if (!window.confirm("게시글 수정을 위해 마이페이지로 이동합니다. 게시되지 않은 내용은 저장되지 않습니다.")) return;

    const listingWithDetails = await loadListingWithDetails(listing);
    overwriteMypageFromListing(listingWithDetails || listing);
    window.location.href = "./index.html";
  } catch (error) {
    if (error?.code === "pin-cancelled") return;
    window.alert(error?.message || "게시글 제어권을 확인하지 못했습니다.");
  }
}

async function deleteListingFromCard(listingId, knownListing = null) {
  try {
    await requestListingControl(listingId, knownListing);
    if (!window.confirm("이 교환 글을 삭제할까요? 첨부 이미지는 재게시를 위해 유지됩니다.")) return;

    await deleteControlledListing(listingId);
    await renderListings(paginationState.pageIndex || 0);
  } catch (error) {
    if (error?.code === "pin-cancelled") return;
    window.alert(error?.message || "게시글을 삭제하지 못했습니다.");
  }
}

async function requestListingControl(listingId, knownListing = null) {
  try {
    return await ensureListingControl(listingId, "", { knownListing });
  } catch (error) {
    if (!["pin-required", "pin-invalid", "pin-format"].includes(error?.code)) throw error;
  }

  const pin = await requestControlPin();
  return ensureListingControl(listingId, pin, { knownListing });
}

function requestControlPin() {
  const dialog = getControlPinDialog();
  const form = dialog.querySelector("form");
  const input = dialog.querySelector("input");
  const cancelButton = dialog.querySelector("[data-pin-cancel]");

  input.value = "";
  dialog.classList.remove("hidden");
  input.focus();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      form.removeEventListener("submit", handleSubmit);
      cancelButton.removeEventListener("click", handleCancel);
      dialog.classList.add("hidden");
    };
    const handleCancel = () => {
      cleanup();
      reject(createListingUiError("pin-cancelled", "PIN 입력이 취소되었습니다."));
    };
    const handleSubmit = (event) => {
      event.preventDefault();
      const pin = input.value.trim();
      if (!/^\d{4}$/.test(pin)) {
        input.setCustomValidity("숫자 4자리를 입력하세요.");
        input.reportValidity();
        input.setCustomValidity("");
        return;
      }
      cleanup();
      resolve(pin);
    };

    form.addEventListener("submit", handleSubmit);
    cancelButton.addEventListener("click", handleCancel);
  });
}

function getControlPinDialog() {
  let dialog = document.getElementById("controlPinDialog");
  if (dialog) return dialog;

  dialog = document.createElement("div");
  dialog.id = "controlPinDialog";
  dialog.className = "control-pin-dialog hidden";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <form class="control-pin-box">
      <h2>게시글 관리 PIN</h2>
      <label class="field">
        <span>숫자 4자리</span>
        <input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]{4}" required />
      </label>
      <div class="actions">
        <button type="submit">확인</button>
        <button type="button" class="secondary" data-pin-cancel>취소</button>
      </div>
    </form>
  `;
  dialog.querySelector("input").addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D+/g, "").slice(0, 4);
  });
  document.body.append(dialog);
  return dialog;
}

function overwriteMypageFromListing(listing) {
  const now = new Date().toISOString();
  localStorage.setItem(PROFILE_KEY, JSON.stringify({
    source: "controlled-listing",
    importedAt: now,
    haveLayoutMode: "split",
    wantedGroups: listing?.wantedGroups || [],
    ownedGroups: listing?.ownedGroups || [],
    rawData: null,
  }));
  localStorage.setItem(TRAINER_KEY, JSON.stringify({
    listingId: listing?.id || "",
    hasControlPin: Boolean(listing?.hasControlPin),
    nickname: listing?.nickname || "",
    contact: listing?.contact || "",
    body: listing?.body || "",
    transferWilling: Boolean(listing?.transferWilling),
    images: normalizeListingImages(listing).filter((image) => image && !image.generated),
  }));
}

function createListingUiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function copyListingShareLink(listingId, button) {
  if (!listingId) return;
  const originalText = button.textContent;

  try {
    await copyTextToClipboard(createListingShareUrl(listingId));
    button.textContent = "복사됨";
    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1600);
  } catch (error) {
    console.warn("공유 링크를 복사하지 못했습니다.", error);
    button.textContent = "실패";
    window.setTimeout(() => {
      button.textContent = originalText;
    }, 1600);
  }
}

function scrollToListingCard(listingId) {
  const card = [...listingList.querySelectorAll("[data-listing-id]")]
    .find((candidate) => candidate.dataset.listingId === listingId);
  if (!card) return;

  highlightedListingId = listingId;
  card.classList.add("shared-target");
  card.scrollIntoView({
    block: "start",
    behavior: "smooth",
  });
}

function getSharedListingId() {
  try {
    return new URL(window.location.href).searchParams.get(LISTING_SHARE_PARAM)?.trim() || "";
  } catch {
    return "";
  }
}

function createListingShareUrl(listingId) {
  const url = new URL("./listings.html", window.location.href);
  url.searchParams.set(LISTING_SHARE_PARAM, listingId);
  url.hash = "";
  return url.toString();
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    textarea.remove();
  }
}

function createListingCard(listing) {
  const highlightSets = createHighlightSets(currentProfile);
  const card = document.createElement("article");
  card.className = "listing-card";
  card.dataset.listingId = listing.id || "";
  if (listing.id && listing.id === highlightedListingId) card.classList.add("shared-target");

  const header = document.createElement("header");
  const titleGroup = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = listing.nickname;
  const createdAt = document.createElement("p");
  const wasEdited = isEditedListing(listing);
  const displayTime = wasEdited ? listing.updatedAt : listing.createdAt;
  createdAt.textContent = `${wasEdited ? "수정" : "작성"} ${new Date(displayTime).toLocaleString("ko-KR")}`;
  titleGroup.append(title, createdAt);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = listing.transferWilling ? "양도 의향 있음" : "교환 우선";

  const shareButton = document.createElement("button");
  shareButton.type = "button";
  shareButton.className = "secondary listing-share-button";
  shareButton.dataset.listingShareId = listing.id || "";
  shareButton.textContent = "공유";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "secondary listing-control-button";
  editButton.dataset.listingEditId = listing.id || "";
  editButton.textContent = "수정";

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "secondary listing-control-button danger";
  deleteButton.dataset.listingDeleteId = listing.id || "";
  deleteButton.textContent = "삭제";

  const headerActions = document.createElement("div");
  headerActions.className = "listing-header-actions";
  headerActions.append(badge, shareButton, editButton, deleteButton);
  header.append(titleGroup, headerActions);

  const body = document.createElement("div");
  body.className = "listing-body";

  const images = normalizeListingImages(listing);
  if (images.length > 0) {
    body.append(createListingGallery(images, listing));
  }

  const content = document.createElement("div");
  content.className = "listing-content";

  if (listing.body) {
    const text = document.createElement("p");
    text.className = "listing-text";
    text.textContent = listing.body;
    content.append(text);
  }

  const details = document.createElement("dl");
  addDetail(details, "연락처", listing.contact);
  addGroupDetail(details, "구해요", listing.wantedGroups, highlightSets.myOwned);
  addGroupDetail(details, "보유중", listing.ownedGroups, highlightSets.myWanted);
  content.append(details);

  body.append(content);
  card.append(header, body);
  return card;
}

function createListingGallery(images, listing) {
  const gallery = document.createElement("div");
  gallery.className = "listing-gallery";

  const carousel = document.createElement("div");
  carousel.className = "listing-carousel";
  carousel.tabIndex = 0;

  const viewport = document.createElement("div");
  viewport.className = "listing-carousel-viewport";

  const frameButton = document.createElement("button");
  frameButton.type = "button";
  frameButton.className = "listing-carousel-frame";
  frameButton.dataset.carouselAction = "open";

  const image = document.createElement("img");
  image.className = "listing-image";
  image.loading = "lazy";
  image.decoding = "async";
  image.fetchPriority = "auto";
  const fallbackPreview = document.createElement("div");
  fallbackPreview.className = "listing-fallback-preview";
  frameButton.append(image, fallbackPreview);

  const previousButton = createCarouselControl("‹", "이전 이미지 보기", "previous");
  const nextButton = createCarouselControl("›", "다음 이미지 보기", "next");
  const counter = document.createElement("span");
  counter.className = "carousel-count";
  const displayImageCount = getExpectedCarouselImageCount(listing, images);

  const dotButtons = Array.from({ length: displayImageCount }, (_, index) => {
    const dotButton = document.createElement("button");
    dotButton.type = "button";
    dotButton.className = "carousel-dot";
    dotButton.dataset.carouselAction = "dot";
    dotButton.dataset.carouselIndex = String(index);
    dotButton.setAttribute("aria-label", `${index + 1}번째 이미지 보기`);
    return dotButton;
  });

  viewport.append(frameButton);
  if (displayImageCount > 1) {
    viewport.append(previousButton, nextButton, counter);
  }

  carousel.append(viewport);
  if (displayImageCount > 1) {
    const dots = document.createElement("div");
    dots.className = "carousel-dots";
    dots.append(...dotButtons);
    carousel.append(dots);
  }

  gallery.append(carousel);
  carouselStates.set(carousel, {
    activeIndex: 0,
    counter,
    dotButtons,
    fallbackPreview,
    frameButton,
    image,
    images,
    listing,
    detailLoaded: false,
    detailLoading: null,
    loaded: false,
    startX: 0,
    swiped: false,
  });
  image.addEventListener("error", () => handleListingImageError(carousel, image.currentSrc || image.src));
  queueCarouselInitialLoad(carousel);
  return gallery;
}

function createCarouselControl(text, label, direction) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `carousel-control ${direction}`;
  button.dataset.carouselAction = direction;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

async function handleListingListClick(event) {
  const editButton = event.target.closest("[data-listing-edit-id]");
  if (editButton) {
    event.preventDefault();
    event.stopPropagation();
    const listingId = editButton.dataset.listingEditId;
    editControlledListing(listingId, renderedListingsById.get(listingId) || null);
    return;
  }

  const deleteButton = event.target.closest("[data-listing-delete-id]");
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    const listingId = deleteButton.dataset.listingDeleteId;
    deleteListingFromCard(listingId, renderedListingsById.get(listingId) || null);
    return;
  }

  const shareButton = event.target.closest("[data-listing-share-id]");
  if (shareButton) {
    event.preventDefault();
    event.stopPropagation();
    copyListingShareLink(shareButton.dataset.listingShareId, shareButton);
    return;
  }

  const actionTarget = event.target.closest("[data-carousel-action]");
  if (!actionTarget) return;

  const carousel = actionTarget.closest(".listing-carousel");
  const state = carousel ? carouselStates.get(carousel) : null;
  if (!carousel || !state) return;

  setActiveCarousel(carousel);
  const action = actionTarget.dataset.carouselAction;

  if (action === "open") {
    if (state.swiped) {
      state.swiped = false;
      event.preventDefault();
      return;
    }
    ensureCarouselLoaded(carousel);
    await ensureGeneratedSheetSource(carousel, state.images[state.activeIndex]);
    const baseModalImages = await loadCarouselModalImages(carousel);
    const modalImageList = createModalImageList(state.listing, baseModalImages);
    if (isLocalGeneratedSheetImage(modalImageList[state.activeIndex])) {
      await getOrCreateGeneratedSheetSource(state.listing, modalImageList[state.activeIndex]);
    }
    if (!getListingImageSource(modalImageList[state.activeIndex])) return;
    showImageModal(modalImageList, state.activeIndex, state.listing);
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (action === "previous") stepCarouselWithDetails(carousel, -1);
  if (action === "next") stepCarouselWithDetails(carousel, 1);
  if (action === "dot") setCarouselImageWithDetails(carousel, Number(actionTarget.dataset.carouselIndex));
}

function handleCarouselPointerDown(event) {
  const viewport = event.target.closest(".listing-carousel-viewport");
  const carousel = viewport?.closest(".listing-carousel");
  const state = carousel ? carouselStates.get(carousel) : null;
  if (!state) return;

  setActiveCarousel(carousel);
  state.startX = event.clientX;
  state.swiped = false;
}

function handleCarouselPointerUp(event) {
  const viewport = event.target.closest(".listing-carousel-viewport");
  const carousel = viewport?.closest(".listing-carousel");
  const state = carousel ? carouselStates.get(carousel) : null;
  const displayImageCount = getExpectedCarouselImageCount(state?.listing, state?.images || []);
  if (!state || displayImageCount <= 1) return;

  const deltaX = event.clientX - state.startX;
  if (Math.abs(deltaX) < 42) return;

  state.swiped = true;
  stepCarouselWithDetails(carousel, deltaX < 0 ? 1 : -1);
}

function handleCarouselMouseOver(event) {
  const carousel = event.target.closest(".listing-carousel");
  if (carousel && carouselStates.has(carousel)) setActiveCarousel(carousel);
}

function handleCarouselMouseOut(event) {
  if (!activeCarousel) return;
  if (activeCarousel.contains(event.relatedTarget)) return;
  activeCarousel.classList.remove("active");
  activeCarousel = null;
}

function handleCarouselFocusIn(event) {
  const carousel = event.target.closest(".listing-carousel");
  if (carousel && carouselStates.has(carousel)) setActiveCarousel(carousel);
}

function setActiveCarousel(carousel) {
  if (activeCarousel && activeCarousel !== carousel) activeCarousel.classList.remove("active");
  activeCarousel = carousel;
  activeCarousel.classList.add("active");
}

function stepCarousel(carousel, direction) {
  const state = carouselStates.get(carousel);
  if (!state || state.images.length <= 1) return;
  setCarouselImage(carousel, state.activeIndex + direction);
}

async function stepCarouselWithDetails(carousel, direction) {
  await loadCarouselModalImages(carousel);
  stepCarousel(carousel, direction);
}

async function setCarouselImageWithDetails(carousel, nextIndex) {
  await loadCarouselModalImages(carousel);
  setCarouselImage(carousel, nextIndex);
}

function setCarouselImage(carousel, nextIndex) {
  const state = carouselStates.get(carousel);
  if (!state || state.images.length === 0) return;

  state.activeIndex = (nextIndex + state.images.length) % state.images.length;
  const listingImage = state.images[state.activeIndex];
  const source = getListingImageSource(listingImage);
  if (source) {
    if (state.image.getAttribute("src") !== source) state.image.src = source;
  } else if (isLocalGeneratedSheetImage(listingImage)) {
    state.image.removeAttribute("src");
    renderFallbackPreview(state.fallbackPreview, state.listing, listingImage, {
      missing: false,
    });
    queueGeneratedSheetRender(carousel, listingImage);
  } else {
    state.image.removeAttribute("src");
    renderFallbackPreview(state.fallbackPreview, state.listing, listingImage, {
      missing: Boolean(listingImage?.loadFailed),
    });
  }
  state.frameButton.classList.toggle("missing-preview", !source);
  state.image.alt = listingImage.name || "첨부 이미지";
  state.frameButton.setAttribute("aria-label", `${state.activeIndex + 1}번째 첨부 이미지 크게 보기`);
  state.counter.textContent = `${state.activeIndex + 1} / ${getExpectedCarouselImageCount(state.listing, state.images)}`;
  state.loaded = true;
  state.dotButtons.forEach((dotButton, index) => {
    dotButton.classList.toggle("active", index === state.activeIndex);
    dotButton.setAttribute("aria-current", index === state.activeIndex ? "true" : "false");
  });

  scheduleAdjacentImagePreload(state.images, state.activeIndex);
}

function handleListingImageError(carousel, failedSource = "") {
  const state = carouselStates.get(carousel);
  if (!state || state.images.length === 0) return;

  const listingImage = state.images[state.activeIndex];
  const expectedSource = getListingImageSource(listingImage, { includeFailed: true });
  if (failedSource && expectedSource && failedSource !== expectedSource) return;

  listingImage.loadFailed = true;
  state.image.removeAttribute("src");
  renderFallbackPreview(state.fallbackPreview, state.listing, listingImage, {
    missing: true,
  });
  state.frameButton.classList.add("missing-preview");
}

function queueCarouselInitialLoad(carousel) {
  if ("IntersectionObserver" in window) {
    getCarouselObserver().observe(carousel);
    return;
  }

  ensureCarouselLoaded(carousel);
}

function getCarouselObserver() {
  carouselObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      ensureCarouselLoaded(entry.target);
      carouselObserver.unobserve(entry.target);
    }
  }, {
    rootMargin: "420px 0px",
  });

  return carouselObserver;
}

function ensureCarouselLoaded(carousel) {
  const state = carouselStates.get(carousel);
  if (!state || state.loaded) return;
  setCarouselImage(carousel, state.activeIndex);
}

async function ensureGeneratedSheetSource(carousel, image) {
  if (!isLocalGeneratedSheetImage(image) || getListingImageSource(image)) return getListingImageSource(image);
  const state = carouselStates.get(carousel);
  if (!state) return "";

  try {
    const source = await getOrCreateGeneratedSheetSource(state.listing, image);
    if (!source) return "";
    if (state.images[state.activeIndex] === image) {
      setCarouselImage(carousel, state.activeIndex);
    }
    return source;
  } catch (error) {
    image.loadFailed = true;
    console.warn("援먰솚 紐⑸줉 ?대?吏瑜??앹꽦?섏? 紐삵뻽?듬땲??", error);
    return "";
  }
}

function queueGeneratedSheetRender(carousel, image) {
  if (!isLocalGeneratedSheetImage(image) || getListingImageSource(image) || image.loadFailed) return;
  const cacheKey = image.cacheKey || "";
  if (!cacheKey || generatedSheetJobKeys.has(cacheKey)) return;

  generatedSheetJobKeys.add(cacheKey);
  generatedSheetJobs.push({ carousel, image });
  pumpGeneratedSheetQueue();
}

function pumpGeneratedSheetQueue() {
  while (activeGeneratedSheetJobs < GENERATED_SHEET_RENDER_CONCURRENCY && generatedSheetJobs.length > 0) {
    const job = generatedSheetJobs.shift();
    activeGeneratedSheetJobs += 1;
    processGeneratedSheetJob(job)
      .catch((error) => console.warn("援먰솚 紐⑸줉 ?대?吏 ?먮룞 ?앹꽦???ㅽ뙣?덉뒿?덈떎.", error))
      .finally(() => {
        activeGeneratedSheetJobs -= 1;
        generatedSheetJobKeys.delete(job.image.cacheKey || "");
        pumpGeneratedSheetQueue();
      });
  }
}

async function processGeneratedSheetJob(job) {
  const { carousel, image } = job;
  const state = carouselStates.get(carousel);
  if (!state || !state.images.includes(image)) return;

  await ensureGeneratedSheetSource(carousel, image);
}

async function getOrCreateGeneratedSheetSource(listing, image) {
  if (!isLocalGeneratedSheetImage(image)) return "";
  if (image.objectUrl) return image.objectUrl;

  const cachedBlob = await loadGeneratedSheetBlob(image.cacheKey);
  const renderedImage = cachedBlob
    ? null
    : await renderProfileSheetImageBlob(listing, {
      pageIndex: image.sheetPageIndex || 0,
      purpose: image.sheetRenderPurpose || SHEET_CARD_RENDER_PURPOSE,
    });
  const blob = cachedBlob || renderedImage?.blob;
  if (!blob) return "";

  if (!cachedBlob) {
    await saveGeneratedSheetBlob(image.cacheKey, blob, {
      width: renderedImage?.width || image.width,
      height: renderedImage?.height || image.height,
      type: renderedImage?.type || image.type,
    });
  }

  const objectUrl = rememberGeneratedSheetObjectUrl(image.cacheKey, blob);
  image.objectUrl = objectUrl;
  image.url = objectUrl;
  if (renderedImage?.width) image.width = renderedImage.width;
  if (renderedImage?.height) image.height = renderedImage.height;
  image.loadFailed = false;
  return objectUrl;
}

async function loadCarouselModalImages(carousel) {
  const state = carouselStates.get(carousel);
  if (!state) return [];
  if (state.detailLoaded) return state.images;

  const expectedImageCount = getExpectedCarouselImageCount(state.listing, state.images);
  if (!shouldTryLoadListingDetails(state, expectedImageCount)) {
    state.detailLoaded = true;
    return state.images;
  }

  state.detailLoading ??= loadListingWithDetails(state.listing)
    .then(async (listingWithDetails) => {
      const images = normalizeListingImages(listingWithDetails);
      if (listingWithDetails && images.length > 0) {
        state.listing = listingWithDetails;
        state.images = images;
        renderedListingsById.set(listingWithDetails.id, listingWithDetails);
      }
      state.detailLoaded = true;
      return state.images;
    })
    .catch((error) => {
      console.warn("게시글 상세 이미지를 불러오지 못했습니다.", error);
      state.detailLoaded = true;
      return state.images;
    })
    .finally(() => {
      state.detailLoading = null;
    });

  return state.detailLoading;
}

function shouldTryLoadListingDetails(state, expectedImageCount) {
  if (!state?.listing?.id) return false;
  if (expectedImageCount > state.images.length) return true;
  return state.images.length <= 1;
}

function scheduleAdjacentImagePreload(images, activeIndex) {
  if (!Array.isArray(images) || images.length <= 1) return;

  const preload = () => {
    preloadListingImage(images[(activeIndex + 1) % images.length]);
    preloadListingImage(images[(activeIndex - 1 + images.length) % images.length]);
  };

  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preload, { timeout: 700 });
  } else {
    window.setTimeout(preload, 0);
  }
}

function preloadListingImage(image) {
  if (!isLocalGeneratedSheetImage(image)) return;
  const source = getListingImageSource(image);
  if (!source || preloadedImageSources.has(source)) return;

  preloadedImageSources.add(source);
  const imageElement = new Image();
  imageElement.decoding = "async";
  imageElement.addEventListener("error", () => {
    image.loadFailed = true;
  });
  imageElement.src = source;
}

function createModalControl(text, label, direction) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `modal-nav ${direction}`;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

function isEditedListing(listing) {
  if (!listing?.updatedAt) return false;
  if (!listing?.createdAt) return true;
  const createdTime = Date.parse(listing.createdAt);
  const updatedTime = Date.parse(listing.updatedAt);
  if (Number.isNaN(createdTime) || Number.isNaN(updatedTime)) return listing.updatedAt !== listing.createdAt;
  return Math.abs(updatedTime - createdTime) > 1000;
}

function showImageModal(images, index = 0, listing = null) {
  modalImages = Array.isArray(images) ? images.filter(Boolean) : [images].filter(Boolean);
  modalIndex = Math.max(0, Math.min(index, modalImages.length - 1));
  modalListing = listing;
  void showModalImageAt(modalIndex);
  imageModal.classList.remove("hidden");
}

async function showModalImageAt(nextIndex) {
  if (modalImages.length === 0) return;

  modalIndex = (nextIndex + modalImages.length) % modalImages.length;
  const image = modalImages[modalIndex];
  let source = getListingImageSource(image);
  if (!source && isLocalGeneratedSheetImage(image) && modalListing) {
    const expectedIndex = modalIndex;
    source = await getOrCreateGeneratedSheetSource(modalListing, image);
    if (modalIndex !== expectedIndex) return;
  }

  if (source) {
    modalImage.src = source;
  } else {
    modalImage.removeAttribute("src");
  }
  modalImage.alt = image.name || "확대된 첨부 이미지";
  modalCounter.textContent = `${modalIndex + 1} / ${modalImages.length}`;
  modalPreviousButton.classList.toggle("hidden", modalImages.length <= 1);
  modalNextButton.classList.toggle("hidden", modalImages.length <= 1);
  modalCounter.classList.toggle("hidden", modalImages.length <= 1);
}

function getListingImageSource(image, options = {}) {
  if (!options.includeFailed && image?.loadFailed) return "";
  if (isLocalGeneratedSheetImage(image)) return image?.objectUrl || image?.url || "";
  if (image?.generated) return "";
  return image?.url || image?.dataUrl || "";
}

function renderFallbackPreview(container, listing, image, options = {}) {
  container.innerHTML = "";

  const title = document.createElement("strong");
  title.textContent = image?.generated ? "교환 목록 미리보기" : image?.name || "첨부 이미지";
  container.append(title);

  if (options.missing) {
    const note = document.createElement("span");
    note.textContent = "이미지를 다시 첨부해야 합니다.";
    container.append(note);
    return;
  }

  if (!image?.generated) {
    const note = document.createElement("span");
    note.textContent = "눌러서 원본 보기";
    container.append(note);
    return;
  }

  const columns = document.createElement("div");
  columns.className = "fallback-preview-columns";
  columns.append(
    createFallbackPreviewColumn("구해요", listing?.wantedGroups, "wanted"),
    createFallbackPreviewColumn("보유중", listing?.ownedGroups, "owned"),
  );
  container.append(columns);
}

function createFallbackPreviewColumn(label, groups, type) {
  const column = document.createElement("div");
  column.className = `fallback-preview-column ${type}`;

  const heading = document.createElement("span");
  heading.textContent = label;
  column.append(heading);

  const items = (groups || [])
    .flatMap((group) => group?.items || [])
    .map((item) => item?.key || item?.rawKey || item?.name || "")
    .filter(Boolean)
    .slice(0, 8);

  if (items.length === 0) {
    const empty = document.createElement("em");
    empty.textContent = "-";
    column.append(empty);
    return column;
  }

  const list = document.createElement("ul");
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = item;
    list.append(row);
  }
  column.append(list);
  return column;
}

function normalizeListingImages(listing) {
  if (!listing) return [];
  return [
    ...createListingGeneratedSheetImages(listing, SHEET_CARD_RENDER_PURPOSE),
    ...getListingAttachmentImages(listing),
  ];
}

function createModalImageList(listing, images = []) {
  const fullGeneratedImages = new Map(
    createListingGeneratedSheetImages(listing, SHEET_FULL_RENDER_PURPOSE)
      .map((image) => [Number(image.sheetPageIndex || 0), image]),
  );

  return (images || []).map((image) => {
    if (!isLocalGeneratedSheetImage(image)) return image;
    const pageIndex = Number(image.sheetPageIndex || 0);
    return fullGeneratedImages.get(pageIndex) || image;
  });
}

async function prepareGeneratedSheetSourcesForRender(listings) {
  revokeGeneratedSheetObjectUrls();

  const imageByCacheKey = new Map();
  for (const listing of listings || []) {
    for (const image of createListingGeneratedSheetImages(listing, SHEET_CARD_RENDER_PURPOSE)) {
      if (image.cacheKey && !generatedSheetMemorySources.has(image.cacheKey)) {
        imageByCacheKey.set(image.cacheKey, image);
      }
    }
  }

  await Promise.all([...imageByCacheKey].map(async ([cacheKey, image]) => {
    const blob = await loadGeneratedSheetBlob(cacheKey);
    if (!blob) return;
    rememberGeneratedSheetObjectUrl(cacheKey, blob, {
      type: image.type,
      width: image.width,
      height: image.height,
    });
  }));
}

function createListingGeneratedSheetImages(listing, purpose = SHEET_CARD_RENDER_PURPOSE) {
  const descriptors = createProfileSheetImageDescriptors(listing, { purpose });
  const expectedPageCount = Math.max(
    descriptors.length,
    Number.isFinite(Number(listing?.sheetPageCount)) ? Number(listing.sheetPageCount) : 0,
  );

  return Array.from({ length: Math.max(1, expectedPageCount) }, (_, pageIndex) => {
    const descriptor = descriptors[pageIndex] || descriptors[0] || {};
    const sheetPageCount = Math.max(1, expectedPageCount);
    const profileSignature = descriptor.profileSignature || listing?.sheetProfileSignature || "";

    const renderPurpose = descriptor.sheetRenderPurpose || purpose || SHEET_CARD_RENDER_PURPOSE;
    const cacheKey = createGeneratedSheetCacheKey(listing, pageIndex, profileSignature, renderPurpose);
    const cachedSource = generatedSheetMemorySources.get(cacheKey) || "";

    return {
      ...descriptor,
      name: descriptor.name || `poke30-tra-compatible-sheet-${pageIndex + 1}.webp`,
      generated: true,
      localGenerated: true,
      url: cachedSource,
      objectUrl: cachedSource,
      profileSignature,
      sheetLayoutVersion: listing?.sheetLayoutVersion || SHEET_LAYOUT_VERSION,
      sheetRenderPurpose: renderPurpose,
      sheetRenderScale: descriptor.sheetRenderScale,
      sheetRenderCacheVersion: descriptor.sheetRenderCacheVersion || SHEET_RENDER_CACHE_VERSION,
      sheetPageIndex: pageIndex,
      sheetPageCount,
      cacheKey,
      order: pageIndex,
    };
  });
}

function getListingAttachmentImages(listing) {
  const images = Array.isArray(listing?.images) && listing.images.length > 0
    ? listing.images
    : listing?.firstImage
      ? [listing.firstImage]
      : listing?.image
        ? [listing.image]
        : [];

  return images.filter((image) => image && !image.generated);
}

function getExpectedCarouselImageCount(listing, images = []) {
  const generatedCount = Math.max(1, Number.isFinite(Number(listing?.sheetPageCount)) ? Number(listing.sheetPageCount) : 0);
  const attachmentCount = Number.isFinite(Number(listing?.attachmentImageCount))
    ? Number(listing.attachmentImageCount)
    : getListingAttachmentImages(listing).length;
  const declaredCount = Number.isFinite(Number(listing?.imageCount)) ? Number(listing.imageCount) : 0;

  return Math.max(images.length, declaredCount, generatedCount + attachmentCount);
}

function createGeneratedSheetCacheKey(listing, pageIndex, profileSignature, purpose = SHEET_CARD_RENDER_PURPOSE) {
  return [
    "auto-sheet",
    SHEET_RENDER_CACHE_VERSION,
    normalizeCacheKeyPart(purpose || SHEET_CARD_RENDER_PURPOSE),
    normalizeCacheKeyPart(listing?.id || listing?.ownerUid || "local"),
    normalizeCacheKeyPart(listing?.updatedAt || listing?.createdAt || ""),
    normalizeCacheKeyPart(listing?.sheetLayoutVersion || SHEET_LAYOUT_VERSION),
    normalizeCacheKeyPart(listing?.catalogSchemaVersion || ""),
    String(pageIndex),
    hashString(profileSignature || ""),
  ].join(":");
}

function normalizeCacheKeyPart(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "none";
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? "");

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function isLocalGeneratedSheetImage(image) {
  return Boolean(image?.generated && image?.localGenerated);
}

function rememberGeneratedSheetObjectUrl(cacheKey, blob, metadata = {}) {
  if (!cacheKey || !blob) return "";
  const existingSource = generatedSheetMemorySources.get(cacheKey);
  if (existingSource) return existingSource;

  const objectUrl = URL.createObjectURL(blob);
  generatedSheetMemorySources.set(cacheKey, objectUrl);
  generatedSheetObjectUrls.add(objectUrl);
  return objectUrl;
}

function revokeGeneratedSheetObjectUrls() {
  for (const objectUrl of generatedSheetObjectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  generatedSheetObjectUrls.clear();
  generatedSheetMemorySources.clear();
}

function hideImageModal() {
  imageModal.classList.add("hidden");
  modalImages = [];
  modalIndex = 0;
  modalListing = null;
  modalImage.removeAttribute("src");
}

function addDetail(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value || "-";
  list.append(term, description);
}

function addGroupDetail(list, label, groups, highlightSet) {
  const term = document.createElement("dt");
  term.textContent = label;

  const description = document.createElement("dd");
  description.className = "listing-items";

  const items = createSortedListingItems(groups, highlightSet);
  if (items.length === 0) {
    description.textContent = "-";
  }

  let expanded = false;
  const renderItems = () => {
    description.innerHTML = "";
    const visibleItems = expanded ? items : items.slice(0, 5);

    visibleItems.forEach((item, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.className = "item-separator";
        separator.textContent = ", ";
        description.append(separator);
      }

      const itemText = document.createElement("span");
      itemText.textContent = item.key || item.rawKey || "-";
      if (item.matched) itemText.className = "match-highlight";
      description.append(itemText);
    });

    if (items.length > 5) {
      const moreButton = document.createElement("button");
      moreButton.type = "button";
      moreButton.className = "inline-more-button";
      moreButton.textContent = expanded ? "접기" : `외 ${items.length - 5}개 더보기`;
      moreButton.addEventListener("click", () => {
        expanded = !expanded;
        renderItems();
      });

      if (visibleItems.length > 0) {
        const separator = document.createElement("span");
        separator.className = "item-separator";
        separator.textContent = " ";
        description.append(separator);
      }

      description.append(moreButton);
    }
  };

  if (items.length > 0) renderItems();
  list.append(term, description);
}

function createSortedListingItems(groups, highlightSet) {
  return (groups || [])
    .flatMap((group) => group.items || [])
    .map((item) => ({
      ...item,
      matched: highlightSet.has(getItemKey(item)),
    }))
    .sort(compareListingItems);
}

function compareListingItems(a, b) {
  if (a.matched !== b.matched) return a.matched ? -1 : 1;
  return koreanNameCollator.compare(getSortableItemName(a), getSortableItemName(b));
}

function getSortableItemName(item) {
  return String(item?.name || item?.key || item?.rawKey || "")
    .replace(/^\s*\d+\./, "")
    .trim();
}

function createHighlightSets(profile) {
  return {
    myWanted: createItemSet(profile?.wantedGroups),
    myOwned: createItemSet(profile?.ownedGroups),
  };
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

function loadProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
    return profile ? refreshImportedData(profile, catalogIndex) : null;
  } catch {
    return null;
  }
}
