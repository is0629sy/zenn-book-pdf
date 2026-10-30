#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_SCROLL_STEPS = 34;
const DEFAULT_IMAGE_WAIT_MS = 12000;
const DEFAULT_FONT_WAIT_MS = 8000;

function printUsage() {
  console.log(`Usage:
  npm run pdf -- <zenn-url>
  npm run pdf -- <zenn-url> <output-pdf-path>
  npm run pdf -- --url <zenn-url> --output <output-pdf-path>
  npm run pdf -- --url <zenn-url> --out <output-pdf-path>

<zenn-url> can be:
  - An article:         https://zenn.dev/<user>/articles/<slug>
  - A whole book:        https://zenn.dev/<user>/books/<slug>
    (all chapters are combined into a single PDF)
  - A single chapter:    https://zenn.dev/<user>/books/<slug>/viewer/<chapter-slug>

Example:
  npm run pdf -- https://zenn.dev/headwaters/articles/8bc4e8c3119fa3
  npm run pdf -- https://zenn.dev/headwaters/articles/8bc4e8c3119fa3 pdfs/gbrain.pdf
  npm run pdf -- https://zenn.dev/is0629sy/books/mirakura-shoei-03`);
}

function parseCliArgs(args) {
  const options = {
    url: "",
    output: "",
    timeout: DEFAULT_TIMEOUT_MS,
    debugHtml: "",
    help: false
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--url") {
      i += 1;
      options.url = args[i] || "";
      continue;
    }

    if (arg === "--output" || arg === "--out" || arg === "-o") {
      i += 1;
      options.output = args[i] || "";
      continue;
    }

    if (arg === "--timeout") {
      i += 1;
      options.timeout = Number(args[i] || DEFAULT_TIMEOUT_MS);
      continue;
    }

    if (arg === "--debug-html") {
      i += 1;
      options.debugHtml = args[i] || "";
      continue;
    }

    if (!options.url) {
      options.url = arg;
      continue;
    }

    if (!options.output) {
      options.output = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseZennUrl(rawUrl) {
  const url = new URL(rawUrl);
  const allowedHost = url.hostname === "zenn.dev" || url.hostname === "www.zenn.dev";

  if (!allowedHost) {
    throw new Error("The URL must be a zenn.dev URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const username = parts[0] || "";
  const articlesIndex = parts.indexOf("articles");
  const booksIndex = parts.indexOf("books");
  const viewerIndex = parts.indexOf("viewer");

  if (articlesIndex >= 0 && parts[articlesIndex + 1]) {
    return { kind: "article", url, username, slug: parts[articlesIndex + 1] };
  }

  if (booksIndex >= 0 && parts[booksIndex + 1]) {
    const bookSlug = parts[booksIndex + 1];

    if (viewerIndex >= 0 && parts[viewerIndex + 1]) {
      return { kind: "book-chapter", url, username, bookSlug, chapterSlug: parts[viewerIndex + 1] };
    }

    return { kind: "book", url, username, bookSlug };
  }

  throw new Error(
    "The URL must point to a Zenn article (https://zenn.dev/<user>/articles/<slug>) "
    + "or a Zenn book (https://zenn.dev/<user>/books/<slug> or https://zenn.dev/<user>/books/<slug>/viewer/<chapter-slug>)."
  );
}

function sanitizeFileName(value) {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return sanitized || "zenn-article";
}

function defaultOutputPath(target) {
  const author = sanitizeFileName(target.username || "zenn");

  if (target.kind === "article") {
    const slug = sanitizeFileName(target.slug || "article");
    return path.resolve("pdfs", `${author}_${slug}.pdf`);
  }

  const bookSlug = sanitizeFileName(target.bookSlug || "book");

  if (target.kind === "book-chapter") {
    const chapterSlug = sanitizeFileName(target.chapterSlug || "chapter");
    return path.resolve("pdfs", `${author}_${bookSlug}_${chapterSlug}.pdf`);
  }

  return path.resolve("pdfs", `${author}_${bookSlug}.pdf`);
}

function normalizeOutputPath(output, target) {
  const basePath = output ? path.resolve(output) : defaultOutputPath(target);

  if (basePath.toLowerCase().endsWith(".pdf")) {
    return basePath;
  }

  return `${basePath}.pdf`;
}

function ensureFiniteTimeout(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds.");
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function autoScroll(page) {
  let previousHeight = 0;

  for (let step = 0; step < DEFAULT_SCROLL_STEPS; step += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);

    if (height === previousHeight) {
      break;
    }

    previousHeight = height;
    await page.evaluate((nextHeight) => window.scrollTo(0, nextHeight), height);
    await page.waitForTimeout(300);
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
}

async function waitForImages(page, timeoutMs) {
  await page.evaluate(async (imageTimeoutMs) => {
    const images = Array.from(document.images);

    const imagePromises = images.map((image) => {
      if (image.complete && image.naturalWidth !== 0) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    });

    await Promise.race([
      Promise.all(imagePromises),
      new Promise((resolve) => window.setTimeout(resolve, imageTimeoutMs))
    ]);
  }, timeoutMs);
}

async function waitForFonts(page, timeoutMs) {
  await page.evaluate(async (fontTimeoutMs) => {
    if (!document.fonts || !document.fonts.ready) {
      return;
    }

    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => window.setTimeout(resolve, fontTimeoutMs))
    ]);
  }, timeoutMs);
}

const BASE_STYLES = `
@page {
  size: A4;
  margin: 16mm 15mm 17mm 15mm;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #1f2937;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "YuGothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
  font-size: 13.2px;
  line-height: 1.82;
  letter-spacing: 0.01em;
}

.zenn-pdf-article {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 0;
}

.zenn-pdf-header {
  margin: 0 0 26px 0;
  padding: 0 0 18px 0;
  border-bottom: 1px solid #e5e7eb;
}

.zenn-pdf-title {
  margin: 0 0 12px 0;
  color: #111827;
  font-size: 25px;
  font-weight: 800;
  line-height: 1.42;
  letter-spacing: 0;
}

.zenn-pdf-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  color: #6b7280;
  font-size: 11px;
  line-height: 1.6;
}

.zenn-pdf-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.zenn-pdf-tag {
  display: inline-block;
  padding: 2px 8px;
  border: 1px solid #dbeafe;
  border-radius: 999px;
  background: #eff6ff;
  color: #2563eb;
  font-size: 10.5px;
  line-height: 1.6;
}

.zenn-pdf-source-url {
  margin-top: 12px;
  color: #6b7280;
  font-size: 10.5px;
  overflow-wrap: anywhere;
}

.zenn-pdf-content {
  width: 100%;
  max-width: none;
}

.zenn-pdf-content > :first-child {
  margin-top: 0 !important;
}

h1,
h2,
h3,
h4,
h5,
h6 {
  color: #111827;
  font-weight: 800;
  line-height: 1.45;
  break-after: avoid;
  page-break-after: avoid;
}

h1 {
  font-size: 24px;
  margin: 34px 0 16px 0;
}

h2 {
  margin: 31px 0 14px 0;
  padding-bottom: 7px;
  border-bottom: 1px solid #e5e7eb;
  font-size: 19px;
}

h3 {
  margin: 25px 0 10px 0;
  font-size: 16px;
}

h4,
h5,
h6 {
  margin: 20px 0 8px 0;
  font-size: 14px;
}

p,
ul,
ol,
blockquote,
pre,
table,
figure,
details {
  margin-top: 0;
  margin-bottom: 15px;
}

p,
li,
blockquote,
td,
th {
  overflow-wrap: anywhere;
}

ul,
ol {
  padding-left: 1.5em;
}

li + li {
  margin-top: 4px;
}

a {
  color: #2563eb;
  text-decoration: none;
  overflow-wrap: anywhere;
}

img,
svg,
video,
canvas,
iframe {
  max-width: 100%;
  height: auto;
}

img,
figure,
pre,
table,
blockquote,
details {
  break-inside: avoid;
  page-break-inside: avoid;
}

figure {
  text-align: center;
}

figcaption {
  margin-top: 6px;
  color: #6b7280;
  font-size: 11px;
}

pre {
  max-width: 100%;
  padding: 13px 15px;
  border-radius: 7px;
  background: #111827;
  color: #f9fafb;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

pre code {
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: inherit;
  white-space: pre-wrap;
}

code {
  padding: 0.12em 0.35em;
  border-radius: 4px;
  background: #f3f4f6;
  color: #374151;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.88em;
  overflow-wrap: anywhere;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.2px;
}

th,
td {
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  vertical-align: top;
}

th {
  background: #f3f4f6;
  font-weight: 700;
}

blockquote {
  margin-left: 0;
  margin-right: 0;
  padding: 10px 14px;
  border-left: 4px solid #bfdbfe;
  background: #f8fafc;
  color: #374151;
}

hr {
  height: 1px;
  margin: 26px 0;
  border: 0;
  background: #e5e7eb;
}

details {
  padding: 9px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
}

summary {
  cursor: default;
  font-weight: 700;
}

.zenn-pdf-content [class*="embed"],
.zenn-pdf-content [class*="card"] {
  max-width: 100%;
}
`;

function buildStandaloneHtml(articleData) {
  const tagsHtml = articleData.tags
    .map((tag) => `<span class="zenn-pdf-tag">${escapeHtml(tag)}</span>`)
    .join("");

  const authorHtml = articleData.author
    ? `<div class="zenn-pdf-author">${escapeHtml(articleData.author)}</div>`
    : "";

  const publishedAtHtml = articleData.publishedAt
    ? `<div class="zenn-pdf-date">${escapeHtml(articleData.publishedAt)}</div>`
    : "";

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(articleData.title)}</title>
<style>
${BASE_STYLES}
</style>
</head>
<body>
<article class="zenn-pdf-article">
<header class="zenn-pdf-header">
<h1 class="zenn-pdf-title">${escapeHtml(articleData.title)}</h1>
<div class="zenn-pdf-meta">${authorHtml}${publishedAtHtml}</div>
${tagsHtml ? `<div class="zenn-pdf-tags">${tagsHtml}</div>` : ""}
<div class="zenn-pdf-source-url">${escapeHtml(articleData.url)}</div>
</header>
<section class="zenn-pdf-content znc">
${articleData.contentHtml}
</section>
</article>
</body>
</html>`;
}

const BOOK_EXTRA_STYLES = `
.zenn-pdf-cover {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 240mm;
  break-after: page;
  page-break-after: always;
}

.zenn-pdf-cover-label {
  margin-bottom: 14px;
  color: #6b7280;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.zenn-pdf-cover-title {
  margin: 0 0 20px 0;
  color: #111827;
  font-size: 30px;
  font-weight: 800;
  line-height: 1.4;
}

.zenn-pdf-cover-summary {
  margin: 0 0 20px 0;
  color: #374151;
  font-size: 13px;
  line-height: 1.8;
}

.zenn-pdf-toc {
  break-after: page;
  page-break-after: always;
}

.zenn-pdf-toc-heading {
  margin: 0 0 18px 0;
  font-size: 19px;
}

.zenn-pdf-toc-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.zenn-pdf-toc-list li {
  display: flex;
  gap: 10px;
  margin: 0 0 10px 0;
  padding-bottom: 8px;
  border-bottom: 1px dotted #d1d5db;
  font-size: 13px;
}

.zenn-pdf-toc-number {
  flex: none;
  color: #6b7280;
}

.zenn-pdf-chapter + .zenn-pdf-chapter {
  break-before: page;
  page-break-before: always;
}

.zenn-pdf-chapter-title {
  margin: 0 0 20px 0;
  padding-bottom: 10px;
  border-bottom: 2px solid #111827;
  color: #111827;
  font-size: 21px;
  font-weight: 800;
}
`;

function buildBookHtml(bookData, chapters) {
  const tagsHtml = bookData.tags
    .map((tag) => `<span class="zenn-pdf-tag">${escapeHtml(tag)}</span>`)
    .join("");

  const tocItemsHtml = chapters
    .map((chapter, index) => `<li><span class="zenn-pdf-toc-number">${index + 1}.</span><span>${escapeHtml(chapter.title)}</span></li>`)
    .join("");

  const chaptersHtml = chapters
    .map((chapter, index) => `<section class="zenn-pdf-chapter">
<h2 class="zenn-pdf-chapter-title">${index + 1}. ${escapeHtml(chapter.title)}</h2>
<div class="zenn-pdf-content znc">
${chapter.contentHtml}
</div>
</section>`)
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${escapeHtml(bookData.title)}</title>
<style>
${BASE_STYLES}
${BOOK_EXTRA_STYLES}
</style>
</head>
<body>
<article class="zenn-pdf-article">
<header class="zenn-pdf-cover">
<div class="zenn-pdf-cover-label">Zenn Book</div>
<h1 class="zenn-pdf-cover-title">${escapeHtml(bookData.title)}</h1>
${bookData.summary ? `<p class="zenn-pdf-cover-summary">${escapeHtml(bookData.summary)}</p>` : ""}
${tagsHtml ? `<div class="zenn-pdf-tags">${tagsHtml}</div>` : ""}
<div class="zenn-pdf-source-url">${escapeHtml(bookData.url)}</div>
</header>
<nav class="zenn-pdf-toc">
<h2 class="zenn-pdf-toc-heading">目次</h2>
<ol class="zenn-pdf-toc-list">
${tocItemsHtml}
</ol>
</nav>
${chaptersHtml}
</article>
</body>
</html>`;
}

async function extractArticleData(page, articleUrl) {
  return page.evaluate((sourceUrl) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const absoluteUrl = (value) => {
      if (!value) {
        return "";
      }
      return new URL(value, window.location.href).href;
    };

    const meta = (selector, attribute) => {
      const element = document.querySelector(selector);
      return element ? clean(element.getAttribute(attribute)) : "";
    };

    const article = document.querySelector("article") || document.body;
    const content = article.querySelector(".znc")
      || document.querySelector(".znc")
      || article.querySelector("[class*='ArticleBody']")
      || article.querySelector("[class*='article-body']")
      || article;

    const titleElement = article.querySelector("h1") || document.querySelector("h1");
    const ogTitle = meta("meta[property='og:title']", "content");
    const twitterTitle = meta("meta[name='twitter:title']", "content");
    const documentTitle = document.title || "Zenn article";
    const title = clean(titleElement?.textContent || ogTitle || twitterTitle || documentTitle)
      .replace(/\s*[|｜]\s*Zenn\s*$/i, "");

    const author = clean(
      meta("meta[name='author']", "content")
      || document.querySelector("a[href^='/'][href$='/articles']")?.textContent
      || document.querySelector("[class*='User']")?.textContent
      || ""
    );

    const publishedAt = clean(
      document.querySelector("time[datetime]")?.getAttribute("datetime")
      || document.querySelector("time")?.textContent
      || ""
    );

    const tagCandidates = Array.from(document.querySelectorAll("a[href*='/topics/'], a[href*='/tech-or-idea']"))
      .map((element) => clean(element.textContent).replace(/^#\s*/, ""))
      .filter(Boolean);
    const tags = Array.from(new Set(tagCandidates)).slice(0, 12);

    const clone = content.cloneNode(true);

    clone.querySelectorAll("script, style, noscript, template").forEach((element) => element.remove());
    clone.querySelectorAll("button, input, textarea, select").forEach((element) => element.remove());
    clone.querySelectorAll("[style]").forEach((element) => element.removeAttribute("style"));

    clone.querySelectorAll("a[href]").forEach((anchor) => {
      const href = absoluteUrl(anchor.getAttribute("href"));
      if (href) {
        anchor.setAttribute("href", href);
      }
    });

    clone.querySelectorAll("img").forEach((image) => {
      const src = image.currentSrc
        || image.getAttribute("src")
        || image.getAttribute("data-src")
        || image.getAttribute("data-original")
        || "";

      if (src) {
        image.setAttribute("src", absoluteUrl(src));
      }

      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      image.setAttribute("loading", "eager");
      image.setAttribute("decoding", "sync");
    });

    clone.querySelectorAll("source[src], source[srcset]").forEach((source) => {
      const src = source.getAttribute("src");
      const srcset = source.getAttribute("srcset");

      if (src) {
        source.setAttribute("src", absoluteUrl(src));
      }

      if (srcset) {
        source.setAttribute("srcset", srcset.split(",").map((part) => {
          const pieces = part.trim().split(/\s+/);
          const url = pieces.shift();
          return [absoluteUrl(url), ...pieces].join(" ");
        }).join(", "));
      }
    });

    clone.querySelectorAll("iframe[src]").forEach((iframe) => {
      const src = absoluteUrl(iframe.getAttribute("src"));
      if (src) {
        iframe.setAttribute("src", src);
      }
    });

    return {
      title,
      author,
      publishedAt,
      tags,
      url: sourceUrl,
      contentHtml: clone.innerHTML
    };
  }, articleUrl.href);
}

async function extractBookMeta(page, bookUrl) {
  return page.evaluate((sourceUrl) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

    const meta = (selector, attribute) => {
      const element = document.querySelector(selector);
      return element ? clean(element.getAttribute(attribute)) : "";
    };

    const titleElement = document.querySelector("h1");
    const ogTitle = meta("meta[property='og:title']", "content");
    const documentTitle = document.title || "Zenn book";
    const title = clean(titleElement?.textContent || ogTitle || documentTitle)
      .replace(/\s*[|｜]\s*Zenn\s*$/i, "");

    const summary = clean(
      meta("meta[property='og:description']", "content")
      || meta("meta[name='description']", "content")
      || ""
    );

    const tagCandidates = Array.from(document.querySelectorAll("a[href*='/topics/']"))
      .map((element) => clean(element.textContent).replace(/^#\s*/, ""))
      .filter(Boolean);
    const tags = Array.from(new Set(tagCandidates)).slice(0, 12);

    const seen = new Set();
    const chapterHrefs = [];
    document.querySelectorAll("a[href*='/viewer/']").forEach((anchor) => {
      const href = new URL(anchor.getAttribute("href"), window.location.href).href;
      if (!seen.has(href)) {
        seen.add(href);
        chapterHrefs.push(href);
      }
    });

    return { title, summary, tags, url: sourceUrl, chapterHrefs };
  }, bookUrl.href);
}

async function writeDebugHtml(debugHtmlPath, html) {
  if (!debugHtmlPath) {
    return;
  }

  const outputPath = path.resolve(debugHtmlPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
}

async function convertZennArticleToPdf(articleUrl, outputPath, timeout, debugHtmlPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log("[1/8] Launching Chromium.");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 1600
    },
    deviceScaleFactor: 1
  });

  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  console.log("[2/8] Opening the Zenn article page.");
  await page.goto(articleUrl.href, {
    waitUntil: "domcontentloaded",
    timeout
  });

  console.log("[3/8] Waiting for the article body.");
  await page.waitForSelector("article, .znc", { timeout });

  console.log("[4/8] Loading lazy content by scrolling.");
  await autoScroll(page);

  console.log("[5/8] Waiting briefly for images and fonts.");
  await waitForImages(page, DEFAULT_IMAGE_WAIT_MS);
  await waitForFonts(page, DEFAULT_FONT_WAIT_MS);

  console.log("[6/8] Extracting the article content.");
  const articleData = await extractArticleData(page, articleUrl);
  const html = buildStandaloneHtml(articleData);
  await writeDebugHtml(debugHtmlPath, html);

  console.log("[7/8] Building a printable standalone page.");
  await page.setContent(html, {
    waitUntil: "domcontentloaded",
    timeout
  });
  await waitForImages(page, DEFAULT_IMAGE_WAIT_MS);
  await waitForFonts(page, DEFAULT_FONT_WAIT_MS);

  console.log("[8/8] Writing the PDF file.");
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margin: {
      top: "16mm",
      right: "15mm",
      bottom: "17mm",
      left: "15mm"
    }
  });

  await browser.close();
}

