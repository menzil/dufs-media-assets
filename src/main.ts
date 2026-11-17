import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  File,
  Folder,
  FolderArchive,
  House,
  ImageOff,
  Repeat2,
  Search,
  Upload,
  VideoOff,
  X,
  createElement,
  type IconNode,
} from "lucide";
import { createMkvPlayback, type MkvPlayback } from "./mkv-playback";
import "./style.css";

type PathType = "Dir" | "SymlinkDir" | "File" | "SymlinkFile";

type PathItem = Readonly<{
  path_type: PathType;
  name: string;
  mtime: number;
  size: number;
}>;

type IndexData = Readonly<{
  href: string;
  kind: "Index";
  uri_prefix: string;
  allow_upload: boolean;
  allow_delete: boolean;
  allow_search: boolean;
  allow_archive: boolean;
  dir_exists: boolean;
  auth: boolean;
  user: string | null;
  paths: readonly PathItem[];
}>;

type SortOrder = "name" | "mtime" | "size";

type PreviewSelection =
  | Readonly<{ kind: "image"; index: number }>
  | Readonly<{ kind: "video"; item: PathItem }>
  | null;

type MediaPlayback = Readonly<{
  kind: "browse" | "loop";
  items: readonly PathItem[];
  index: number;
}>;

type UploadProgress = Readonly<{
  fileCount: number;
  fileIndex: number;
  fileName: string;
  loaded: number;
  total: number;
}>;

type UploadLogStatus = "pending" | "uploading" | "complete" | "error";

type UploadLogEntry = Readonly<{
  fileName: string;
  fileSize: number;
  completedAt: number | null;
  status: UploadLogStatus;
  detail: string;
}>;

type UploadLog = Readonly<{
  root: HTMLElement;
  begin: (files: readonly File[]) => void;
  update: (progress: UploadProgress) => void;
  complete: (file: File, index: number) => void;
  fail: (message: string) => void;
  persist: () => void;
}>;

type JsonValue = null | string | number | boolean | JsonValue[] | { readonly [key: string]: JsonValue };

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  "m4v",
  "mkv",
  "mov",
  "mp4",
  "ogv",
  "webm",
]);

const IMAGE_SLIDESHOW_INTERVAL_MS = 5000;

const PATH_TYPES = new Set<PathType>(["Dir", "SymlinkDir", "File", "SymlinkFile"]);

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, JsonValue>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : fail(`Field ${field} must be a string`);
}

function requireBoolean(record: Record<string, JsonValue>, field: string): boolean {
  const value = record[field];
  return typeof value === "boolean" ? value : fail(`Field ${field} must be a boolean`);
}

function requireNumber(record: Record<string, JsonValue>, field: string): number {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(`Field ${field} must be a finite number`);
}

function parsePathItem(value: JsonValue, index: number): PathItem {
  if (!isRecord(value)) {
    return fail(`paths[${index}] must be an object`);
  }

  const pathType = requireString(value, "path_type");
  if (!PATH_TYPES.has(pathType as PathType)) {
    return fail(`paths[${index}].path_type is not supported: ${pathType}`);
  }

  return {
    path_type: pathType as PathType,
    name: requireString(value, "name"),
    mtime: requireNumber(value, "mtime"),
    size: requireNumber(value, "size"),
  };
}

function parseIndexData(encoded: string): IndexData {
  let parsed: JsonValue;
  try {
    const bytes = Uint8Array.from(atob(encoded.trim()), (character: string) => character.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as JsonValue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`Failed to parse the directory data injected by dufs: ${reason}`);
  }

  if (!isRecord(parsed)) {
    return fail("The data injected by dufs must be an object");
  }
  const kind = requireString(parsed, "kind");
  if (kind !== "Index") {
    return fail(`Dufs Media only supports directory pages; received page type ${kind}`);
  }
  const rawPaths = parsed.paths;
  if (!Array.isArray(rawPaths)) {
    return fail("Field paths must be an array");
  }
  const user = parsed.user;
  if (user !== null && typeof user !== "string") {
    return fail("Field user must be a string or null");
  }

  return {
    href: requireString(parsed, "href"),
    kind,
    uri_prefix: requireString(parsed, "uri_prefix"),
    allow_upload: requireBoolean(parsed, "allow_upload"),
    allow_delete: requireBoolean(parsed, "allow_delete"),
    allow_search: requireBoolean(parsed, "allow_search"),
    allow_archive: requireBoolean(parsed, "allow_archive"),
    dir_exists: requireBoolean(parsed, "dir_exists"),
    auth: requireBoolean(parsed, "auth"),
    user,
    paths: rawPaths.map(parsePathItem),
  };
}

function isDirectory(item: PathItem): boolean {
  return item.path_type === "Dir" || item.path_type === "SymlinkDir";
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function isImage(item: PathItem): boolean {
  return !isDirectory(item) && IMAGE_EXTENSIONS.has(extension(item.name));
}

function isVideo(item: PathItem): boolean {
  return !isDirectory(item) && VIDEO_EXTENSIONS.has(extension(item.name));
}

function baseUrl(): string {
  return window.location.href.split(/[?#]/u)[0] ?? window.location.href;
}

function itemUrl(item: PathItem): string {
  const base = baseUrl().endsWith("/") ? baseUrl() : `${baseUrl()}/`;
  const encodedName = item.name.split("/").map(encodeURIComponent).join("/");
  return `${base}${encodedName}${isDirectory(item) ? "/" : ""}`;
}

function uploadUrl(file: File): string {
  const base = baseUrl().endsWith("/") ? baseUrl() : `${baseUrl()}/`;
  return `${base}${encodeURIComponent(file.name)}`;
}

class UploadNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadNetworkError";
  }
}

function uploadResponseError(method: "PATCH" | "PUT", url: string, file: File, xhr: XMLHttpRequest): Error {
  const responseBody = xhr.responseText.trim() || "<empty>";
  return new Error(
    `Failed to upload ${file.name}: ${method} ${url} returned ${xhr.status} ${xhr.statusText}; responseBody=${responseBody}`,
  );
}

function putUpload(
  file: File,
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.addEventListener("progress", (event: ProgressEvent<EventTarget>) => {
      onProgress(event.loaded, file.size);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(uploadResponseError("PUT", url, file, xhr));
      }
    });
    xhr.addEventListener("error", () => {
      reject(new UploadNetworkError(`Failed to upload ${file.name}: PUT ${url} encountered a network error`));
    });
    xhr.addEventListener("abort", () => {
      reject(new UploadNetworkError(`Failed to upload ${file.name}: PUT ${url} was aborted`));
    });
    xhr.send(file);
  });
}

