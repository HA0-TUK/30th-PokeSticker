import { stickers } from "./catalog-data.js";
import {
  buildListing,
  createCatalogIndex,
  findPersonalListing,
  makeStickerItem,
  normalizeStickerKey,
  parseReferenceInput,
  refreshImportedData,
  validateDraftForPublish,
} from "./importer.js";
import {
  getListingStoreMode,
  loadListings as loadStoredListings,
  savePersonalListing,
} from "./listing-store.js";

const PROFILE_KEY = "pokemon-market-profile";
const TRAINER_KEY = "pokemon-market-trainer";
const MAX_SOURCE_IMAGE_BYTES = 5 * 1024 * 1024;
const STORED_IMAGE_TYPE = "image/webp";
const STORED_IMAGE_QUALITY = 0.82;
const MAX_USER_IMAGES = 10;
const REFERENCE_ASSET_ORIGIN = "public";
const SHEET_WIDTH = 2200;
const SHEET_HEIGHT = 1400;
const SHEET_LAYOUT_VERSION = "compact-left-no-label-v8-original-size";
const koreanNameCollator = new Intl.Collator("ko-KR", {
  sensitivity: "base",
  numeric: false,
});

const catalogIndex = createCatalogIndex(stickers);
let currentImport = refreshImportedData(loadProfile() || createEmptyProfile());
let currentTrainer = loadTrainerInfo();
let currentUserImages = getTrainerUserImages(currentTrainer);
let listingStoreMode = "local";
let listingsCache = [];
let sheetImageCache = {
  signature: "",
  image: null,
};

const elements = {
  catalogCount: document.getElementById("catalogCount"),
  importInput: document.getElementById("importInput"),
  parseButton: document.getElementById("parseButton"),
  clearButton: document.getElementById("clearButton"),
  importMessage: document.getElementById("importMessage"),
  previewMeta: document.getElementById("previewMeta"),
  validationSummary: document.getElementById("validationSummary"),
  previewContent: document.getElementById("previewContent"),
  wantedPreview: document.getElementById("wantedPreview"),
  ownedPreview: document.getElementById("ownedPreview"),
  targetGroup: document.getElementById("targetGroup"),
  stickerSearch: document.getElementById("stickerSearch"),
  searchResults: document.getElementById("searchResults"),
  resetProfileButton: document.getElementById("resetProfileButton"),
  editMessage: document.getElementById("editMessage"),
  publishForm: document.getElementById("publishForm"),
  nickname: document.getElementById("nickname"),
  contact: document.getElementById("contact"),
  bodyText: document.getElementById("bodyText"),
  imageInput: document.getElementById("imageInput"),
  imagePreview: document.getElementById("imagePreview"),
  transferWilling: document.getElementById("transferWilling"),
  publishButton: document.getElementById("publishButton"),
  publishMessage: document.getElementById("publishMessage"),
};

elements.catalogCount.textContent = `${stickers.length.toLocaleString("ko-KR")}개 스티커`;
elements.parseButton.addEventListener("click", parseInput);
elements.clearButton.addEventListener("click", clearImportInput);
elements.previewContent.addEventListener("click", handlePreviewClick);
elements.previewContent.addEventListener("input", handlePreviewInput);
elements.previewContent.addEventListener("change", handlePreviewChange);
elements.targetGroup.addEventListener("change", renderSearchResults);
elements.stickerSearch.addEventListener("input", renderSearchResults);
elements.searchResults.addEventListener("click", handleSearchResultClick);
elements.resetProfileButton.addEventListener("click", resetProfile);
elements.publishForm.addEventListener("submit", preventFormSubmit);
elements.publishForm.addEventListener("input", handleTrainerFormInput);
elements.publishForm.addEventListener("change", handleTrainerFormChange);
elements.publishButton.addEventListener("click", publishListing);
elements.imageInput.addEventListener("change", handleImageInput);
elements.imagePreview.addEventListener("click", handleImagePreviewClick);

applyTrainerInfo(currentTrainer);
renderPreview(currentImport);
renderGroupOptions();
renderImagePreview();
initializeListingStore();
if (loadProfile()) {
  setMessage(elements.importMessage, "저장된 마이페이지 목록을 불러왔습니다.", "success");
}

async function initializeListingStore() {
  listingStoreMode = await getListingStoreMode();
  listingsCache = await loadStoredListings();
  updatePublishAvailability();

  if (listingStoreMode === "firebase" && !elements.importMessage.textContent) {
    setMessage(elements.importMessage, "Firebase 게시글 DB에 연결되었습니다.", "success");
  }
}

async function parseInput() {
  setMessage(elements.importMessage, "");
  setMessage(elements.publishMessage, "");

  try {
    currentImport = refreshImportedData(parseReferenceInput(elements.importInput.value, catalogIndex, { allowJson: false }));
    clearGeneratedImage();
    saveProfile(currentImport);
    renderPreview(currentImport);
    renderGroupOptions();
    markLocalChange(elements.importMessage, "공유 목록을 불러와 마이페이지에 저장했습니다.");
  } catch (error) {
    setMessage(elements.importMessage, error.message, "error");
  }
}

