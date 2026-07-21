import { getCatalogIdFromImagePath, getItemKey } from "./importer.js";

export const SHEET_WIDTH = 2200;
export const SHEET_HEIGHT = 1400;
export const SHEET_LAYOUT_VERSION = "compact-left-no-label-v15-roomier-icon-cells";
export const SHEET_CARD_RENDER_PURPOSE = "card";
export const SHEET_FULL_RENDER_PURPOSE = "full";
export const SHEET_RENDER_CACHE_VERSION = "atlas-v1";

const SHEET_MAX_ITEMS_PER_ROW = 7;
const SHEET_MAX_ITEM_CELL_WIDTH = 156;
const SHEET_MAX_ITEM_CELL_HEIGHT = 172;
const SHEET_MIN_ITEM_CELL_HEIGHT = 132;
const REFERENCE_ASSET_ORIGIN = "public";
const ICON_ATLAS_ORIGIN = `${REFERENCE_ASSET_ORIGIN}/icon-atlas`;
const SHEET_IMAGE_TYPE = "image/webp";
const SHEET_IMAGE_QUALITY = 0.82;
const SHEET_RENDER_PURPOSES = {
  [SHEET_CARD_RENDER_PURPOSE]: {
    purpose: SHEET_CARD_RENDER_PURPOSE,
    atlasVariant: "card",
    scale: 0.4,
    quality: 0.74,
  },
  [SHEET_FULL_RENDER_PURPOSE]: {
    purpose: SHEET_FULL_RENDER_PURPOSE,
    atlasVariant: "full",
    scale: 1,
    quality: SHEET_IMAGE_QUALITY,
  },
};
const koreanNameCollator = new Intl.Collator("ko-KR", {
  sensitivity: "base",
  numeric: false,
});
const canvasImageCache = new Map();
let iconAtlasManifestPromise = null;

export function createProfileSheetPages(profile) {
  const remainingWantedGroups = cloneSheetGroups(profile?.wantedGroups);
  const remainingOwnedGroups = cloneSheetGroups(profile?.ownedGroups);
  const pages = [];
  let guard = 0;

  do {
    const layoutWantedGroups = getNonEmptySheetGroups(remainingWantedGroups);
    const layoutOwnedGroups = getNonEmptySheetGroups(remainingOwnedGroups);
    const wantedGroups = takeSheetColumnPageGroups(remainingWantedGroups, layoutWantedGroups, "wanted");
    const ownedGroups = takeSheetColumnPageGroups(remainingOwnedGroups, layoutOwnedGroups, "owned");

    pages.push({
      ...profile,
      wantedGroups,
      ownedGroups,
      layoutWantedGroups,
      layoutOwnedGroups,
    });

    guard += 1;
  } while (guard < 80 && (hasSheetItems(remainingWantedGroups) || hasSheetItems(remainingOwnedGroups)));

  return pages.length > 0
    ? pages
    : [{
        ...profile,
        wantedGroups: cloneSheetGroups(profile?.wantedGroups),
        ownedGroups: cloneSheetGroups(profile?.ownedGroups),
      }];
}

export function getProfileSheetSignature(profile) {
  const compactGroups = (groups) =>
    (groups || []).map((group) => ({
      id: group.id,
      subtitle: group.subtitle || "",
      items: (group.items || []).map((item) => getItemKey(item)),
    }));

  return JSON.stringify({
    version: SHEET_LAYOUT_VERSION,
    wanted: compactGroups(profile?.wantedGroups),
    owned: compactGroups(profile?.ownedGroups),
  });
}

export function createProfileSheetImageDescriptors(profile, options = {}) {
  const renderOptions = getSheetRenderOptions(options);
  const pages = createProfileSheetPages(profile);
  const profileSignature = getProfileSheetSignature(profile);

  return pages.map((_, pageIndex) => ({
    name: getProfileSheetImageName(pageIndex, pages.length),
    type: SHEET_IMAGE_TYPE,
    width: getScaledSheetSize(SHEET_WIDTH, renderOptions.scale),
    height: getScaledSheetSize(SHEET_HEIGHT, renderOptions.scale),
    generated: true,
    localGenerated: true,
    profileSignature,
    sheetLayoutVersion: SHEET_LAYOUT_VERSION,
    sheetRenderPurpose: renderOptions.purpose,
    sheetRenderScale: renderOptions.scale,
    sheetRenderCacheVersion: SHEET_RENDER_CACHE_VERSION,
    sheetPageIndex: pageIndex,
    sheetPageCount: pages.length,
    order: pageIndex,
  }));
}

