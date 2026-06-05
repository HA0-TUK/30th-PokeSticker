import { sortListingsForProfile } from "./importer.js";
import {
  DEFAULT_LISTINGS_PAGE_SIZE,
  deletePersonalListing,
  getListingStoreMode,
  LISTINGS_BROADCAST_CHANNEL,
  LISTINGS_REFRESH_KEY,
  loadCachedListings,
  loadListingPage as loadStoredListingPage,
} from "./listing-store.js";

const PROFILE_KEY = "pokemon-market-profile";
const LISTINGS_REFRESH_THROTTLE_MS = 5000;

const listingList = document.getElementById("listingList");
const listingPagination = document.getElementById("listingPagination");
const listingPaginationSummary = document.getElementById("listingPaginationSummary");
const listingPageButtons = document.getElementById("listingPageButtons");
const previousListingsPageButton = document.getElementById("previousListingsPageButton");
const nextListingsPageButton = document.getElementById("nextListingsPageButton");
const resetListingsButton = document.getElementById("resetListingsButton");
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
let activeCarousel = null;
let carouselObserver = null;
let autoRefreshInitialized = false;
let refreshInFlight = null;
let pageLoadInFlight = null;
let lastRefreshStartedAt = 0;
let listingsBroadcastChannel = null;
let paginationState = {
  pageIndex: 0,
  totalPages: 1,
  startItem: 0,
  endItem: 0,
  totalCount: 0,
};
const carouselStates = new WeakMap();
const preloadedImageSources = new Set();

resetListingsButton.addEventListener("click", async () => {
  const message =
    listingStoreMode === "firebase"
      ? "저장된 내 교환 글을 삭제할까요?"
      : "현재 브라우저에 저장된 교환 글을 모두 비울까요?";
  if (!window.confirm(message)) return;

  await deletePersonalListing();
  await renderListings(0);
});

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
    stepCarousel(activeCarousel, event.key === "ArrowRight" ? 1 : -1);
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
    renderListingCards(sortListingsForProfile(loadCachedListings().slice(0, DEFAULT_LISTINGS_PAGE_SIZE), loadProfile()), { loading: true });
  }

  await renderListings(0);
  setupListingsAutoRefresh();
}

async function renderListings(pageIndex = paginationState.pageIndex || 0) {
  currentProfile = loadProfile();
  const result = await loadStoredListingPage({
    pageIndex,
    pageSize: DEFAULT_LISTINGS_PAGE_SIZE,
  });
  const listings = sortListingsForProfile(result.listings, currentProfile);
  renderListingCards(listings);
  renderPagination(result);
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
  if (!options.immediate && now - lastRefreshStartedAt < LISTINGS_REFRESH_THROTTLE_MS) {
    return refreshInFlight;
  }
  if (refreshInFlight) return refreshInFlight;

  lastRefreshStartedAt = now;
  refreshInFlight = renderListings(paginationState.pageIndex || 0)
    .catch((error) => console.warn("교환 글 목록을 새로고침하지 못했습니다.", reason, error))
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

function setupListingsAutoRefresh() {
  if (autoRefreshInitialized) return;
  autoRefreshInitialized = true;

  window.addEventListener("focus", () => queueListingsRefresh("focus", { immediate: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) queueListingsRefresh("visible", { immediate: true });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LISTINGS_REFRESH_KEY) queueListingsRefresh("storage", { immediate: true });
  });
  window.addEventListener(LISTINGS_REFRESH_KEY, () => queueListingsRefresh("local-event", { immediate: true }));

  if (typeof BroadcastChannel !== "undefined") {
    try {
      listingsBroadcastChannel = new BroadcastChannel(LISTINGS_BROADCAST_CHANNEL);
      listingsBroadcastChannel.addEventListener("message", () => {
        queueListingsRefresh("broadcast", { immediate: true });
      });
    } catch {
      listingsBroadcastChannel = null;
    }
  }
}