function clearImportInput() {
  elements.importInput.value = "";
  setMessage(elements.importMessage, "입력칸만 비웠습니다. 저장된 마이페이지 목록은 유지됩니다.");
}

function renderPreview(importedData) {
  const { validation } = importedData;
  elements.previewMeta.textContent = `구해요 ${validation.wantedCount}개 · 보유 ${validation.ownedCount}개`;

  renderGroups(elements.wantedPreview, importedData.wantedGroups, "wanted");
  renderGroups(elements.ownedPreview, importedData.ownedGroups, "owned");
  renderValidation(importedData);
  updatePublishAvailability();
}

function renderGroups(container, groups, groupType) {
  container.innerHTML = "";

  for (const group of groups) {
    const article = document.createElement("article");
    article.className = "import-group";

    const header = document.createElement("div");
    header.className = "group-head";

    const title = document.createElement("strong");
    title.textContent = group.label;

    const subtitle = document.createElement("input");
    subtitle.type = "text";
    subtitle.className = "subtitle-input";
    subtitle.placeholder = "메모";
    subtitle.value = group.subtitle || "";
    subtitle.dataset.groupId = group.id;
    subtitle.setAttribute("aria-label", `${group.label} 메모`);

    header.append(title, subtitle);

    const chips = document.createElement("div");
    chips.className = "chips";

    if (group.items.length === 0) {
      const empty = document.createElement("span");
      empty.className = "chip empty";
      empty.textContent = "비어 있음";
      chips.append(empty);
    }

    const sortedItems = group.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => compareItemsByKoreanName(a.item, b.item));

    sortedItems.forEach(({ item, index }) => {
      const chip = document.createElement("span");
      chip.className = `chip ${item.status === "unknown" ? "bad" : ""} ${
        item.status === "duplicate" ? "duplicate" : ""
      }`;

      const label = document.createElement("span");
      label.textContent = item.status === "unknown" ? `${item.rawKey} ?` : item.key;

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "chip-remove";
      removeButton.dataset.action = "remove-sticker";
      removeButton.dataset.groupId = group.id;
      removeButton.dataset.index = String(index);
      removeButton.setAttribute("aria-label", `${label.textContent} 제거`);
      removeButton.textContent = "×";

      chip.append(label, removeButton);
      chips.append(chip);
    });

    article.dataset.groupType = groupType;
    article.append(header, chips);
    container.append(article);
  }
}

function renderValidation(importedData) {
  const validation = validateDraftForPublish(importedData, {
    nickname: "placeholder",
    contact: "placeholder",
  });

  if (validation.ok) {
    elements.validationSummary.classList.add("hidden");
    elements.validationSummary.textContent = "";
    return;
  }

  elements.validationSummary.textContent = validation.errors.join(" ");
  elements.validationSummary.classList.remove("hidden");
}

function renderGroupOptions() {
  const previousValue = elements.targetGroup.value;
  elements.targetGroup.innerHTML = "";

  for (const group of currentImport.wantedGroups) {
    elements.targetGroup.append(createGroupOption(group, "구해요"));
  }

  for (const group of currentImport.ownedGroups) {
    elements.targetGroup.append(createGroupOption(group, "보유중"));
  }

  if ([...elements.targetGroup.options].some((option) => option.value === previousValue)) {
    elements.targetGroup.value = previousValue;
  }

  renderSearchResults();
}

function createGroupOption(group, prefix) {
  const option = document.createElement("option");
  option.value = group.id;
  option.textContent = `${prefix} · ${group.label}`;
  return option;
}

function renderSearchResults() {
  const query = normalizeStickerKey(elements.stickerSearch.value);
  elements.searchResults.innerHTML = "";

  if (!query) {
    const empty = document.createElement("p");
    empty.className = "message compact";
    empty.textContent = "추가할 스티커를 검색하세요.";
    elements.searchResults.append(empty);
    return;
  }

  const results = stickers
    .filter((sticker) => sticker.normalizedKey.includes(query) || normalizeStickerKey(sticker.key).includes(query))
    .sort(compareStickersByKoreanName)
    .slice(0, 36);

  if (results.length === 0) {
    const empty = document.createElement("p");
    empty.className = "message compact";
    empty.textContent = "검색 결과가 없습니다.";
    elements.searchResults.append(empty);
    return;
  }

  for (const sticker of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result-button";
    button.dataset.normalizedKey = sticker.normalizedKey;

    const thumbnail = document.createElement("img");
    thumbnail.src = getStickerImageUrl(sticker);
    thumbnail.alt = "";
    thumbnail.loading = "lazy";
    thumbnail.decoding = "async";

    const label = document.createElement("span");
    label.textContent = sticker.key;

    button.append(thumbnail, label);
    elements.searchResults.append(button);
  }
}