function patchUpload(
  file: File,
  url: string,
  offset: number,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PATCH", url);
    xhr.setRequestHeader("X-Update-Range", "append");
    xhr.upload.addEventListener("progress", (event: ProgressEvent<EventTarget>) => {
      onProgress(offset + event.loaded, file.size);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(uploadResponseError("PATCH", url, file, xhr));
      }
    });
    xhr.addEventListener("error", () => {
      reject(new UploadNetworkError(`Failed to upload ${file.name}: PATCH ${url} encountered a network error`));
    });
    xhr.addEventListener("abort", () => {
      reject(new UploadNetworkError(`Failed to upload ${file.name}: PATCH ${url} was aborted`));
    });
    xhr.send(file.slice(offset));
  });
}

async function readUploadOffset(file: File, url: string): Promise<number> {
  const response = await fetch(url, { method: "HEAD" });
  if (response.status === 404) {
    return 0;
  }
  if (!response.ok) {
    const responseBody = await response.text();
    return fail(
      `Failed to resume ${file.name}: HEAD ${url} returned ${response.status} ${response.statusText}; responseBody=${responseBody || "<empty>"}`,
    );
  }
  const rawOffset = response.headers.get("content-length");
  if (rawOffset === null) {
    return fail(`Failed to resume ${file.name}: HEAD ${url} response is missing content-length`);
  }
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) {
    return fail(`Failed to resume ${file.name}: server offset ${rawOffset} is outside 0..${file.size}`);
  }
  return offset;
}

async function uploadFile(file: File, onProgress: (loaded: number, total: number) => void): Promise<void> {
  const url = uploadUrl(file);
  try {
    await putUpload(file, url, onProgress);
  } catch (error) {
    if (!(error instanceof UploadNetworkError)) {
      throw error;
    }
    console.warn("Upload interrupted; retrying from server offset", {
      error: error.message,
      fileName: file.name,
      requestMethod: "PUT",
      requestUrl: url,
    });
    const offset = await readUploadOffset(file, url);
    if (offset === file.size) {
      onProgress(file.size, file.size);
      return;
    }
    if (offset === 0) {
      await putUpload(file, url, onProgress);
      return;
    }
    await patchUpload(file, url, offset, onProgress);
  }
}

async function uploadFiles(
  files: readonly File[],
  onProgress: (progress: UploadProgress) => void,
  onComplete: (file: File, index: number) => void,
): Promise<void> {
  for (const [index, file] of files.entries()) {
    await uploadFile(file, (loaded: number, total: number) => {
      onProgress({
        fileCount: files.length,
        fileIndex: index + 1,
        fileName: file.name,
        loaded,
        total,
      });
    });
    onComplete(file, index);
  }
}

function uploadPercentage(progress: UploadProgress): number {
  return progress.total === 0 ? 100 : Math.round((progress.loaded / progress.total) * 100);
}

function uploadLogStorageKey(pathname: string): string {
  return `dufsMediaUploadLog:${pathname}`;
}

function parseUploadLog(encoded: string, storageKey: string): readonly UploadLogEntry[] {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(encoded) as JsonValue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`Failed to parse upload log ${storageKey}: ${reason}`);
  }
  if (!Array.isArray(parsed)) {
    return fail(`Upload log ${storageKey} must be an array`);
  }
  return parsed.map((value: JsonValue, index: number): UploadLogEntry => {
    if (!isRecord(value)) {
      return fail(`Upload log ${storageKey}[${index}] must be an object`);
    }
    const status = requireString(value, "status");
    if (status !== "complete") {
      return fail(`Upload log ${storageKey}[${index}].status must be complete`);
    }
    return {
      fileName: requireString(value, "fileName"),
      fileSize: requireNumber(value, "fileSize"),
      completedAt: requireNumber(value, "completedAt"),
      status,
      detail: requireString(value, "detail"),
    };
  });
}

function loadUploadLog(storageKey: string): readonly UploadLogEntry[] {
  const encoded = window.sessionStorage.getItem(storageKey);
  return encoded === null ? [] : parseUploadLog(encoded, storageKey);
}

function updateUploadEntry(
  entries: readonly UploadLogEntry[],
  index: number,
  update: UploadLogEntry,
): readonly UploadLogEntry[] {
  if (entries[index] === undefined) {
    return fail(`Upload log index is out of range: ${index}`);
  }
  return entries.map((entry: UploadLogEntry, entryIndex: number) => entryIndex === index ? update : entry);
}