async function convertZennBookToPdf(target, outputPath, timeout, debugHtmlPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  console.log("[1/6] Launching Chromium.");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 1600
    },
    deviceScaleFactor: 1
  });

  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(timeout);

  console.log("[2/6] Opening the Zenn book table of contents.");
  await page.goto(target.url.href, {
    waitUntil: "domcontentloaded",
    timeout
  });
  await page.waitForSelector("a[href*='/viewer/']", { state: "attached", timeout });

  const bookMeta = await extractBookMeta(page, target.url);

  if (bookMeta.chapterHrefs.length === 0) {
    throw new Error("No chapters were found on this Zenn book page.");
  }

  console.log(`[3/6] Found ${bookMeta.chapterHrefs.length} chapters.`);

  const chapters = [];

  for (let index = 0; index < bookMeta.chapterHrefs.length; index += 1) {
    const chapterUrl = new URL(bookMeta.chapterHrefs[index]);
    console.log(`[4/6] (${index + 1}/${bookMeta.chapterHrefs.length}) Fetching chapter: ${chapterUrl.href}`);

    await page.goto(chapterUrl.href, {
      waitUntil: "domcontentloaded",
      timeout
    });
    await page.waitForSelector("article, .znc", { timeout });
    await autoScroll(page);
    await waitForImages(page, DEFAULT_IMAGE_WAIT_MS);
    await waitForFonts(page, DEFAULT_FONT_WAIT_MS);

    chapters.push(await extractArticleData(page, chapterUrl));
  }

  console.log("[5/6] Building a printable standalone book.");
  const html = buildBookHtml(bookMeta, chapters);
  await writeDebugHtml(debugHtmlPath, html);

  await page.setContent(html, {
    waitUntil: "domcontentloaded",
    timeout
  });
  await waitForImages(page, DEFAULT_IMAGE_WAIT_MS);
  await waitForFonts(page, DEFAULT_FONT_WAIT_MS);

  console.log("[6/6] Writing the PDF file.");
  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margin: {
      top: "16mm",
      right: "15mm",
      bottom: "17mm",
      left: "15mm"
    }
  });

  await browser.close();
}

const options = parseCliArgs(process.argv.slice(2));

if (options.help || !options.url) {
  printUsage();
  process.exit(options.help ? 0 : 1);
}

ensureFiniteTimeout(options.timeout);

const target = parseZennUrl(options.url);
const outputPath = normalizeOutputPath(options.output, target);

console.log(`Input:  ${target.url.href}`);
console.log(`Output: ${outputPath}`);

if (target.kind === "book") {
  await convertZennBookToPdf(target, outputPath, options.timeout, options.debugHtml);
} else {
  await convertZennArticleToPdf(target.url, outputPath, options.timeout, options.debugHtml);
}

console.log("Done.");