async function handleSearchResultClick(event) {
  const button = event.target.closest("[data-normalized-key]");
  if (!button) return;

  const sticker = catalogIndex.byNormalizedKey.get(button.dataset.normalizedKey);
  if (!sticker) return;

  const group = findGroup(elements.targetGroup.value);
  if (!group) return;

  const category = group.id.startsWith("priority-") ? "wanted" : "owned";
  const categoryGroups = category === "wanted" ? currentImport.wantedGroups : currentImport.ownedGroups;
  const alreadyExists = categoryGroups.some((candidateGroup) =>
    candidateGroup.items.some((item) => item.normalizedKey === sticker.normalizedKey),
  );

  if (alreadyExists) {
    setMessage(elements.editMessage, "이미 같은 목록 영역에 있는 스티커입니다.", "error");
    return;
  }

  group.items.push(makeStickerItem(sticker, category));
  persistProfile("스티커를 추가했습니다.");
}

async function handlePreviewClick(event) {
  const button = event.target.closest("[data-action='remove-sticker']");
  if (!button) return;

  const group = findGroup(button.dataset.groupId);
  if (!group) return;

  group.items.splice(Number(button.dataset.index), 1);
  persistProfile("스티커를 제거했습니다.");
}

function handlePreviewInput(event) {
  if (!event.target.classList.contains("subtitle-input")) return;

  const group = findGroup(event.target.dataset.groupId);
  if (!group) return;

  group.subtitle = event.target.value;
  currentImport = refreshImportedData(currentImport);
  saveProfile(currentImport);
}

async function handlePreviewChange(event) {
  if (!event.target.classList.contains("subtitle-input")) return;
  markLocalChange(elements.editMessage, "메모를 저장했습니다.");
}

function findGroup(groupId) {
  return [...currentImport.wantedGroups, ...currentImport.ownedGroups].find((group) => group.id === groupId);
}

function persistProfile(message) {
  currentImport = refreshImportedData(currentImport);
  clearGeneratedImage();
  saveProfile(currentImport);
  renderPreview(currentImport);
  renderGroupOptions();
  markLocalChange(elements.editMessage, message);
}

function resetProfile() {
  if (!window.confirm("마이페이지의 구해요/보유중 목록을 모두 비울까요?")) return;

  currentImport = createEmptyProfile();
  clearGeneratedImage();
  localStorage.removeItem(PROFILE_KEY);
  elements.importInput.value = "";
  elements.stickerSearch.value = "";
  renderPreview(currentImport);
  renderGroupOptions();
  const message = getExistingPersonalListing()
    ? "마이페이지 목록을 비웠습니다. 기존 게시글은 그대로 두었습니다."
    : "마이페이지 목록을 비웠습니다.";
  setMessage(elements.editMessage, message);
}

function handleTrainerFormInput(event) {
  if (!isTrainerFormField(event.target)) return;
  saveTrainerFromForm();
  updatePublishAvailability();
}

async function handleTrainerFormChange(event) {
  if (!isTrainerFormField(event.target)) return;
  saveTrainerFromForm();
  markLocalChange(elements.publishMessage, "트레이너 정보를 저장했습니다.");
}

function isTrainerFormField(target) {
  return [
    elements.nickname,
    elements.contact,
    elements.bodyText,
    elements.transferWilling,
  ].includes(target);
}

async function handleImageInput() {
  setMessage(elements.publishMessage, "");
  const files = [...(elements.imageInput.files || [])];

  if (files.length === 0) {
    elements.imageInput.value = "";
    return;
  }

  if (currentUserImages.length + files.length > MAX_USER_IMAGES) {
    elements.imageInput.value = "";
    renderImagePreview();
    setMessage(
      elements.publishMessage,
      `추가 이미지는 최대 ${MAX_USER_IMAGES}장까지 첨부할 수 있습니다. 현재 ${currentUserImages.length}장이 있습니다.`,
      "error",
    );
    return;
  }

  const invalidFile = files.find((file) => !file.type.startsWith("image/"));
  if (invalidFile) {
    elements.imageInput.value = "";
    renderImagePreview();
    setMessage(elements.publishMessage, "이미지 파일만 첨부할 수 있습니다.", "error");
    return;
  }

  const oversizedFile = files.find((file) => file.size > MAX_SOURCE_IMAGE_BYTES);
  if (oversizedFile) {
    elements.imageInput.value = "";
    renderImagePreview();
    setMessage(elements.publishMessage, "각 이미지는 5MB 이하만 첨부할 수 있습니다.", "error");
    return;
  }

  const startIndex = currentUserImages.length;
  const nextUserImages = await Promise.all(
    files.map((file, index) => createUserImageAttachment(file, startIndex + index)),
  );

  currentUserImages = reindexUserImages([...currentUserImages, ...nextUserImages]);
  elements.imageInput.value = "";
  renderImagePreview();
  saveTrainerFromForm();
  markLocalChange(elements.publishMessage, "추가 이미지를 첨부 목록에 저장했습니다.");
}