function renderListingCards(listings, options = {}) {
  listingList.innerHTML = "";

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

function renderPagination(result = {}) {
  paginationState = {
    pageIndex: Number(result.pageIndex || 0),
    totalPages: Math.max(1, Number(result.totalPages || 1)),
    startItem: Number(result.startItem || 0),
    endItem: Number(result.endItem || 0),
    totalCount: Number(result.totalCount || result.loadedCount || result.listings?.length || 0),
  };

  const shouldShow = paginationState.totalCount > 0;
  listingPagination.hidden = !shouldShow;
  if (!shouldShow) return;

  listingPaginationSummary.textContent = `${paginationState.startItem.toLocaleString("ko-KR")}-${paginationState.endItem.toLocaleString("ko-KR")} / ${paginationState.totalCount.toLocaleString("ko-KR")}`;
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

function createListingCard(listing) {
  const highlightSets = createHighlightSets(currentProfile);
  const card = document.createElement("article");
  card.className = "listing-card";

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
  header.append(titleGroup, badge);

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

  const dotButtons = images.map((_, index) => {
    const dotButton = document.createElement("button");
    dotButton.type = "button";
    dotButton.className = "carousel-dot";
    dotButton.dataset.carouselAction = "dot";
    dotButton.dataset.carouselIndex = String(index);
    dotButton.setAttribute("aria-label", `${index + 1}번째 이미지 보기`);
    return dotButton;
  });

  viewport.append(frameButton);
  if (images.length > 1) {
    viewport.append(previousButton, nextButton, counter);
  }

  carousel.append(viewport);
  if (images.length > 1) {
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
    loaded: false,
    startX: 0,
    swiped: false,
  });
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

function handleListingListClick(event) {
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
    showImageModal(state.images, state.activeIndex);
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (action === "previous") stepCarousel(carousel, -1);
  if (action === "next") stepCarousel(carousel, 1);
  if (action === "dot") setCarouselImage(carousel, Number(actionTarget.dataset.carouselIndex));
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
  if (!state || state.images.length <= 1) return;

  const deltaX = event.clientX - state.startX;
  if (Math.abs(deltaX) < 42) return;

  state.swiped = true;
  stepCarousel(carousel, deltaX < 0 ? 1 : -1);
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

function setCarouselImage(carousel, nextIndex) {
  const state = carouselStates.get(carousel);
  if (!state || state.images.length === 0) return;

  state.activeIndex = (nextIndex + state.images.length) % state.images.length;
  const listingImage = state.images[state.activeIndex];
  const source = getListingImageSource(listingImage);
  if (source) {
    if (state.image.getAttribute("src") !== source) state.image.src = source;
  } else {
    state.image.removeAttribute("src");
    renderFallbackPreview(state.fallbackPreview, state.listing, listingImage);
  }
  state.frameButton.classList.toggle("missing-preview", !source);
  state.image.alt = listingImage.name || "첨부 이미지";
  state.frameButton.setAttribute("aria-label", `${state.activeIndex + 1}번째 첨부 이미지 크게 보기`);
  state.counter.textContent = `${state.activeIndex + 1} / ${state.images.length}`;
  state.loaded = true;
  state.dotButtons.forEach((dotButton, index) => {
    dotButton.classList.toggle("active", index === state.activeIndex);
    dotButton.setAttribute("aria-current", index === state.activeIndex ? "true" : "false");
  });

  scheduleAdjacentImagePreload(state.images, state.activeIndex);
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
  const source = getListingImageSource(image);
  if (!source || preloadedImageSources.has(source)) return;

  preloadedImageSources.add(source);
  const imageElement = new Image();
  imageElement.decoding = "async";
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

function showImageModal(images, index = 0) {
  modalImages = Array.isArray(images) ? images.filter(Boolean) : [images].filter(Boolean);
  modalIndex = Math.max(0, Math.min(index, modalImages.length - 1));
  showModalImageAt(modalIndex);
  imageModal.classList.remove("hidden");
}

function showModalImageAt(nextIndex) {
  if (modalImages.length === 0) return;

  modalIndex = (nextIndex + modalImages.length) % modalImages.length;
  const image = modalImages[modalIndex];
  modalImage.src = getListingImageSource(image);
  modalImage.alt = image.name || "확대된 첨부 이미지";
  modalCounter.textContent = `${modalIndex + 1} / ${modalImages.length}`;
  modalPreviousButton.classList.toggle("hidden", modalImages.length <= 1);
  modalNextButton.classList.toggle("hidden", modalImages.length <= 1);
  modalCounter.classList.toggle("hidden", modalImages.length <= 1);
}

function getListingImageSource(image) {
  return image?.url || image?.dataUrl || "";
}

function renderFallbackPreview(container, listing, image) {
  container.innerHTML = "";

  const title = document.createElement("strong");
  title.textContent = image?.generated ? "교환 목록 미리보기" : image?.name || "첨부 이미지";
  container.append(title);

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
  if (Array.isArray(listing?.images) && listing.images.length > 0) return listing.images;
  return listing?.image ? [listing.image] : [];
}

function hideImageModal() {
  imageModal.classList.add("hidden");
  modalImages = [];
  modalIndex = 0;
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

function getItemKey(item) {
  return item?.normalizedKey || normalizeStickerKey(item?.key || item?.rawKey);
}

function normalizeStickerKey(value) {
  return String(value ?? "")
    .replace(/[\s_]+/g, "")
    .toLowerCase();
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
  } catch {
    return null;
  }
}
