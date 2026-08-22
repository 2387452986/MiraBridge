import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { BridgeError } from "../../protocol/src/index.js";

const MAX_BODY_SUMMARY_CHARS = 16_384;
const MAX_DOM_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 256 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 100_000_000;
const MAX_SCREENSHOT_DIMENSION = 32_767;

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function detectEdgeExecutable(): Promise<string | null> {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const candidates = roots.flatMap((root) => [
    join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(root, "Microsoft", "Edge Beta", "Application", "msedge.exe"),
    join(root, "Microsoft", "Edge Dev", "Application", "msedge.exe"),
  ]);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateWebSnapshotUrl(value: string, networkPolicy: "local-only" | "allow-external", allowExternal: boolean): URL {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw new BridgeError("INVALID_ARGUMENT", "web_snapshot URL is invalid.", { cause: error }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BridgeError("PERMISSION_DENIED", "web_snapshot only accepts HTTP(S) URLs; file, data, browser, and extension URLs are forbidden.");
  if (networkPolicy === "allow-external" && !allowExternal) throw new BridgeError("CAPABILITY_NOT_ENABLED", "External web snapshots are disabled in worker.toml.");
  if (networkPolicy === "local-only" && !isLoopback(url.hostname)) throw new BridgeError("PERMISSION_DENIED", "local-only web snapshots require localhost, 127.0.0.1, or ::1.", { details: { hostname: url.hostname } });
  return url;
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function boundedUtf8(text: string, maxBytes: number): { bytes: Buffer; truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return { bytes: encoded, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try { return { bytes: Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end)), "utf8"), truncated: true }; }
    catch { end -= 1; }
  }
  return { bytes: Buffer.alloc(0), truncated: true };
}

async function installAtomicSet(items: Array<{ temporary: string; destination: string }>, overwrite: boolean): Promise<{ backup_cleanup_pending: boolean; backup_paths: string[] }> {
  const states = await Promise.all(items.map(async (item) => ({
    ...item,
    existed: await exists(item.destination),
    backup: resolve(dirname(item.destination), `.${basename(item.destination)}.${randomUUID()}.mirabridge-backup`),
    installed: false,
    backedUp: false,
  })));
  const collision = states.find((state) => state.existed && !overwrite);
  if (collision) throw new BridgeError("FILE_CHANGED", "Snapshot destination already exists and overwrite is false.", { details: { destination_path: collision.destination } });
  try {
    for (const state of states) {
      if (!state.existed) continue;
      await rename(state.destination, state.backup);
      state.backedUp = true;
    }
    for (const state of states) {
      await rename(state.temporary, state.destination);
      state.installed = true;
    }
  } catch (error) {
    for (const state of states.toReversed()) {
      if (state.installed) await rm(state.destination, { recursive: true, force: true }).catch(() => undefined);
      if (state.backedUp) await rename(state.backup, state.destination).catch(() => undefined);
    }
    throw error;
  }
  const backupPaths: string[] = [];
  for (const state of states.filter((item) => item.backedUp)) {
    try { await rm(state.backup, { recursive: true, force: true }); }
    catch { backupPaths.push(state.backup); }
  }
  return { backup_cleanup_pending: backupPaths.length > 0, backup_paths: backupPaths };
}

export interface WebSnapshotOptions {
  url: string;
  screenshotPath: string;
  domPath?: string;
  viewport: { width: number; height: number };
  fullPage: boolean;
  waitUntil: "domcontentloaded" | "load" | "networkidle";
  networkPolicy: "local-only" | "allow-external";
  timeoutMs: number;
  allowExternal: boolean;
  overwrite: boolean;
  beforeCommit?: () => Promise<void>;
}