function renderImagePreview() {
  elements.imagePreview.innerHTML = "";

  if (currentUserImages.length === 0) {
    elements.imagePreview.classList.add("hidden");
    return;
  }

  for (const [index, userImage] of currentUserImages.entries()) {
    const item = document.createElement("div");
    item.className = "image-preview-item";

    const thumbnail = document.createElement("div");
    thumbnail.className = "image-preview-thumb";

    const image = document.createElement("img");
    image.src = userImage.url || userImage.dataUrl;
    image.alt = userImage.name || "첨부 이미지";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "image-preview-remove";
    removeButton.dataset.action = "remove-user-image";
    removeButton.dataset.index = String(index);
    removeButton.setAttribute("aria-label", `${userImage.name || "첨부 이미지"} 삭제`);
    removeButton.textContent = "×";

    const caption = document.createElement("span");
    caption.textContent = `${index + 1}. ${userImage.name || "첨부 이미지"}`;

    thumbnail.append(image, removeButton);
    item.append(thumbnail, caption);
    elements.imagePreview.append(item);
  }
  elements.imagePreview.classList.remove("hidden");
}

function handleImagePreviewClick(event) {
  const button = event.target.closest("[data-action='remove-user-image']");
  if (!button) return;

  const index = Number(button.dataset.index);
  if (!Number.isInteger(index) || index < 0 || index >= currentUserImages.length) return;

  const [removedImage] = currentUserImages.splice(index, 1);
  currentUserImages = reindexUserImages(currentUserImages);
  renderImagePreview();
  saveTrainerFromForm();
  markLocalChange(elements.publishMessage, `${removedImage?.name || "추가 이미지"}를 첨부 목록에서 제거했습니다.`);
}

function preventFormSubmit(event) {
  event.preventDefault();
}

async function publishListing(event) {
  event.preventDefault();
  await saveOrUpdatePersonalListing(elements.publishMessage);
}

function updatePublishAvailability() {
  const validation = validateDraftForPublish(currentImport, {
    nickname: "placeholder",
    contact: "placeholder",
  });
  elements.publishButton.disabled = !validation.ok;
  elements.publishButton.textContent = getExistingPersonalListing() ? "게시글 수정" : "검토 후 게시";
}

function markLocalChange(messageElement, baseMessage) {
  saveTrainerFromForm();
  const existingListing = getExistingPersonalListing();

  setMessage(
    messageElement,
    existingListing ? `${baseMessage} 기존 게시글에는 아직 반영되지 않았습니다. 게시글 수정 버튼을 누르면 반영됩니다.` : baseMessage,
    "success",
  );
  updatePublishAvailability();
}

async function saveOrUpdatePersonalListing(messageElement, successMessage = "") {
  setMessage(messageElement, "");

  try {
    const formData = await getPublishFormData();
    renderImagePreview();
    const draftListing = buildListing(currentImport, formData);
    const result = await savePersonalListing(draftListing, formData, {
      knownListingId: currentTrainer.listingId,
    });

    listingsCache = result.listings;
    currentUserImages = getListingUserImages(result.listing);
    renderImagePreview();
    saveTrainerFromForm(result.listing.id);
    updatePublishAvailability();

    setMessage(
      messageElement,
      successMessage || (result.action === "updated" ? "기존 교환 글을 수정했습니다." : "교환 글을 저장했습니다."),
      "success",
    );
  } catch (error) {
    setMessage(messageElement, error.message, "error");
  }
}

function getExistingPersonalListing() {
  return findPersonalListing(listingsCache, getFormData(), {
    knownListingId: currentTrainer.listingId,
  });
}

function applyTrainerInfo(trainer) {
  elements.nickname.value = trainer.nickname ?? "";
  elements.contact.value = trainer.contact ?? "";
  elements.bodyText.value = trainer.body ?? "";
  elements.transferWilling.checked = Boolean(trainer.transferWilling);
}

function saveTrainerFromForm(listingId = currentTrainer.listingId) {
  currentTrainer = {
    listingId,
    nickname: elements.nickname.value,
    contact: elements.contact.value,
    body: elements.bodyText.value,
    transferWilling: elements.transferWilling.checked,
    images: currentUserImages,
  };
  saveTrainerInfo(currentTrainer);
}