export async function renderProfileSheetImageBlob(profile, options = {}) {
  const {
    pageIndex = 0,
    useImages = true,
    type = SHEET_IMAGE_TYPE,
    quality,
  } = options;
  const renderOptions = getSheetRenderOptions(options);
  const pages = createProfileSheetPages(profile);
  const selectedPageIndex = clampInteger(pageIndex, 0, Math.max(0, pages.length - 1));
  const pageProfile = pages[selectedPageIndex] || pages[0] || profile;

  try {
    return await renderProfileSheetPageBlob(pageProfile, {
      pageIndex: selectedPageIndex,
      pageCount: pages.length,
      useImages,
      type,
      quality: Number.isFinite(Number(quality)) ? Number(quality) : renderOptions.quality,
      renderOptions,
    });
  } catch (error) {
    if (useImages) {
      return renderProfileSheetImageBlob(profile, {
        ...options,
        pageIndex: selectedPageIndex,
        useImages: false,
      });
    }

    throw error;
  }
}

function cloneSheetGroups(groups = []) {
  return (groups || []).map((group, index) => ({
    ...group,
    sheetGroupIndex: Number.isInteger(Number(group?.sheetGroupIndex)) ? Number(group.sheetGroupIndex) : index,
    items: [...(group?.items || [])],
  }));
}

function getNonEmptySheetGroups(groups = []) {
  return (groups || []).filter((group) => (group?.items || []).length > 0);
}

function hasSheetItems(groups = []) {
  return (groups || []).some((group) => (group?.items || []).length > 0);
}

function takeSheetColumnPageGroups(remainingGroups, layoutGroups, type) {
  const layouts = getReferenceGroupLayouts(layoutGroups, {
    type,
    y: 40 + 86,
    height: 1320 - 86,
    gap: 8,
  });

  return getNonEmptySheetGroups(remainingGroups).map((group, index) => {
    const remainingItems = group.items || [];
    const remainingIndex = remainingGroups.findIndex((candidate) => getSheetGroupIndex(candidate, -1) === getSheetGroupIndex(group, index));
    const layout = layouts[index] || { height: getReferenceGroupMinHeight(Boolean(getReferenceGroupHeader(group, index, type)), remainingItems.length === 0) };
    const hasHeader = Boolean(getReferenceGroupHeader(group, index, type));
    const contentHeight = Math.max(1, layout.height - (hasHeader ? 82 : 48));
    const capacity = remainingItems.length > 0
      ? Math.max(1, getReferenceGridCapacity(remainingItems.length, 1040 - 48, contentHeight))
      : 0;
    const items = remainingItems.slice(0, capacity);

    if (remainingIndex >= 0) {
      remainingGroups[remainingIndex] = {
        ...group,
        items: remainingItems.slice(capacity),
      };
    }

    return {
      ...group,
      items,
    };
  });
}