export async function webSnapshot(options: WebSnapshotOptions): Promise<Record<string, unknown>> {
  const targetUrl = validateWebSnapshotUrl(options.url, options.networkPolicy, options.allowExternal);
  const edgeExecutable = await detectEdgeExecutable();
  if (!edgeExecutable) throw new BridgeError("BROWSER_UNAVAILABLE", "Microsoft Edge was not found on this Windows node.");
  const screenshotTemporary = resolve(dirname(options.screenshotPath), `.${basename(options.screenshotPath)}.${randomUUID()}.mirabridge-stage`);
  const domTemporary = options.domPath ? resolve(dirname(options.domPath), `.${basename(options.domPath)}.${randomUUID()}.mirabridge-stage`) : undefined;
  const consoleErrors: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const blockedRequests: string[] = [];
  let browser: import("playwright-core").Browser | undefined;
  try {
    const { chromium } = await import("playwright-core");
    try { browser = await chromium.launch({ executablePath: edgeExecutable, headless: true }); }
    catch (error) { throw new BridgeError("BROWSER_UNAVAILABLE", "Microsoft Edge could not be launched through Playwright.", { cause: error }); }
    const context = await browser.newContext({ viewport: options.viewport, serviceWorkers: "block" });
    if (options.networkPolicy === "local-only") {
      await context.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        const allowedInternal = requestUrl.protocol === "data:" || requestUrl.protocol === "blob:" || requestUrl.protocol === "about:";
        if (allowedInternal || ((requestUrl.protocol === "http:" || requestUrl.protocol === "https:") && isLoopback(requestUrl.hostname))) await route.continue();
        else {
          if (blockedRequests.length < 100) blockedRequests.push(route.request().url());
          await route.abort("blockedbyclient");
        }
      });
    }
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < 200) consoleErrors.push({ type: message.type(), text: message.text().slice(0, 4096) });
    });
    page.on("pageerror", (error) => { if (pageErrors.length < 200) pageErrors.push(error.message.slice(0, 4096)); });
    const response = await page.goto(targetUrl.toString(), { waitUntil: options.waitUntil, timeout: options.timeoutMs });
    const finalUrl = new URL(page.url());
    const finalUrlText = page.url();
    if (options.networkPolicy === "local-only" && !isLoopback(finalUrl.hostname)) throw new BridgeError("PERMISSION_DENIED", "Page navigation redirected outside the local-only boundary.", { details: { final_url: page.url() } });
    const [title, bodyText, html, documentDimensions] = await Promise.all([
      page.title(),
      page.locator("body").evaluate((element, limit) => ((element as HTMLElement).innerText ?? "").slice(0, limit + 1), MAX_BODY_SUMMARY_CHARS).catch(() => ""),
      options.domPath ? page.evaluate((limit) => document.documentElement.outerHTML.slice(0, limit + 1), MAX_DOM_BYTES) : Promise.resolve(""),
      page.evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
        height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      })),
    ]);
    const captureWidth = options.fullPage ? documentDimensions.width : options.viewport.width;
    const captureHeight = options.fullPage ? documentDimensions.height : options.viewport.height;
    if (
      captureWidth <= 0 || captureHeight <= 0
      || captureWidth > MAX_SCREENSHOT_DIMENSION || captureHeight > MAX_SCREENSHOT_DIMENSION
      || captureWidth * captureHeight > MAX_SCREENSHOT_PIXELS
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "Rendered page dimensions exceed MiraBridge's bounded screenshot limit; use a viewport capture or reduce the page size.", {
        details: {
          capture_width: captureWidth,
          capture_height: captureHeight,
          max_dimension: MAX_SCREENSHOT_DIMENSION,
          max_pixels: MAX_SCREENSHOT_PIXELS,
        },
      });
    }
    await page.screenshot({ path: screenshotTemporary, type: "png", fullPage: options.fullPage });
    const screenshotStat = await stat(screenshotTemporary);
    if (screenshotStat.size > MAX_SCREENSHOT_BYTES) {
      throw new BridgeError("STORAGE_QUOTA_EXCEEDED", "Rendered screenshot exceeds the per-snapshot storage bound.", {
        details: { screenshot_bytes: screenshotStat.size, max_screenshot_bytes: MAX_SCREENSHOT_BYTES },
      });
    }
    const screenshotHandle = await open(screenshotTemporary, "r+");
    await screenshotHandle.sync();
    await screenshotHandle.close();
    let domTruncated = false;
    if (domTemporary) {
      const bounded = boundedUtf8(html, MAX_DOM_BYTES);
      const bytes = bounded.bytes;
      domTruncated = bounded.truncated || html.length > MAX_DOM_BYTES;
      const domHandle = await open(domTemporary, "wx", 0o600);
      try { await domHandle.writeFile(bytes); await domHandle.sync(); }
      finally { await domHandle.close(); }
    }
    await options.beforeCommit?.();
    const install = await installAtomicSet([
      { temporary: screenshotTemporary, destination: options.screenshotPath },
      ...(domTemporary && options.domPath ? [{ temporary: domTemporary, destination: options.domPath }] : []),
    ], options.overwrite);
    const screenshot = await stat(options.screenshotPath);
    const screenshotSha256 = await fileHash(options.screenshotPath);
    await context.close();
    return {
      status_code: response?.status() ?? null,
      final_url: finalUrlText,
      title: title.slice(0, 4096),
      body_summary: bodyText.slice(0, MAX_BODY_SUMMARY_CHARS),
      body_summary_truncated: bodyText.length > MAX_BODY_SUMMARY_CHARS,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      blocked_requests: blockedRequests,
      document_dimensions: documentDimensions,
      screenshot: { path: options.screenshotPath, bytes: screenshot.size, sha256: screenshotSha256, viewport: options.viewport, full_page: options.fullPage },
      dom: options.domPath ? { path: options.domPath, truncated: domTruncated } : null,
      ...install,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await rm(screenshotTemporary, { force: true }).catch(() => undefined);
    if (domTemporary) await rm(domTemporary, { force: true }).catch(() => undefined);
  }
}