function createEmptyProfile() {
  const profile = {
    source: "mypage",
    importedAt: new Date().toISOString(),
    haveLayoutMode: "split",
    wantedGroups: [0, 1, 2, 3].map((index) => ({
      id: `priority-${index}`,
      label: `${index + 1}순위`,
      subtitle: "",
      items: [],
    })),
    ownedGroups: [0, 1, 2, 3].map((index) => ({
      id: `have-split-${index}`,
      label: `보유 ${index + 1}`,
      subtitle: "",
      items: [],
    })),
    validation: {
      wantedCount: 0,
      ownedCount: 0,
      unknownCount: 0,
      duplicateCount: 0,
    },
    rawData: null,
  };

  return refreshImportedData(profile);
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

function loadTrainerInfo() {
  try {
    return {
      listingId: "",
      nickname: "",
      contact: "",
      body: "",
      transferWilling: false,
      images: [],
      ...JSON.parse(localStorage.getItem(TRAINER_KEY) || "{}"),
    };
  } catch {
    return {
      listingId: "",
      nickname: "",
      contact: "",
      body: "",
      transferWilling: false,
      images: [],
    };
  }
}

function saveTrainerInfo(trainer) {
  localStorage.setItem(TRAINER_KEY, JSON.stringify(trainer));
}

function getTrainerUserImages(trainer) {
  const images = Array.isArray(trainer?.images)
    ? trainer.images
    : trainer?.image
      ? [trainer.image]
      : [];

  return reindexUserImages(images.filter((image) => image && !image.generated));
}

function getListingUserImages(listing) {
  const images = Array.isArray(listing?.images)
    ? listing.images
    : listing?.image
      ? [listing.image]
      : [];

  return reindexUserImages(images.filter((image) => image && !image.generated));
}

function reindexUserImages(images) {
  return (images || []).filter(Boolean).slice(0, MAX_USER_IMAGES).map((image, index) => ({
    ...image,
    generated: false,
    order: index + 1,
  }));
}

async function getPublishFormData() {
  const formData = getFormData();
  const tradeSheetImage = await getReusableProfileSheetImage(currentImport);
  formData.images = [tradeSheetImage, ...currentUserImages];
  formData.image = formData.images[0];

  return formData;
}

function getFormData() {
  return {
    nickname: elements.nickname.value,
    contact: elements.contact.value,
    body: elements.bodyText.value,
    images: currentUserImages,
    image: currentUserImages[0] ?? null,
    transferWilling: elements.transferWilling.checked,
  };
}

function clearGeneratedImage() {
  saveTrainerFromForm();
}

async function createProfileSheetImage(profile, options = {}) {
  const { useImages = true } = options;
  const profileSignature = getProfileSheetSignature(profile);
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_HEIGHT;

  const context = canvas.getContext("2d");
  await drawReferenceBackground(context);
  await drawReferenceColumn(context, {
    title: "구해요",
    groups: profile.wantedGroups,
    type: "wanted",
    x: 40,
    y: 40,
    width: 1040,
    height: 1320,
    accent: "#facc15",
    glow: "rgba(250, 204, 21, 0.55)",
    useImages,
  });
  await drawReferenceColumn(context, {
    title: "보유중",
    groups: profile.ownedGroups,
    type: "owned",
    x: 1120,
    y: 40,
    width: 1040,
    height: 1320,
    accent: "#4ade80",
    glow: "rgba(74, 222, 128, 0.48)",
    useImages,
  });

  let storageImage;
  try {
    storageImage = await canvasToStorageImage(canvas);
  } catch (error) {
    if (useImages) return createProfileSheetImage(profile, { useImages: false });
    throw error;
  }

  return {
    name: storageImage.name,
    type: storageImage.type,
    dataUrl: storageImage.dataUrl,
    size: storageImage.size,
    width: storageImage.width,
    height: storageImage.height,
    generated: true,
    compressed: false,
    resolutionReduced: storageImage.width < SHEET_WIDTH || storageImage.height < SHEET_HEIGHT,
    generatedAt: new Date().toISOString(),
    profileSignature,
  };
}

async function getReusableProfileSheetImage(profile) {
  const profileSignature = getProfileSheetSignature(profile);
  const existingImage = getReusableExistingSheetImage(profileSignature);

  if (existingImage) return existingImage;
  if (sheetImageCache.signature === profileSignature && sheetImageCache.image) return sheetImageCache.image;

  const image = await createProfileSheetImage(profile);
  sheetImageCache = {
    signature: profileSignature,
    image,
  };
  return image;
}

function getReusableExistingSheetImage(profileSignature) {
  const existingListing = getExistingPersonalListing();
  const images = Array.isArray(existingListing?.images)
    ? existingListing.images
    : existingListing?.image
      ? [existingListing.image]
      : [];

  return images.find((image) =>
    image?.generated
      && image.profileSignature === profileSignature
      && (image.url || image.dataUrl),
  ) ?? null;
}

function getProfileSheetSignature(profile) {
  const compactGroups = (groups) =>
    (groups || []).map((group) => ({
      id: group.id,
      subtitle: group.subtitle || "",
      items: (group.items || []).map((item) => item.normalizedKey || item.key || item.rawKey || ""),
    }));

  return JSON.stringify({
    version: SHEET_LAYOUT_VERSION,
    wanted: compactGroups(profile?.wantedGroups),
    owned: compactGroups(profile?.ownedGroups),
  });
}

async function canvasToStorageImage(canvas) {
  return canvasToStorageImageWithNames(canvas, {
    baseName: "poke30-tra-compatible-sheet",
  });
}

async function canvasToStorageImageWithNames(canvas, options = {}) {
  const baseName = sanitizeBaseFileName(options.baseName || "image");
  const type = options.type || STORED_IMAGE_TYPE;
  const quality = options.quality ?? STORED_IMAGE_QUALITY;
  const extension = getImageExtension(type);
  const blob = await canvasToBlob(canvas, type, quality);

  if (blob) {
    return {
      name: `${baseName}.${extension}`,
      type: blob.type || type,
      dataUrl: await blobToDataUrl(blob),
      size: blob.size,
      width: canvas.width,
      height: canvas.height,
    };
  }

  return {
    name: `${baseName}.png`,
    type: "image/png",
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}

function getImageExtension(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  return "webp";
}

function sanitizeBaseFileName(name) {
  return String(name)
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
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
    reader.addEventListener("error", () => reject(new Error("이미지 압축 중 오류가 발생했습니다.")));
    reader.readAsDataURL(blob);
  });
}