async function renderProfileSheetPageBlob(profile, options = {}) {
  const {
    pageIndex = 0,
    pageCount = 1,
    useImages = true,
    type = SHEET_IMAGE_TYPE,
    quality = SHEET_IMAGE_QUALITY,
  } = options;
  const canvas = document.createElement("canvas");
  canvas.width = SHEET_WIDTH;
  canvas.height = SHEET_HEIGHT;

  const context = canvas.getContext("2d");
  await drawReferenceBackground(context);
  await drawReferenceColumn(context, {
    title: "\uad6c\ud574\uc694",
    groups: profile.wantedGroups,
    type: "wanted",
    x: 40,
    y: 40,
    width: 1040,
    height: 1320,
    accent: "#facc15",
    glow: "rgba(250, 204, 21, 0.55)",
    useImages,
    layoutGroups: profile.layoutWantedGroups || profile.wantedGroups,
  });
  await drawReferenceColumn(context, {
    title: "\ubcf4\uc720\uc911",
    groups: profile.ownedGroups,
    type: "owned",
    x: 1120,
    y: 40,
    width: 1040,
    height: 1320,
    accent: "#4ade80",
    glow: "rgba(74, 222, 128, 0.48)",
    useImages,
    layoutGroups: profile.layoutOwnedGroups || profile.ownedGroups,
  });

  const blob = await canvasToBlob(canvas, type, quality);
  if (!blob) throw new Error("profile sheet canvas export failed");

  return {
    blob,
    name: getProfileSheetImageName(pageIndex, pageCount),
    type: blob.type || type,
    size: blob.size,
    width: canvas.width,
    height: canvas.height,
    generated: true,
    sheetPageIndex: pageIndex,
    sheetPageCount: pageCount,
  };
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
  const { title, groups, layoutGroups = groups, type, x, y, width, height, accent, glow, useImages } = options;
  const visibleGroups = getNonEmptySheetGroups(groups);
  const visibleLayoutGroups = getNonEmptySheetGroups(layoutGroups);

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
  const groupLayouts = getReferenceGroupLayouts(visibleLayoutGroups, {
    type,
    y: boxY,
    height: boxHeightTotal,
    gap,
  });

  for (const [index, group] of visibleGroups.entries()) {
    const layoutGroup = visibleLayoutGroups[index] || group;
    const groupLayout = groupLayouts[index];
    const groupY = groupLayout.y;
    const groupHeight = groupLayout.height;
    drawDashedReferenceBox(context, x, groupY, width, groupHeight);

    const headerText = getReferenceGroupHeader(group, index, type);
    const headerColor = getReferenceGroupColor(getSheetGroupIndex(group, index), type, accent);
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

    await drawReferenceItems(
      context,
      group.items,
      x + 24,
      contentTop,
      width - 48,
      contentHeight,
      useImages,
      layoutGroup.items?.length || group.items?.length || 0,
    );
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
  return heights.map((groupHeight) => {
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
  return (hasHeader ? 82 : 48) + SHEET_MIN_ITEM_CELL_HEIGHT;
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

async function drawReferenceItems(context, items, x, y, width, height, useImages, layoutCount = null) {
  if (!items.length || width <= 0 || height <= 0) return;

  const sortedItems = [...items].sort(compareItemsByKoreanName);
  const layout = getReferenceGridLayout(Math.max(sortedItems.length, Number(layoutCount || 0)), width, height);
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
    context.fillText(`+${sortedItems.length - total}`, x + width, y + height);
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

  drawRoundedRect(context, x, y, width, height, radius, "rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.28)", 1);

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
  const maxColumns = Math.min(count, SHEET_MAX_ITEMS_PER_ROW, Math.max(1, Math.floor((width + gap) / (minWidth + gap))));
  const referenceCellWidth = getReferenceCellWidth(width, gap, maxColumns);
  const minCellHeight = getReferenceGridMinCellHeight(minHeight, referenceCellWidth);
  const maxCellWidth = Math.max(maxWidth, Math.min(SHEET_MAX_ITEM_CELL_WIDTH, referenceCellWidth || maxWidth));
  const maxCellHeight = Math.max(maxHeight, minCellHeight, Math.min(SHEET_MAX_ITEM_CELL_HEIGHT, referenceCellWidth * 1.12 || maxHeight));
  const maxRows = getReferenceGridMaxRows(height, gap, minCellHeight);
  let bestFit = null;

  for (let columns = maxColumns; columns >= 1; columns -= 1) {
    const rows = Math.ceil(count / columns);
    if (rows > maxRows) continue;

    const rawCellWidth = (width - gap * (columns - 1)) / columns;
    const rawCellHeight = (height - gap * (rows - 1)) / rows;
    if (rawCellWidth < minWidth || rawCellHeight < minCellHeight) continue;

    const cellWidth = Math.min(maxCellWidth, rawCellWidth);
    const cellHeight = Math.min(maxCellHeight, rawCellHeight);
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
    const rows = maxRows;
    const rawCellWidth = (width - gap * (columns - 1)) / columns;
    const rawCellHeight = (height - gap * (rows - 1)) / rows;
    if (rawCellWidth < minWidth || rawCellHeight < minCellHeight) continue;

    const visibleCount = columns * rows;
    const cellWidth = Math.min(maxCellWidth, rawCellWidth);
    const cellHeight = Math.min(maxCellHeight, rawCellHeight);
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

function getReferenceGridMinCellHeight(fallbackMinHeight, referenceCellWidth) {
  const widthBasedHeight = referenceCellWidth
    ? Math.min(SHEET_MAX_ITEM_CELL_HEIGHT, referenceCellWidth * 1.02)
    : 0;
  return Math.max(SHEET_MIN_ITEM_CELL_HEIGHT, fallbackMinHeight, widthBasedHeight);
}

function getReferenceGridMaxRows(height, gap, minCellHeight) {
  return Math.max(1, Math.floor((height + gap) / (minCellHeight + gap)));
}

function getReferenceCellWidth(width, gap, columns) {
  if (!columns || columns <= 0) return 0;
  return (width - gap * (columns - 1)) / columns;
}

function getReferenceGridCapacity(count, width, height) {
  if (!count || width <= 0 || height <= 0) return 0;
  return getReferenceGridLayout(count, width, height).visibleCount;
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
  if (type === "wanted") return `${getSheetGroupIndex(group, index) + 1}\uc21c\uc704`;
  return group.subtitle || "";
}

function getSheetGroupIndex(group, fallbackIndex = 0) {
  const index = Number(group?.sheetGroupIndex);
  return Number.isInteger(index) && index >= 0 ? index : fallbackIndex;
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

function compareItemsByKoreanName(a, b) {
  return koreanNameCollator.compare(getSortableItemName(a), getSortableItemName(b));
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

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob(resolve, type, quality);
  });
}

function getProfileSheetImageName(pageIndex, pageCount) {
  const pageSuffix = pageCount > 1 ? `-${pageIndex + 1}-of-${pageCount}` : "";
  return `poke30-tra-compatible-sheet${pageSuffix}.webp`;
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.floor(number)));
}