function createUploadLog(storageKey: string): UploadLog {
  const root = document.createElement("section");
  root.className = "upload-log";
  root.setAttribute("data-testid", "upload-log");
  root.setAttribute("aria-live", "polite");
  const header = document.createElement("div");
  header.className = "upload-log-header";
  const heading = document.createElement("h2");
  heading.textContent = "Upload log";
  const clear = buttonIcon(X, "Clear upload log");
  clear.setAttribute("data-testid", "clear-upload-log");
  header.append(heading, clear);
  const list = document.createElement("ol");
  list.className = "upload-log-list";
  root.append(header, list);
  let entries: readonly UploadLogEntry[] = loadUploadLog(storageKey);

  function renderEntries(): void {
    root.hidden = entries.length === 0;
    list.replaceChildren(...entries.map((entry: UploadLogEntry): HTMLLIElement => {
      const item = document.createElement("li");
      item.className = "upload-log-entry";
      item.dataset.fileName = entry.fileName;
      item.dataset.status = entry.status;
      item.setAttribute("data-testid", "upload-log-entry");
      const name = document.createElement("strong");
      name.textContent = entry.fileName;
      const detail = document.createElement("span");
      detail.className = "upload-log-detail";
      detail.textContent = entry.detail;
      item.append(name, detail);
      return item;
    }));
  }

  clear.addEventListener("click", () => {
    window.sessionStorage.removeItem(storageKey);
    entries = [];
    renderEntries();
  });
  renderEntries();

  return {
    root,
    begin: (files: readonly File[]) => {
      entries = files.map((file: File): UploadLogEntry => ({
        fileName: file.name,
        fileSize: file.size,
        completedAt: null,
        status: "pending",
        detail: `${formatSize(file.size)} · Waiting`,
      }));
      renderEntries();
    },
    update: (progress: UploadProgress) => {
      entries = updateUploadEntry(entries, progress.fileIndex - 1, {
        fileName: progress.fileName,
        fileSize: progress.total,
        completedAt: null,
        status: "uploading",
        detail: `${formatSize(progress.loaded)} / ${formatSize(progress.total)} · ${uploadPercentage(progress)}%`,
      });
      renderEntries();
    },
    complete: (file: File, index: number) => {
      entries = updateUploadEntry(entries, index, {
        fileName: file.name,
        fileSize: file.size,
        completedAt: Date.now(),
        status: "complete",
        detail: `${formatSize(file.size)} · Complete`,
      });
      renderEntries();
    },
    fail: (message: string) => {
      const activeIndex = entries.findIndex((entry: UploadLogEntry) => entry.status === "uploading");
      const pendingIndex = entries.findIndex((entry: UploadLogEntry) => entry.status === "pending");
      const failedIndex = activeIndex >= 0
        ? activeIndex
        : pendingIndex >= 0
          ? pendingIndex
          : entries.length - 1;
      if (failedIndex < 0) {
        return fail("Failed to record upload error: no upload is active or waiting");
      }
      const current = entries[failedIndex] ?? fail(`Upload log index is out of range: ${failedIndex}`);
      entries = updateUploadEntry(entries, failedIndex, {
        ...current,
        status: "error",
        detail: message,
      });
      renderEntries();
    },
    persist: () => {
      const incomplete = entries.find((entry: UploadLogEntry) => entry.status !== "complete");
      if (incomplete !== undefined) {
        return fail(`Failed to save upload log: ${incomplete.fileName} has status ${incomplete.status}`);
      }
      window.sessionStorage.setItem(storageKey, JSON.stringify(entries));
    },
  };
}

async function handleUploadSelection(
  files: readonly File[],
  button: HTMLButtonElement,
  input: HTMLInputElement,
  uploadLog: UploadLog,
): Promise<void> {
  button.disabled = true;
  uploadLog.begin(files);
  try {
    await uploadFiles(files, (progress: UploadProgress) => {
      uploadLog.update(progress);
    }, (file: File, index: number) => {
      uploadLog.complete(file, index);
    });
    uploadLog.persist();
    window.location.reload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    uploadLog.fail(message);
    console.error("Upload failed", { message });
  } finally {
    button.disabled = false;
    input.value = "";
  }
}

function previewNameFromUrl(url: URL): string | null {
  const values = url.searchParams.getAll("preview");
  if (values.length > 1) {
    return fail("The URL may contain only one preview parameter");
  }
  const value = values[0] ?? null;
  if (value === "") {
    return fail("The URL preview parameter must not be empty");
  }
  return value;
}

function urlWithPreview(url: URL, name: string | null): URL {
  const updated = new URL(url.href);
  if (name === null) {
    updated.searchParams.delete("preview");
  } else {
    updated.searchParams.set("preview", name);
  }
  return updated;
}

function isGalleryPreviewHistoryState(value: JsonValue | undefined): boolean {
  return value !== undefined && isRecord(value) && value.dufsGalleryPreview === true;
}

function pushPreviewUrl(item: PathItem): void {
  const state: Readonly<{ dufsGalleryPreview: true }> = { dufsGalleryPreview: true };
  window.history.pushState(state, "", urlWithPreview(new URL(window.location.href), item.name));
}

function replacePreviewUrl(item: PathItem): void {
  window.history.replaceState(
    window.history.state as JsonValue | undefined,
    "",
    urlWithPreview(new URL(window.location.href), item.name),
  );
}

function closePreviewUrl(): void {
  const url = new URL(window.location.href);
  if (previewNameFromUrl(url) === null) {
    return;
  }
  const state = window.history.state as JsonValue | undefined;
  if (isGalleryPreviewHistoryState(state)) {
    window.history.back();
    return;
  }
  window.history.replaceState(state ?? null, "", urlWithPreview(url, null));
}