async function createUserImageAttachment(file, index) {
  const dimensions = await getFileImageDimensions(file);
  return {
    name: file.name || `user-image-${index + 1}`,
    type: file.type || "image/png",
    dataUrl: await blobToDataUrl(file),
    size: file.size,
    width: dimensions.width,
    height: dimensions.height,
    originalName: file.name,
    originalType: file.type,
    originalSize: file.size,
    generated: false,
    compressed: false,
    resolutionReduced: false,
    order: index + 1,
  };
}

function getFileImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({
        width: image.naturalWidth || null,
        height: image.naturalHeight || null,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 압축하는 중 오류가 발생했습니다."));
    };
    image.src = url;
  });
}

function removeFileExtension(name) {
  return String(name ?? "").replace(/\.[^.]+$/, "");
}

async function drawReferenceBackground(context) {
  context.fillStyle = "#1f2937";
  context.fillRect(0, 0, SHEET_WIDTH, SHEET_HEIGHT);

  const background = await loadCanvasImage(`${REFERENCE_ASSET_ORIGIN}/base/top.png`);
  if (background) {
    context.save();
    context.globalAlpha = 0.1;
    drawCoverImage(context, background, 0, 0, SHEET_WIDTH, SHEET_HEIGHT);
    context.restore();
  }
}

async function drawReferenceColumn(context, options) {
  const { title, groups, type, x, y, width, height, accent, glow, useImages } = options;

  context.save();
  context.shadowColor = glow;
  context.shadowBlur = 14;
  context.fillStyle = accent;
  context.font = "italic 800 56px Arial, 'Noto Sans KR', sans-serif";
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillText(title, x, y);
  context.restore();

  const boxY = y + 86;
  const boxHeightTotal = height - 86;
  const gap = 8;
  const groupLayouts = getReferenceGroupLayouts(groups, {
    type,
    y: boxY,
    height: boxHeightTotal,
    gap,
  });

  for (const [index, group] of groups.entries()) {
    const groupLayout = groupLayouts[index];
    const groupY = groupLayout.y;
    const groupHeight = groupLayout.height;
    drawDashedReferenceBox(context, x, groupY, width, groupHeight);

    const headerText = getReferenceGroupHeader(group, index, type);
    const headerColor = getReferenceGroupColor(index, type, accent);
    const hasHeader = Boolean(headerText);
    const contentTop = groupY + (hasHeader ? 62 : 24);
    const contentHeight = groupHeight - (hasHeader ? 82 : 48);

    if (hasHeader) {
      context.save();
      context.shadowColor = headerColor.glow;
      context.shadowBlur = headerColor.blur;
      context.fillStyle = headerColor.color;
      context.font = "800 28px Arial, 'Noto Sans KR', sans-serif";
      context.textBaseline = "top";
      context.textAlign = "left";
      context.fillText(headerText, x + 24, groupY + 18);
      context.restore();
    }

    if (group.subtitle && type === "wanted") {
      context.fillStyle = "rgba(248, 250, 252, 0.65)";
      context.font = "700 18px Arial, 'Noto Sans KR', sans-serif";
      context.textBaseline = "top";
      context.textAlign = "right";
      context.fillText(truncateCanvasText(context, group.subtitle, 420), x + width - 24, groupY + 25);
    }

    await drawReferenceItems(context, group.items, x + 24, contentTop, width - 48, contentHeight, useImages);
  }
}

function getReferenceGroupLayouts(groups, options) {
  const { type, y, height, gap } = options;
  const groupCount = Math.max(groups.length, 1);
  const totalGap = gap * Math.max(0, groupCount - 1);
  const availableHeight = Math.max(1, height - totalGap);
  const preparedGroups = groups.map((group, index) => {
    const hasHeader = Boolean(getReferenceGroupHeader(group, index, type));
    const itemCount = group.items?.length || 0;
    const isEmpty = itemCount === 0;

    return {
      hasHeader,
      itemCount,
      isEmpty,
      minHeight: getReferenceGroupMinHeight(hasHeader, isEmpty),
      weight: isEmpty ? 0 : Math.max(1, Math.sqrt(itemCount)),
    };
  });

  const minHeightTotal = preparedGroups.reduce((sum, group) => sum + group.minHeight, 0);
  let heights;

  if (minHeightTotal >= availableHeight) {
    const equalHeight = availableHeight / groupCount;
    heights = preparedGroups.map((group) => Math.max(42, Math.min(group.minHeight, equalHeight)));
  } else {
    const weightedGroups = preparedGroups.filter((group) => group.weight > 0);
    const weightTotal = weightedGroups.reduce((sum, group) => sum + group.weight, 0);
    const extraHeight = availableHeight - minHeightTotal;
    heights = preparedGroups.map((group) => {
      if (!weightTotal || group.weight === 0) return group.minHeight;
      return group.minHeight + extraHeight * (group.weight / weightTotal);
    });
  }

  let cursorY = y;
  return heights.map((groupHeight, index) => {
    const layout = {
      y: cursorY,
      height: groupHeight,
    };
    cursorY += groupHeight + gap;
    return layout;
  });
}

function getReferenceGroupMinHeight(hasHeader, isEmpty) {
  if (isEmpty) return hasHeader ? 82 : 54;
  return hasHeader ? 142 : 118;
}

function drawDashedReferenceBox(context, x, y, width, height) {
  context.save();
  context.fillStyle = "rgba(255, 255, 255, 0.05)";
  context.strokeStyle = "rgba(255, 255, 255, 0.28)";
  context.lineWidth = 4;
  context.setLineDash([18, 13]);
  drawRoundedPath(context, x, y, width, height, 16);
  context.fill();
  context.stroke();
  context.restore();
}

async function drawReferenceItems(context, items, x, y, width, height, useImages) {
  if (!items.length || width <= 0 || height <= 0) return;

  const sortedItems = [...items].sort(compareItemsByKoreanName);
  const layout = getReferenceGridLayout(sortedItems.length, width, height);
  const total = Math.min(sortedItems.length, layout.visibleCount);

  for (let index = 0; index < total; index += 1) {
    const item = sortedItems[index];
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const cellX = x + column * (layout.cellWidth + layout.gap);
    const cellY = y + row * (layout.cellHeight + layout.gap);
    await drawReferenceItemCard(context, item, cellX, cellY, layout.cellWidth, layout.cellHeight, useImages);
  }

  if (total < sortedItems.length) {
    context.font = "800 20px Arial, 'Noto Sans KR', sans-serif";
    context.textAlign = "right";
    context.textBaseline = "bottom";
    context.fillStyle = "rgba(248, 250, 252, 0.74)";
    context.fillText(`+${sortedItems.length - total}개`, x + width, y + height);
  }
}

async function drawReferenceItemCard(context, item, x, y, width, height, useImages) {
  const compact = width < 68 || height < 84;
  const radius = compact ? 7 : 12;
  const paddingX = Math.max(compact ? 3 : 6, Math.min(9, width * 0.07));
  const paddingTop = Math.max(compact ? 3 : 5, Math.min(6, height * 0.05));
  const imageBoxHeight = Math.max(10, height - paddingTop * 2);
  const imageBoxWidth = Math.max(16, width - paddingX * 2);
  const imageBoxX = x + paddingX;
  const imageBoxY = y + paddingTop;

  drawRoundedRect(context, x, y, width, height, radius, "rgba(17, 24, 39, 0.72)", "rgba(255, 255, 255, 0.12)", 1);

  const imageUrl = getStickerImageUrl(item);
  const image = useImages && imageUrl ? await loadCanvasImage(imageUrl) : null;

  if (image) {
    drawContainImage(context, image, imageBoxX, imageBoxY, imageBoxWidth, imageBoxHeight, {
      alignX: "left",
      allowUpscale: false,
    });
  } else {
    const fallbackSize = Math.min(imageBoxWidth, imageBoxHeight * 0.92);
    context.fillStyle = "rgba(248, 250, 252, 0.18)";
    drawRoundedPath(context, imageBoxX, imageBoxY, fallbackSize, fallbackSize, radius);
    context.fill();
  }
}

function getReferenceGridLayout(count, width, height) {
  const density = getReferenceGridDensity(count);
  const { gap, maxWidth, maxHeight, minWidth, minHeight } = density;
  const maxColumns = Math.min(count, Math.max(1, Math.floor((width + gap) / (minWidth + gap))));
  let bestFit = null;

  for (let columns = maxColumns; columns >= 1; columns -= 1) {
    const rows = Math.ceil(count / columns);
    const rawCellWidth = (width - gap * (columns - 1)) / columns;
    const rawCellHeight = (height - gap * (rows - 1)) / rows;
    if (rawCellWidth < minWidth || rawCellHeight < minHeight) continue;

    const cellWidth = Math.min(maxWidth, rawCellWidth);
    const cellHeight = Math.min(maxHeight, rawCellHeight);
    const emptyCells = columns * rows - count;
    const score = columns * 100000 - rows * 1000 - emptyCells * 100 + cellWidth * cellHeight;
    if (!bestFit || score > bestFit.score) {
      bestFit = {
        columns,
        rows,
        cellWidth,
        cellHeight,
        score,
        visibleCount: count,
      };
    }
  }

  if (bestFit) {
    return {
      columns: bestFit.columns,
      rows: bestFit.rows,
      cellWidth: bestFit.cellWidth,
      cellHeight: bestFit.cellHeight,
      gap,
      visibleCount: bestFit.visibleCount,
    };
  }

  let bestOverflow = null;
  for (let columns = maxColumns; columns >= 1; columns -= 1) {
    const rows = Math.max(1, Math.floor((height + gap) / (minHeight + gap)));
    const rawCellWidth = (width - gap * (columns - 1)) / columns;
    const rawCellHeight = (height - gap * (rows - 1)) / rows;
    if (rawCellWidth < minWidth || rawCellHeight < minHeight) continue;

    const visibleCount = columns * rows;
    const cellWidth = Math.min(maxWidth, rawCellWidth);
    const cellHeight = Math.min(maxHeight, rawCellHeight);
    const score = visibleCount * 100000 + columns * 1000 + Math.min(cellHeight, maxHeight);
    if (!bestOverflow || score > bestOverflow.score) {
      bestOverflow = {
        columns,
        rows,
        cellWidth,
        cellHeight,
        score,
        visibleCount,
      };
    }
  }

  return {
    columns: bestOverflow?.columns || 1,
    rows: bestOverflow?.rows || 1,
    cellWidth: bestOverflow?.cellWidth || Math.max(1, width),
    cellHeight: bestOverflow?.cellHeight || Math.max(1, height),
    gap,
    visibleCount: Math.max(1, bestOverflow?.visibleCount || 1),
  };
}