function resolvePreviewSelection(
  name: string | null,
  images: readonly PathItem[],
  videos: readonly PathItem[],
): PreviewSelection {
  if (name === null) {
    return null;
  }
  const imageIndex = images.findIndex((item: PathItem) => item.name === name);
  if (imageIndex >= 0) {
    return { kind: "image", index: imageIndex };
  }
  const video = videos.find((item: PathItem) => item.name === name);
  if (video !== undefined) {
    return { kind: "video", item: video };
  }
  return fail(`The preview file specified by the URL does not exist or is not supported: ${name}`);
}

function icon(node: IconNode, label: string | null): SVGElement {
  const element = createElement(node);
  element.setAttribute("aria-hidden", label === null ? "true" : "false");
  if (label !== null) {
    element.setAttribute("aria-label", label);
  }
  return element;
}

function buttonIcon(node: IconNode, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(node, null));
  return button;
}

function linkIcon(node: IconNode, label: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "icon-button";
  link.href = href;
  link.setAttribute("aria-label", label);
  link.title = label;
  link.append(icon(node, null));
  return link;
}

function formatSize(size: number): string {
  if (size === 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  const value = size / 1024 ** unitIndex;
  return `${unitIndex === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(mtime: number): string {
  const date = new Date(mtime);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildBreadcrumb(data: IndexData): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "breadcrumb";
  nav.setAttribute("aria-label", "Current path");

  const home = document.createElement("a");
  home.href = data.uri_prefix;
  home.setAttribute("aria-label", "Root directory");
  home.append(icon(House, null));
  nav.append(home);

  const segments = data.href.split("/").filter((segment: string) => segment.length > 0);
  let path = data.uri_prefix.replace(/\/$/u, "");
  segments.forEach((segment: string, index: number) => {
    const separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.textContent = "/";
    nav.append(separator);

    path += `/${encodeURIComponent(segment)}`;
    if (index === segments.length - 1) {
      const current = document.createElement("span");
      current.className = "breadcrumb-current";
      current.textContent = segment;
      nav.append(current);
    } else {
      const link = document.createElement("a");
      link.href = `${path}/`;
      link.textContent = segment;
      nav.append(link);
    }
  });

  return nav;
}

function createFolderItem(item: PathItem): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "folder-item";
  link.href = itemUrl(item);
  link.setAttribute("aria-label", item.name);
  link.append(icon(Folder, null));

  const details = document.createElement("span");
  details.className = "folder-details";
  const name = document.createElement("strong");
  name.textContent = item.name;
  const count = document.createElement("span");
  count.textContent = item.size >= 1000 ? "1000+ items" : `${item.size} ${item.size === 1 ? "item" : "items"}`;
  details.append(name, count);
  link.append(details, icon(ChevronRight, null));
  return link;
}

function createFileItem(item: PathItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "file-row";
  row.setAttribute("data-testid", "file-row");
  row.dataset.fileName = item.name;
  row.append(icon(File, null));

  const name = document.createElement("a");
  name.className = "file-name";
  name.href = itemUrl(item);
  name.textContent = item.name;

  const metadata = document.createElement("span");
  metadata.className = "file-metadata";
  metadata.textContent = `${formatSize(item.size)} · ${formatDate(item.mtime)}`;

  const download = linkIcon(ArrowDownToLine, `Download ${item.name}`, itemUrl(item));
  download.download = item.name;
  row.append(name, metadata, download);
  return row;
}

function sortItems(items: readonly PathItem[], order: SortOrder): readonly PathItem[] {
  return [...items].sort((left: PathItem, right: PathItem) => {
    if (order === "mtime") {
      return right.mtime - left.mtime;
    }
    if (order === "size") {
      return right.size - left.size;
    }
    return left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" });
  });
}

function createViewer(
  onNavigate: (item: PathItem) => void,
  onClose: () => void,
): Readonly<{
  dialog: HTMLDialogElement;
  open: (item: PathItem, items: readonly PathItem[]) => void;
  playSequence: (items: readonly PathItem[]) => void;
}> {
  const dialog = document.createElement("dialog");
  dialog.className = "viewer";
  dialog.setAttribute("aria-label", "Image viewer");
  dialog.setAttribute("data-testid", "image-viewer");

  const stage = document.createElement("div");
  stage.className = "viewer-stage";
  const image = document.createElement("img");
  image.className = "viewer-image";
  image.alt = "";
  stage.append(image);

  const close = buttonIcon(X, "Close image viewer");
  close.classList.add("viewer-close");
  close.setAttribute("data-testid", "close-image-viewer");
  const download = linkIcon(ArrowDownToLine, "Download current image", "");
  download.download = "";
  download.setAttribute("data-testid", "download-current-image");
  const previous = buttonIcon(ChevronLeft, "Previous image");
  previous.classList.add("viewer-previous");
  previous.setAttribute("data-testid", "previous-image");
  const next = buttonIcon(ChevronRight, "Next image");
  next.classList.add("viewer-next");
  next.setAttribute("data-testid", "next-image");

  const captionText = document.createElement("div");
  const captionName = document.createElement("strong");
  captionName.setAttribute("data-testid", "current-image-name");
  const captionCount = document.createElement("span");
  captionText.append(captionName, captionCount);
  const actions = document.createElement("div");
  actions.className = "viewer-actions";
  actions.setAttribute("data-testid", "image-viewer-actions");
  actions.append(captionText, download, close);
  dialog.append(stage, actions, previous, next);

  let playback: MediaPlayback | null = null;
  let slideshowTimer: number | null = null;

  function stopSlideshow(): void {
    if (slideshowTimer !== null) {
      window.clearInterval(slideshowTimer);
      slideshowTimer = null;
    }
  }

  function show(item: PathItem): void {
    if (playback === null) {
      return fail("Cannot show image: playback queue has not been created");
    }
    const url = itemUrl(item);
    image.src = url;
    image.alt = item.name;
    captionName.textContent = item.name;
    captionCount.textContent = playback.kind === "loop"
      ? `${playback.index + 1} / ${playback.items.length} · Looping`
      : `${playback.index + 1} / ${playback.items.length}`;
    download.href = url;
    download.download = item.name;
  }

  function navigate(index: number): void {
    if (playback === null || playback.items.length === 0) {
      return fail("Image playback queue must not be empty");
    }
    const nextIndex = (index + playback.items.length) % playback.items.length;
    playback = { ...playback, index: nextIndex };
    const item = playback.items[nextIndex] ?? fail(`Image playback queue index is out of range: ${nextIndex}`);
    show(item);
    onNavigate(item);
  }

  function startSlideshow(): void {
    stopSlideshow();
    if (playback?.kind !== "loop") {
      return fail("Cannot start image loop: the current queue is not a loop queue");
    }
    slideshowTimer = window.setInterval(() => {
      const index = playback?.index ?? fail("Cannot continue image loop: playback queue has not been created");
      navigate(index + 1);
    }, IMAGE_SLIDESHOW_INTERVAL_MS);
  }

  function navigateManually(offset: number): void {
    const index = playback?.index ?? fail("Cannot change image: playback queue has not been created");
    navigate(index + offset);
    if (playback?.kind === "loop") {
      startSlideshow();
    }
  }

  function reset(): void {
    stopSlideshow();
    playback = null;
    image.removeAttribute("src");
    image.alt = "";
  }

  function open(item: PathItem, items: readonly PathItem[]): void {
    if (items.length === 0) {
      return fail("The current directory has no images to browse");
    }
    const index = items.findIndex((candidate: PathItem) => candidate.name === item.name);
    if (index < 0) {
      return fail(`Image playback queue does not contain file: ${item.name}`);
    }
    reset();
    playback = { kind: "browse", items: [...items], index };
    previous.hidden = items.length < 2;
    next.hidden = items.length < 2;
    show(item);
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  function playSequence(items: readonly PathItem[]): void {
    if (items.length === 0) {
      return fail("The current directory has no images to loop");
    }
    reset();
    playback = { kind: "loop", items: [...items], index: 0 };
    previous.hidden = items.length < 2;
    next.hidden = items.length < 2;
    show(items[0] ?? fail("Image loop queue must not be empty"));
    if (!dialog.open) {
      dialog.showModal();
    }
    startSlideshow();
  }

  close.addEventListener("click", () => dialog.close());
  previous.addEventListener("click", () => navigateManually(-1));
  next.addEventListener("click", () => navigateManually(1));
  stage.addEventListener("click", (event: MouseEvent) => {
    if (event.target === stage) {
      dialog.close();
    }
  });
  dialog.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      navigateManually(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      navigateManually(1);
    }
  });
  dialog.addEventListener("close", () => {
    reset();
    onClose();
  });

  return { dialog, open, playSequence };
}

function createImageItem(item: PathItem, index: number, open: (item: PathItem) => void): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "media-item";

  const button = document.createElement("button");
  button.className = "media-button";
  button.type = "button";
  button.setAttribute("aria-label", `Preview ${item.name}`);
  button.setAttribute("data-testid", "image-card");
  button.dataset.fileName = item.name;
  const image = document.createElement("img");
  image.src = itemUrl(item);
  image.alt = item.name;
  image.loading = index < 8 ? "eager" : "lazy";
  image.decoding = "async";
  image.width = 640;
  image.height = 480;

  const error = document.createElement("span");
  error.className = "media-error";
  error.append(icon(ImageOff, null), document.createTextNode("Thumbnail unavailable"));
  image.addEventListener("error", () => figure.classList.add("is-broken"));
  button.addEventListener("click", () => open(item));
  button.append(image, error);

  const caption = document.createElement("figcaption");
  const name = document.createElement("span");
  name.textContent = item.name;
  const size = document.createElement("span");
  size.textContent = formatSize(item.size);
  caption.append(name, size);
  figure.append(button, caption);
  return figure;
}

function videoErrorMessage(video: HTMLVideoElement): string {
  if (video.error === null) {
    return "Unable to load video";
  }
  if (video.error.code === MediaError.MEDIA_ERR_ABORTED) {
    return "Video loading was aborted";
  }
  if (video.error.code === MediaError.MEDIA_ERR_NETWORK) {
    return "Video request failed because of a network error";
  }
  if (video.error.code === MediaError.MEDIA_ERR_DECODE) {
    return "This browser cannot decode the video";
  }
  if (video.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return "This browser does not support the video container or codec";
  }
  return fail(`Unknown video error code: ${video.error.code}`);
}

function createVideoViewer(
  onNavigate: (item: PathItem) => void,
  onClose: () => void,
): Readonly<{
  dialog: HTMLDialogElement;
  open: (item: PathItem, items: readonly PathItem[]) => void;
  playSequence: (items: readonly PathItem[]) => void;
}> {
  const dialog = document.createElement("dialog");
  dialog.className = "viewer video-viewer";
  dialog.setAttribute("aria-label", "Video player");
  dialog.setAttribute("data-testid", "video-viewer");

  const stage = document.createElement("div");
  stage.className = "viewer-stage";
  const video = document.createElement("video");
  video.className = "viewer-video";
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("data-testid", "video-player");

  const error = document.createElement("span");
  error.className = "viewer-media-error";
  error.append(icon(VideoOff, null));
  const errorText = document.createElement("span");
  errorText.setAttribute("data-testid", "video-error");
  error.append(errorText);
  stage.append(video, error);

  const close = buttonIcon(X, "Close video player");
  close.classList.add("viewer-close");
  close.setAttribute("data-testid", "close-video-viewer");
  const download = linkIcon(ArrowDownToLine, "Download current video", "");
  download.download = "";
  download.setAttribute("data-testid", "download-current-video");
  const actions = document.createElement("div");
  actions.className = "viewer-actions";
  actions.setAttribute("data-testid", "video-viewer-actions");
  actions.append(download, close);
  const previous = buttonIcon(ChevronLeft, "Previous video");
  previous.classList.add("viewer-previous");
  previous.setAttribute("data-testid", "previous-video");
  previous.hidden = true;
  const next = buttonIcon(ChevronRight, "Next video");
  next.classList.add("viewer-next");
  next.setAttribute("data-testid", "next-video");
  next.hidden = true;

  const captionText = document.createElement("div");
  const captionName = document.createElement("strong");
  captionName.setAttribute("data-testid", "current-video-name");
  const captionCount = document.createElement("span");
  captionText.append(captionName, captionCount);
  actions.prepend(captionText);
  dialog.append(stage, actions, previous, next);

  let playback: MediaPlayback | null = null;
  let mkvPlayback: MkvPlayback | null = null;
  let mediaReady: Promise<void> = Promise.resolve();

  function resetMedia(): void {
    mkvPlayback?.dispose();
    mkvPlayback = null;
    mediaReady = Promise.resolve();
    video.pause();
    video.removeAttribute("src");
    video.load();
    dialog.classList.remove("has-media-error");
    errorText.textContent = "";
  }

  function show(item: PathItem): void {
    const url = itemUrl(item);
    resetMedia();
    captionName.textContent = item.name;
    if (playback === null) {
      return fail("Cannot show video: playback queue has not been created");
    }
    captionCount.textContent = playback.kind === "loop"
      ? `${playback.index + 1} / ${playback.items.length} · Looping`
      : `${playback.index + 1} / ${playback.items.length}`;
    download.href = url;
    download.download = item.name;
    if (extension(item.name) === "mkv") {
      const current = createMkvPlayback(video, url, (error: Error) => {
        if (mkvPlayback === current) {
          showPlaybackError(error);
        }
      });
      mkvPlayback = current;
      mediaReady = current.ready;
      void current.ready.catch((loadError) => {
        if (mkvPlayback === current && !current.signal.aborted) {
          current.dispose();
          showPlaybackError(loadError instanceof Error ? loadError : new Error(String(loadError)));
        }
      });
    } else {
      video.src = url;
      video.load();
    }
  }

  function reset(): void {
    resetMedia();
    playback = null;
    previous.hidden = true;
    next.hidden = true;
  }

  function showPlaybackError(playError: Error): void {
    errorText.textContent = `Unable to play ${captionName.textContent ?? "current video"}: ${playError.message}`;
    dialog.classList.add("has-media-error");
    console.error("Video playback failed", {
      fileName: captionName.textContent,
      error: playError,
    });
  }

  async function playCurrent(): Promise<void> {
    const ready = mediaReady;
    try {
      await ready;
      if (ready !== mediaReady) {
        return;
      }
      await video.play();
    } catch (playError) {
      if (ready === mediaReady && (mkvPlayback === null || !mkvPlayback.signal.aborted)) {
        showPlaybackError(playError instanceof Error ? playError : new Error(String(playError)));
      }
    }
  }

  function showQueueItem(index: number): void {
    if (playback === null || playback.items.length === 0) {
      return fail("Video playback queue must not be empty");
    }
    const nextIndex = (index + playback.items.length) % playback.items.length;
    playback = { ...playback, index: nextIndex };
    const item = playback.items[nextIndex] ?? fail(`Video playback queue index is out of range: ${nextIndex}`);
    show(item);
    onNavigate(item);
    void playCurrent();
  }

  function open(item: PathItem, items: readonly PathItem[]): void {
    if (items.length === 0) {
      return fail("The current directory has no videos to browse");
    }
    const index = items.findIndex((candidate: PathItem) => candidate.name === item.name);
    if (index < 0) {
      return fail(`Video playback queue does not contain file: ${item.name}`);
    }
    reset();
    playback = { kind: "browse", items: [...items], index };
    previous.hidden = items.length < 2;
    next.hidden = items.length < 2;
    show(item);
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  function playSequence(items: readonly PathItem[]): void {
    if (items.length === 0) {
      return fail("The current directory has no videos to loop");
    }
    reset();
    playback = { kind: "loop", items: [...items], index: 0 };
    previous.hidden = items.length < 2;
    next.hidden = items.length < 2;
    show(items[0] ?? fail("Video loop queue must not be empty"));
    if (!dialog.open) {
      dialog.showModal();
    }
    void playCurrent();
  }

  close.addEventListener("click", () => dialog.close());
  previous.addEventListener("click", () => {
    const index = playback?.index ?? fail("Cannot change video: playback queue has not been created");
    showQueueItem(index - 1);
  });
  next.addEventListener("click", () => {
    const index = playback?.index ?? fail("Cannot change video: playback queue has not been created");
    showQueueItem(index + 1);
  });
  stage.addEventListener("click", (event: MouseEvent) => {
    if (event.target === stage) {
      dialog.close();
    }
  });
  video.addEventListener("error", () => {
    errorText.textContent = videoErrorMessage(video);
    dialog.classList.add("has-media-error");
  });
  video.addEventListener("ended", () => {
    if (playback?.kind === "loop") {
      showQueueItem(playback.index + 1);
    }
  });
  dialog.addEventListener("close", () => {
    reset();
    onClose();
  });

  return { dialog, open, playSequence };
}

function createVideoItem(item: PathItem, open: (item: PathItem) => void): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "media-item video-item";

  const button = document.createElement("button");
  button.className = "media-button video-button";
  button.type = "button";
  button.setAttribute("aria-label", `Play ${item.name}`);
  button.setAttribute("data-testid", "video-card");
  button.dataset.fileName = item.name;

  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("aria-hidden", "true");
  video.setAttribute("data-testid", "video-thumbnail");

  const play = document.createElement("span");
  play.className = "video-play";
  play.setAttribute("data-testid", "video-play-action");
  play.append(icon(CirclePlay, null));

  const uploadedAt = document.createElement("time");
  uploadedAt.className = "video-date";
  uploadedAt.setAttribute("data-testid", "video-upload-date");
  uploadedAt.dateTime = new Date(item.mtime).toISOString();
  uploadedAt.textContent = formatDate(item.mtime);

  const error = document.createElement("span");
  error.className = "media-error";
  error.append(icon(VideoOff, null));
  const errorText = document.createTextNode("Preview unavailable · Click to try playing");
  error.append(errorText);

  video.src = itemUrl(item);
  video.load();
  video.addEventListener("loadedmetadata", () => {
    if (video.duration > 0.1) {
      video.currentTime = 0.1;
    }
  }, { once: true });
  video.addEventListener("error", () => figure.classList.add("is-broken"));
  button.addEventListener("click", () => open(item));
  button.append(video, play, uploadedAt, error);

  const caption = document.createElement("figcaption");
  const name = document.createElement("a");
  name.href = itemUrl(item);
  name.setAttribute("data-testid", "video-file-link");
  name.textContent = item.name;
  const size = document.createElement("span");
  size.textContent = formatSize(item.size);
  caption.append(name, size);
  figure.append(button, caption);
  return figure;
}

function section(title: string, count: number): Readonly<{
  root: HTMLElement;
  heading: HTMLHeadingElement;
  content: HTMLElement;
}> {
  const root = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  const badge = document.createElement("span");
  badge.textContent = String(count);
  heading.append(badge);
  const content = document.createElement("div");
  root.append(heading, content);
  return { root, heading, content };
}

function createLoopButton(testId: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "text-button section-action";
  button.type = "button";
  button.setAttribute("data-testid", testId);
  button.append(icon(Repeat2, null), document.createTextNode("Loop"));
  button.addEventListener("click", onClick);
  return button;
}

function render(data: IndexData, app: HTMLElement): void {
  const folders = data.paths.filter(isDirectory);
  const images = data.paths.filter(isImage);
  const videos = data.paths.filter(isVideo);
  const files = data.paths.filter(
    (item: PathItem) => !isDirectory(item) && !isImage(item) && !isVideo(item),
  );
  const initialSelection = resolvePreviewSelection(
    previewNameFromUrl(new URL(window.location.href)),
    images,
    videos,
  );
  const viewer = createViewer(replacePreviewUrl, closePreviewUrl);
  const videoViewer = createVideoViewer(replacePreviewUrl, closePreviewUrl);

  function openImage(item: PathItem, items: readonly PathItem[]): void {
    pushPreviewUrl(item);
    viewer.open(item, items);
  }

  function playImageSequence(items: readonly PathItem[]): void {
    const first = items[0] ?? fail("The current filter has no images to loop");
    pushPreviewUrl(first);
    viewer.playSequence(items);
  }

  function openVideo(item: PathItem, items: readonly PathItem[]): void {
    pushPreviewUrl(item);
    videoViewer.open(item, items);
  }

  function playVideoSequence(items: readonly PathItem[]): void {
    const first = items[0] ?? fail("The current filter has no videos to loop");
    pushPreviewUrl(first);
    videoViewer.playSequence(items);
  }

  function syncPreview(selection: PreviewSelection): void {
    if (selection === null) {
      if (viewer.dialog.open) {
        viewer.dialog.close();
      }
      if (videoViewer.dialog.open) {
        videoViewer.dialog.close();
      }
      return;
    }
    if (selection.kind === "image") {
      const item = images[selection.index] ?? fail(`Image index is out of range: ${selection.index}`);
      viewer.open(item, sortedImages());
      return;
    }
    videoViewer.open(selection.item, sortedVideos());
  }

  const header = document.createElement("header");
  const headerMain = document.createElement("div");
  headerMain.className = "header-main";
  const identity = document.createElement("div");
  identity.className = "identity";
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "DUFS MEDIA";
  const title = document.createElement("h1");
  title.setAttribute("data-testid", "library-title");
  title.textContent = data.href === "/" ? "Media Library" : (data.href.split("/").filter(Boolean).at(-1) ?? "Media Library");
  const summary = document.createElement("p");
  summary.textContent = `${images.length} images · ${videos.length} videos · ${folders.length} folders · ${files.length} other`;
  identity.append(eyebrow, title, summary);
  headerMain.append(identity);

  const actions = document.createElement("div");
  actions.className = "header-actions";
  const uploadLog = createUploadLog(uploadLogStorageKey(window.location.pathname));
  if (data.allow_upload) {
    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.multiple = true;
    uploadInput.hidden = true;
    uploadInput.setAttribute("data-testid", "upload-input");
    const uploadButton = document.createElement("button");
    uploadButton.className = "text-button";
    uploadButton.type = "button";
    uploadButton.setAttribute("data-testid", "upload-button");
    uploadButton.append(icon(Upload, null), document.createTextNode("Upload"));
    uploadButton.addEventListener("click", () => uploadInput.click());
    uploadInput.addEventListener("change", () => {
      const selectedFiles = uploadInput.files === null ? [] : Array.from(uploadInput.files);
      if (selectedFiles.length === 0) {
        return;
      }
      void handleUploadSelection(selectedFiles, uploadButton, uploadInput, uploadLog);
    });
    actions.append(uploadButton, uploadInput);
  }
  if (data.allow_archive) {
    const archive = document.createElement("a");
    archive.className = "text-button";
    archive.href = `${baseUrl()}?zip`;
    archive.download = "";
    archive.append(icon(FolderArchive, null), document.createTextNode("Download folder"));
    actions.append(archive);
  }
  if (data.user !== null) {
    const user = document.createElement("span");
    user.className = "user-chip";
    user.textContent = data.user;
    actions.append(user);
  }
  headerMain.append(actions);
  header.append(buildBreadcrumb(data), headerMain);

  const controls = document.createElement("div");
  controls.className = "controls";
  const searchLabel = document.createElement("label");
  searchLabel.className = "search-control";
  searchLabel.append(icon(Search, null));
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Filter this folder";
  search.setAttribute("aria-label", "Filter this folder");
  searchLabel.append(search);

  const sort = document.createElement("select");
  sort.setAttribute("aria-label", "Sort by");
  const sortOptions: readonly Readonly<{ value: SortOrder; label: string }>[] = [
    { value: "name", label: "Name" },
    { value: "mtime", label: "Date" },
    { value: "size", label: "Size" },
  ];
  sortOptions.forEach((optionData: Readonly<{ value: SortOrder; label: string }>) => {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    sort.append(option);
  });
  controls.append(searchLabel, sort);

  const main = document.createElement("main");
  main.id = "main-content";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.append(icon(ImageOff, null));
  const emptyTitle = document.createElement("strong");
  emptyTitle.textContent = data.dir_exists ? "This folder is empty" : "This folder does not exist yet";
  const emptyBody = document.createElement("span");
  emptyBody.textContent = data.dir_exists ? "There is nothing to browse here yet" : "dufs will create it when you upload the first file";
  empty.append(emptyTitle, emptyBody);

  function sortedImages(): readonly PathItem[] {
    return sortItems(images, sort.value as SortOrder);
  }

  function sortedVideos(): readonly PathItem[] {
    return sortItems(videos, sort.value as SortOrder);
  }

  function update(): void {
    main.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const order = sort.value as SortOrder;
    const matches = (item: PathItem): boolean => item.name.toLowerCase().includes(query);
    const shownFolders = sortItems(folders.filter(matches), order);
    const shownImages = sortItems(images.filter(matches), order);
    const shownVideos = sortItems(videos.filter(matches), order);
    const shownFiles = sortItems(files.filter(matches), order);

    if (shownFolders.length > 0) {
      const foldersSection = section("Folders", shownFolders.length);
      foldersSection.content.className = "folder-list";
      foldersSection.content.append(...shownFolders.map(createFolderItem));
      main.append(foldersSection.root);
    }
    if (shownImages.length > 0) {
      const imagesSection = section("Images", shownImages.length);
      imagesSection.heading.append(createLoopButton("loop-images", () => playImageSequence(shownImages)));
      imagesSection.content.className = "media-grid";
      imagesSection.content.append(
        ...shownImages.map((item: PathItem, index: number) =>
          createImageItem(item, index, (selected: PathItem) => openImage(selected, shownImages)),
        ),
      );
      main.append(imagesSection.root);
    }
    if (shownVideos.length > 0) {
      const videosSection = section("Videos", shownVideos.length);
      videosSection.heading.append(createLoopButton("loop-videos", () => playVideoSequence(shownVideos)));
      videosSection.content.className = "media-grid";
      videosSection.content.append(
        ...shownVideos.map((item: PathItem) =>
          createVideoItem(item, (selected: PathItem) => openVideo(selected, shownVideos)),
        ),
      );
      main.append(videosSection.root);
    }
    if (shownFiles.length > 0) {
      const filesSection = section("Other Files", shownFiles.length);
      filesSection.content.className = "file-list";
      filesSection.content.append(...shownFiles.map(createFileItem));
      main.append(filesSection.root);
    }
    if (main.childElementCount === 0) {
      if (query.length > 0) {
        emptyTitle.textContent = "No matching items";
        emptyBody.textContent = `No item in this folder contains "${search.value.trim()}"`;
      }
      main.append(empty);
    }
  }

  search.addEventListener("input", update);
  sort.addEventListener("change", update);
  window.addEventListener("popstate", () => {
    syncPreview(resolvePreviewSelection(
      previewNameFromUrl(new URL(window.location.href)),
      images,
      videos,
    ));
  });
  app.append(header, controls, uploadLog.root, main, viewer.dialog, videoViewer.dialog);
  update();
  syncPreview(initialSelection);
  document.title = `${title.textContent} · Dufs Media`;
}

function renderError(error: Error, app: HTMLElement): void {
  const main = document.createElement("main");
  main.className = "fatal-error";
  const heading = document.createElement("h1");
  heading.textContent = "Unable to open Dufs Media";
  const message = document.createElement("p");
  message.textContent = error.message;
  const back = document.createElement("a");
  back.className = "text-button";
  back.href = "/";
  back.append(icon(House, null), document.createTextNode("Return to root directory"));
  main.append(heading, message, back);
  app.append(main);
}

const app = document.querySelector<HTMLElement>("#app") ?? fail("Missing #app root element");
const indexData = document.querySelector<HTMLTemplateElement>("#index-data") ?? fail("Missing #index-data data template");

try {
  render(parseIndexData(indexData.innerHTML), app);
} catch (error) {
  renderError(error instanceof Error ? error : new Error(String(error)), app);
}