function getReferenceGridDensity(count) {
  if (count > 120) {
    return { gap: 4, maxWidth: 86, maxHeight: 98, minWidth: 36, minHeight: 44 };
  }

  if (count > 72) {
    return { gap: 5, maxWidth: 96, maxHeight: 112, minWidth: 42, minHeight: 52 };
  }

  if (count > 36) {
    return { gap: 6, maxWidth: 108, maxHeight: 126, minWidth: 50, minHeight: 62 };
  }

  if (count > 18) {
    return { gap: 8, maxWidth: 122, maxHeight: 142, minWidth: 62, minHeight: 76 };
  }

  return { gap: 10, maxWidth: 132, maxHeight: 154, minWidth: 76, minHeight: 92 };
}

function getReferenceGroupHeader(group, index, type) {
  if (type === "wanted") return `${index + 1}순위`;
  return group.subtitle || "";
}

function getReferenceGroupColor(index, type, fallback) {
  if (type === "owned") {
    return {
      color: fallback,
      glow: "rgba(74, 222, 128, 0.55)",
      blur: 10,
    };
  }

  const colors = [
    ["#fde047", "rgba(250, 204, 21, 0.78)", 10],
    ["#e2e8f0", "rgba(203, 213, 225, 0.72)", 9],
    ["#f59e0b", "rgba(217, 119, 6, 0.72)", 9],
    ["rgba(255, 255, 255, 0.5)", "rgba(255, 255, 255, 0.28)", 4],
  ];
  const [color, glow, blur] = colors[index] || colors[3];

  return { color, glow, blur };
}

function compareStickersByKoreanName(a, b) {
  return compareDisplayNames(a?.name || a?.key, b?.name || b?.key);
}

function compareItemsByKoreanName(a, b) {
  return compareDisplayNames(getSortableItemName(a), getSortableItemName(b));
}

function compareDisplayNames(a, b) {
  return koreanNameCollator.compare(String(a || ""), String(b || ""));
}

function getSortableItemName(item) {
  const value = String(item?.name || item?.key || item?.rawKey || "");
  return value.replace(/^\s*\d+\./, "").trim();
}

function getStickerImageUrl(item) {
  if (!item?.imagePath) return "";
  if (/^https?:\/\//.test(item.imagePath)) return item.imagePath;
  return `${REFERENCE_ASSET_ORIGIN}${item.imagePath}`;
}

const canvasImageCache = new Map();

function loadCanvasImage(src) {
  if (!src) return Promise.resolve(null);
  if (canvasImageCache.has(src)) return canvasImageCache.get(src);

  const promise = new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });

  canvasImageCache.set(src, promise);
  return promise;
}

function drawCoverImage(context, image, x, y, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawContainImage(context, image, x, y, width, height, options = {}) {
  const { alignX = "center", alignY = "center", allowUpscale = true } = options;
  const scale = Math.min(
    allowUpscale ? Number.POSITIVE_INFINITY : 1,
    width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const offsetX = alignX === "left" ? 0 : alignX === "right" ? width - drawWidth : (width - drawWidth) / 2;
  const offsetY = alignY === "top" ? 0 : alignY === "bottom" ? height - drawHeight : (height - drawHeight) / 2;
  context.drawImage(image, x + offsetX, y + offsetY, drawWidth, drawHeight);
}

function drawRoundedPath(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function drawRoundedRect(context, x, y, width, height, radius, fill, stroke, lineWidth = 1) {
  drawRoundedPath(context, x, y, width, height, radius);
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = lineWidth;
  context.strokeStyle = stroke;
  context.stroke();
}

function truncateCanvasText(context, text, maxWidth) {
  const value = String(text ?? "");
  if (context.measureText(value).width <= maxWidth) return value;

  let result = value;
  while (result.length > 1 && context.measureText(result + "...").width > maxWidth) {
    result = result.slice(0, -1);
  }
  return result + "...";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("이미지를 읽는 중 오류가 발생했습니다.")));
    reader.readAsDataURL(file);
  });
}

function setMessage(element, text, kind = "") {
  element.textContent = text;
  element.classList.remove("error", "success");
  if (kind) element.classList.add(kind);
}
