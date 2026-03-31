import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');

const AZURE_VISION_API_VERSION = '2024-02-01';
const DOCUMENT_INTELLIGENCE_API_VERSION = '2024-11-30';
const LEGACY_DOCUMENT_INTELLIGENCE_API_VERSION = '2023-07-31';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_POLL_ATTEMPTS = 12;
const GOOGLE_USER_INFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const HISTORY_STORE_DIR = path.join(workspaceRoot, '.data');
const HISTORY_STORE_PATH = path.join(HISTORY_STORE_DIR, 'google-history.json');
const MAX_HISTORY_ENTRIES = 200;

const normalizeEndpoint = endpoint => endpoint.replace(/\/+$/, '');
const normalizeOrigin = origin => origin.trim().replace(/\/+$/, '').toLowerCase();

const isValidHttpUrl = value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

const parseEnvNumber = (rawValue, fallback) => {
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
};

const parseEnvList = rawValue => {
  return String(rawValue || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
};

const firstNonEmptyEnv = (...keys) => {
  for (const key of keys) {
    const value = (process.env[key] || '').trim();
    if (value) {
      return value;
    }
  }

  return '';
};

const ensureDirectory = dirPath => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const readJsonFileSafe = filePath => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return null;
    }

    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJsonFileSafe = (filePath, value) => {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const readHistoryStore = () => {
  const parsed = readJsonFileSafe(HISTORY_STORE_PATH);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  return parsed;
};

const writeHistoryStore = store => {
  writeJsonFileSafe(HISTORY_STORE_PATH, store);
};

const toSafeString = (value, maxLength = 500) => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
};

const toSafeNumber = (value, fallback = 0, min = 0, max = 10000) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
};

const sanitizeHistoryAction = action => {
  const allowed = new Set(['extract', 'extract-and-append', 'export-create', 'export-append']);
  return allowed.has(action) ? action : 'extract';
};

const sanitizeHistoryEntry = rawEntry => {
  const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
  const createdAt = toSafeString(entry.createdAt, 64) || new Date().toISOString();
  return {
    id: toSafeString(entry.id, 96) || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt,
    action: sanitizeHistoryAction(toSafeString(entry.action, 64)),
    imageCount: toSafeNumber(entry.imageCount, 1, 1, 999),
    textPreview: toSafeString(entry.textPreview, 1200),
    ocrModel: toSafeString(entry.ocrModel, 80) || 'auto',
    targetDocId: toSafeString(entry.targetDocId, 128) || undefined,
    targetDocName: toSafeString(entry.targetDocName, 240) || undefined,
    ok: Boolean(entry.ok),
    error: toSafeString(entry.error, 800) || undefined,
  };
};

const sanitizeHistoryEntries = rawEntries => {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  return rawEntries
    .slice(0, MAX_HISTORY_ENTRIES)
    .map(sanitizeHistoryEntry)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
};

const getBearerToken = req => {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return '';
  }

  return authHeader.slice(7).trim();
};

const resolveGoogleUserFromAccessToken = async (accessToken, timeoutMs = 10000) => {
  const response = await fetchWithTimeout(
    GOOGLE_USER_INFO_URL,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    timeoutMs
  );

  if (!response.ok) {
    const details = await readResponseBody(response);
    throw new Error(`GOOGLE_AUTH_FAILED_${response.status}::${JSON.stringify(details || {})}`);
  }

  const payload = await response.json();
  const sub = toSafeString(payload?.sub, 128);
  const email = toSafeString(payload?.email, 320).toLowerCase();
  const id = sub || email;

  if (!id) {
    throw new Error('GOOGLE_AUTH_MISSING_USER_ID');
  }

  return {
    id,
    email,
    name: toSafeString(payload?.name, 320),
  };
};

const loadDotEnv = dotenvPath => {
  if (!fs.existsSync(dotenvPath)) {
    return;
  }

  const lines = fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex < 1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
};

loadDotEnv(path.join(workspaceRoot, '.env'));

const getConfig = () => {
  return {
    endpoint: firstNonEmptyEnv(
      'VISION_ENDPOINT',
      'VITE_AZURE_CV_ENDPOINT',
      'VITE_AZURE_VISION_ENDPOINT'
    ),
    key: firstNonEmptyEnv(
      'VISION_KEY',
      'VITE_AZURE_CV_KEY',
      'VITE_AZURE_VISION_KEY'
    ),
    language:
      firstNonEmptyEnv('VISION_LANGUAGE', 'VITE_AZURE_VISION_LANGUAGE') || 'en',
    documentIntelligenceEndpoint: firstNonEmptyEnv(
      'DOCUMENT_INTELLIGENCE_ENDPOINT',
      'AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT',
      'FORM_RECOGNIZER_ENDPOINT'
    ),
    documentIntelligenceKey: firstNonEmptyEnv(
      'DOCUMENT_INTELLIGENCE_KEY',
      'AZURE_DOCUMENT_INTELLIGENCE_KEY',
      'FORM_RECOGNIZER_KEY'
    ),
    documentIntelligenceModel:
      firstNonEmptyEnv(
        'DOCUMENT_INTELLIGENCE_MODEL',
        'AZURE_DOCUMENT_INTELLIGENCE_MODEL',
        'FORM_RECOGNIZER_MODEL'
      ) || 'prebuilt-read',
    port: parseEnvNumber(process.env.API_PORT || process.env.PORT, DEFAULT_PORT),
    maxImageBytes: parseEnvNumber(process.env.MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES),
    timeoutMs: parseEnvNumber(process.env.AZURE_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    pollIntervalMs: parseEnvNumber(process.env.AZURE_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
    maxPollAttempts: parseEnvNumber(process.env.AZURE_MAX_POLL_ATTEMPTS, DEFAULT_MAX_POLL_ATTEMPTS),
    allowedOrigins: parseEnvList(
      firstNonEmptyEnv('CORS_ALLOW_ORIGINS', 'CORS_ALLOW_ORIGIN')
    ),
  };
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('REQUEST_TIMEOUT');
    }

    throw error;
  } finally {
    clearTimeout(timerId);
  }
};

const readResponseBody = async response => {
  const rawBody = await response.text();

  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
};

const toNumberOrNull = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toXYPoint = point => {
  if (point && typeof point === 'object') {
    const x = toNumberOrNull(point.x);
    const y = toNumberOrNull(point.y);
    if (x !== null && y !== null) {
      return { x, y };
    }
  }

  return null;
};

const parsePolygonPoints = polygon => {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    return [];
  }

  if (typeof polygon[0] === 'number') {
    const points = [];
    for (let index = 0; index + 1 < polygon.length; index += 2) {
      const x = toNumberOrNull(polygon[index]);
      const y = toNumberOrNull(polygon[index + 1]);
      if (x !== null && y !== null) {
        points.push({ x, y });
      }
    }
    return points;
  }

  return polygon.map(toXYPoint).filter(Boolean);
};

const pointsToBounds = points => {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return null;
  }

  return { minX, maxX, minY, maxY };
};

const normalizeBounds = (bounds, width, height) => {
  if (!bounds) {
    return null;
  }

  const safeWidth = Number.isFinite(width) && width > 0 ? width : null;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : null;

  const minX = safeWidth ? bounds.minX / safeWidth : bounds.minX;
  const maxX = safeWidth ? bounds.maxX / safeWidth : bounds.maxX;
  const minY = safeHeight ? bounds.minY / safeHeight : bounds.minY;
  const maxY = safeHeight ? bounds.maxY / safeHeight : bounds.maxY;

  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return null;
  }

  if (!safeWidth || !safeHeight) {
    return { minX, maxX, minY, maxY };
  }

  return {
    minX: Math.min(Math.max(minX, 0), 1),
    maxX: Math.min(Math.max(maxX, 0), 1),
    minY: Math.min(Math.max(minY, 0), 1),
    maxY: Math.min(Math.max(maxY, 0), 1),
  };
};

const normalizeLineBounds = rawLines => {
  const rawMinX = Math.min(...rawLines.map(line => line.bounds.minX));
  const rawMaxX = Math.max(...rawLines.map(line => line.bounds.maxX));
  const rawMinY = Math.min(...rawLines.map(line => line.bounds.minY));
  const rawMaxY = Math.max(...rawLines.map(line => line.bounds.maxY));

  const alreadyNormalized =
    rawMinX >= 0 && rawMaxX <= 1.05 && rawMinY >= 0 && rawMaxY <= 1.05 && rawMaxX > 0 && rawMaxY > 0;

  if (alreadyNormalized) {
    return rawLines.map(line => ({
      ...line,
      bounds: {
        minX: Math.min(Math.max(line.bounds.minX, 0), 1),
        maxX: Math.min(Math.max(line.bounds.maxX, 0), 1),
        minY: Math.min(Math.max(line.bounds.minY, 0), 1),
        maxY: Math.min(Math.max(line.bounds.maxY, 0), 1),
      },
    }));
  }

  const spanX = rawMaxX - rawMinX;
  const spanY = rawMaxY - rawMinY;
  const safeSpanX = spanX > 0 ? spanX : 1;
  const safeSpanY = spanY > 0 ? spanY : 1;

  return rawLines.map(line => ({
    ...line,
    bounds: {
      minX: (line.bounds.minX - rawMinX) / safeSpanX,
      maxX: (line.bounds.maxX - rawMinX) / safeSpanX,
      minY: (line.bounds.minY - rawMinY) / safeSpanY,
      maxY: (line.bounds.maxY - rawMinY) / safeSpanY,
    },
  }));
};

const weightedQuantile = (items, selector, weightSelector, quantile) => {
  const normalizedQuantile = Math.min(Math.max(quantile, 0), 1);
  const sorted = items
    .map(item => ({
      value: selector(item),
      weight: Math.max(weightSelector(item), 0),
    }))
    .filter(item => Number.isFinite(item.value) && Number.isFinite(item.weight) && item.weight > 0)
    .sort((left, right) => left.value - right.value);

  if (sorted.length === 0) {
    return null;
  }

  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const threshold = totalWeight * normalizedQuantile;
  let cumulativeWeight = 0;

  for (const item of sorted) {
    cumulativeWeight += item.weight;
    if (cumulativeWeight >= threshold) {
      return item.value;
    }
  }

  return sorted[sorted.length - 1].value;
};

const lineToNormalizedMetrics = line => {
  const width = Math.max(0, line.bounds.maxX - line.bounds.minX);
  const height = Math.max(0, line.bounds.maxY - line.bounds.minY);
  return {
    ...line,
    width,
    height,
    centerX: line.bounds.minX + width / 2,
    centerY: line.bounds.minY + height / 2,
    textLength: line.text.length,
  };
};

const isLikelySlideNumber = line => {
  const trimmedText = line.text.trim();
  if (!trimmedText) {
    return false;
  }

  const plainNumberPattern = /^\d{1,3}$/;
  const fractionPattern = /^\d{1,3}\s*\/\s*\d{1,3}$/;
  const slideNumberPattern = /^(slide|page)\s*\d{1,3}$/i;
  const numberedLabelPattern = /^(slide|page)\s*\d{1,3}\s*\/\s*\d{1,3}$/i;
  const looksNumeric =
    plainNumberPattern.test(trimmedText) ||
    fractionPattern.test(trimmedText) ||
    slideNumberPattern.test(trimmedText) ||
    numberedLabelPattern.test(trimmedText);

  if (!looksNumeric) {
    return false;
  }

  const nearBottom = line.centerY > 0.86;
  const nearSides = line.centerX < 0.22 || line.centerX > 0.78;
  const shortToken = line.textLength <= 12;

  return nearBottom && nearSides && shortToken;
};

const focusSlideLines = rawLines => {
  const normalized = normalizeLineBounds(rawLines)
    .map(lineToNormalizedMetrics)
    .filter(line => line.textLength > 0);

  if (normalized.length < 4) {
    return normalized;
  }

  const weighted = normalized.map(line => ({
    ...line,
    weight: Math.max(1, Math.min(80, line.textLength)) * Math.max(0.01, line.height),
  }));

  const dominantXMin = weightedQuantile(
    weighted,
    line => line.bounds.minX,
    line => line.weight,
    0.08
  );
  const dominantXMax = weightedQuantile(
    weighted,
    line => line.bounds.maxX,
    line => line.weight,
    0.92
  );
  const dominantYMin = weightedQuantile(
    weighted,
    line => line.bounds.minY,
    line => line.weight,
    0.1
  );
  const dominantYMax = weightedQuantile(
    weighted,
    line => line.bounds.maxY,
    line => line.weight,
    0.9
  );

  const hasDominantBox =
    dominantXMin !== null &&
    dominantXMax !== null &&
    dominantYMin !== null &&
    dominantYMax !== null &&
    dominantXMax > dominantXMin &&
    dominantYMax > dominantYMin;

  const dominantBounds = hasDominantBox
    ? {
        minX: Math.max(0, dominantXMin - 0.03),
        maxX: Math.min(1, dominantXMax + 0.03),
        minY: Math.max(0, dominantYMin - 0.04),
        maxY: Math.min(1, dominantYMax + 0.04),
      }
    : null;

  const dominantLines = dominantBounds
    ? weighted.filter(
        line =>
          line.centerX >= dominantBounds.minX &&
          line.centerX <= dominantBounds.maxX &&
          line.centerY >= dominantBounds.minY &&
          line.centerY <= dominantBounds.maxY
      )
    : weighted;

  const withoutSlideNumbers = dominantLines.filter(line => !isLikelySlideNumber(line));

  // Avoid over-filtering by keeping the original text set if we removed too much.
  if (withoutSlideNumbers.length >= Math.max(3, Math.floor(normalized.length * 0.35))) {
    return withoutSlideNumbers;
  }

  return weighted;
};

const linesToText = lines => {
  return lines
    .map(line => line.text.trim())
    .filter(Boolean)
    .join('\n');
};

const extractImageAnalysisLines = payload => {
  const blocks = payload?.readResult?.blocks;
  if (!Array.isArray(blocks)) {
    return [];
  }

  const rawLines = blocks.flatMap(block => {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    return lines
      .map(line => {
        const text = typeof line?.text === 'string' ? line.text.trim() : '';
        const points = parsePolygonPoints(line?.boundingPolygon);
        const bounds = normalizeBounds(pointsToBounds(points), null, null);
        if (!text || !bounds) {
          return null;
        }

        return { text, bounds };
      })
      .filter(Boolean);
  });

  return rawLines;
};

const extractLegacyReadLines = payload => {
  const pages = payload?.analyzeResult?.readResults;
  if (!Array.isArray(pages)) {
    return [];
  }

  return pages.flatMap(page => {
    const width = toNumberOrNull(page?.width);
    const height = toNumberOrNull(page?.height);
    const lines = Array.isArray(page?.lines) ? page.lines : [];
    return lines
      .map(line => {
        const text = typeof line?.text === 'string' ? line.text.trim() : '';
        const points = parsePolygonPoints(line?.boundingBox);
        const bounds = normalizeBounds(pointsToBounds(points), width, height);
        if (!text || !bounds) {
          return null;
        }

        return { text, bounds };
      })
      .filter(Boolean);
  });
};

const extractDocumentIntelligenceLines = payload => {
  const pages = payload?.analyzeResult?.pages;
  if (!Array.isArray(pages)) {
    return [];
  }

  return pages.flatMap(page => {
    const width = toNumberOrNull(page?.width);
    const height = toNumberOrNull(page?.height);
    const lines = Array.isArray(page?.lines) ? page.lines : [];

    return lines
      .map(line => {
        const textCandidate =
          typeof line?.content === 'string'
            ? line.content
            : typeof line?.text === 'string'
              ? line.text
              : '';

        const text = textCandidate.trim();
        const points = parsePolygonPoints(line?.polygon || line?.boundingPolygon);
        const bounds = normalizeBounds(pointsToBounds(points), width, height);
        if (!text || !bounds) {
          return null;
        }

        return { text, bounds };
      })
      .filter(Boolean);
  });
};

const extractFocusedText = extractedLines => {
  if (!Array.isArray(extractedLines) || extractedLines.length === 0) {
    return '';
  }

  const focusedLines = focusSlideLines(extractedLines);
  return linesToText(focusedLines);
};

const extractImageAnalysisText = payload => {
  return extractFocusedText(extractImageAnalysisLines(payload));
};

const extractLegacyReadText = payload => {
  return extractFocusedText(extractLegacyReadLines(payload));
};

const extractDocumentIntelligenceText = payload => {
  const focusedText = extractFocusedText(extractDocumentIntelligenceLines(payload));
  if (focusedText) {
    return focusedText;
  }

  if (
    payload?.analyzeResult &&
    typeof payload.analyzeResult.content === 'string' &&
    payload.analyzeResult.content.trim()
  ) {
    return payload.analyzeResult.content.trim();
  }

  return '';
};

const toErrorString = payload => {
  if (!payload) {
    return '';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return 'Unknown Azure error';
  }
};

const buildAzureHeaders = (key, contentType) => ({
  'Content-Type': contentType,
  'Ocp-Apim-Subscription-Key': key,
});

const callImageAnalysisRead = async ({ endpoint, key, language, imageBuffer, contentType, timeoutMs }) => {
  const imageAnalysisUrl = `${normalizeEndpoint(endpoint)}/computervision/imageanalysis:analyze?api-version=${AZURE_VISION_API_VERSION}&features=read&language=${encodeURIComponent(language)}`;

  const response = await fetchWithTimeout(
    imageAnalysisUrl,
    {
      method: 'POST',
      headers: buildAzureHeaders(key, contentType),
      body: imageBuffer,
    },
    timeoutMs
  );

  const payload = await readResponseBody(response);
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
};

const callLegacyRead = async ({
  endpoint,
  key,
  language,
  imageBuffer,
  contentType,
  timeoutMs,
  pollIntervalMs,
  maxPollAttempts,
}) => {
  const analyzeUrl = `${normalizeEndpoint(endpoint)}/vision/v3.2/read/analyze?language=${encodeURIComponent(language)}`;

  const analyzeResponse = await fetchWithTimeout(
    analyzeUrl,
    {
      method: 'POST',
      headers: buildAzureHeaders(key, contentType),
      body: imageBuffer,
    },
    timeoutMs
  );

  if (!analyzeResponse.ok) {
    return {
      ok: false,
      status: analyzeResponse.status,
      payload: await readResponseBody(analyzeResponse),
    };
  }

  const operationLocation = analyzeResponse.headers.get('operation-location');
  if (!operationLocation) {
    return {
      ok: false,
      status: 502,
      payload: { error: 'Azure response did not include operation-location.' },
    };
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);

    const statusResponse = await fetchWithTimeout(
      operationLocation,
      {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
        },
      },
      timeoutMs
    );

    const statusPayload = await readResponseBody(statusResponse);

    if (!statusResponse.ok) {
      return {
        ok: false,
        status: statusResponse.status,
        payload: statusPayload,
      };
    }

    const statusValue = String(statusPayload?.status || '').toLowerCase();

    if (statusValue === 'succeeded') {
      return {
        ok: true,
        status: 200,
        payload: statusPayload,
      };
    }

    if (statusValue === 'failed') {
      return {
        ok: false,
        status: 502,
        payload: { error: 'Azure OCR failed while processing the image.' },
      };
    }
  }

  return {
    ok: false,
    status: 504,
    payload: { error: 'Azure OCR timed out while waiting for the result.' },
  };
};

const callDocumentIntelligenceReadAtUrl = async ({
  analyzeUrl,
  key,
  imageBuffer,
  contentType,
  timeoutMs,
  pollIntervalMs,
  maxPollAttempts,
}) => {
  const analyzeResponse = await fetchWithTimeout(
    analyzeUrl,
    {
      method: 'POST',
      headers: buildAzureHeaders(key, contentType),
      body: imageBuffer,
    },
    timeoutMs
  );

  if (!analyzeResponse.ok) {
    return {
      ok: false,
      status: analyzeResponse.status,
      payload: await readResponseBody(analyzeResponse),
    };
  }

  const operationLocation = analyzeResponse.headers.get('operation-location');
  if (!operationLocation) {
    return {
      ok: false,
      status: 502,
      payload: { error: 'Document Intelligence response did not include operation-location.' },
    };
  }

  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);

    const statusResponse = await fetchWithTimeout(
      operationLocation,
      {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
        },
      },
      timeoutMs
    );

    const statusPayload = await readResponseBody(statusResponse);

    if (!statusResponse.ok) {
      return {
        ok: false,
        status: statusResponse.status,
        payload: statusPayload,
      };
    }

    const statusValue = String(statusPayload?.status || '').toLowerCase();

    if (statusValue === 'succeeded') {
      return {
        ok: true,
        status: 200,
        payload: statusPayload,
      };
    }

    if (statusValue === 'failed') {
      return {
        ok: false,
        status: 502,
        payload: { error: 'Document Intelligence failed while processing the image.' },
      };
    }
  }

  return {
    ok: false,
    status: 504,
    payload: { error: 'Document Intelligence timed out while waiting for the result.' },
  };
};

const callDocumentIntelligenceRead = async ({
  endpoint,
  key,
  modelId,
  imageBuffer,
  contentType,
  timeoutMs,
  pollIntervalMs,
  maxPollAttempts,
}) => {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const encodedModelId = encodeURIComponent(modelId);
  const primaryUrl = `${normalizedEndpoint}/documentintelligence/documentModels/${encodedModelId}:analyze?api-version=${DOCUMENT_INTELLIGENCE_API_VERSION}`;

  const primaryResult = await callDocumentIntelligenceReadAtUrl({
    analyzeUrl: primaryUrl,
    key,
    imageBuffer,
    contentType,
    timeoutMs,
    pollIntervalMs,
    maxPollAttempts,
  });

  if (primaryResult.ok || primaryResult.status !== 404) {
    return primaryResult;
  }

  const legacyUrl = `${normalizedEndpoint}/formrecognizer/documentModels/${encodedModelId}:analyze?api-version=${LEGACY_DOCUMENT_INTELLIGENCE_API_VERSION}`;
  return callDocumentIntelligenceReadAtUrl({
    analyzeUrl: legacyUrl,
    key,
    imageBuffer,
    contentType,
    timeoutMs,
    pollIntervalMs,
    maxPollAttempts,
  });
};

const mapAzureError = (status, payload) => {
  if (status === 429) {
    return {
      status: 429,
      code: 'RATE_LIMIT',
      error: 'Azure rate limit reached.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 503,
      code: 'AZURE_AUTH_FAILED',
      error: 'Azure authentication failed. Check VISION_KEY.',
    };
  }

  if (status === 404) {
    return {
      status: 503,
      code: 'AZURE_ENDPOINT_UNAVAILABLE',
      error: 'Azure endpoint path is not available for this resource.',
    };
  }

  if (status === 400) {
    return {
      status: 400,
      code: 'AZURE_BAD_REQUEST',
      error: 'Azure rejected the image request.',
      details: toErrorString(payload),
    };
  }

  if (status === 504) {
    return {
      status: 504,
      code: 'REQUEST_TIMEOUT',
      error: 'Azure OCR timed out.',
    };
  }

  return {
    status: 502,
    code: 'AZURE_REQUEST_FAILED',
    error: 'Azure OCR request failed.',
    details: toErrorString(payload),
  };
};

const mapDocumentIntelligenceError = (status, payload) => {
  if (status === 429) {
    return {
      status: 429,
      code: 'RATE_LIMIT',
      error: 'Azure Document Intelligence rate limit reached.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 503,
      code: 'DOCUMENT_INTELLIGENCE_AUTH_FAILED',
      error: 'Azure Document Intelligence authentication failed. Check DOCUMENT_INTELLIGENCE_KEY.',
    };
  }

  if (status === 404) {
    return {
      status: 503,
      code: 'DOCUMENT_INTELLIGENCE_ENDPOINT_UNAVAILABLE',
      error: 'Azure Document Intelligence endpoint path is not available for this resource.',
    };
  }

  if (status === 400) {
    return {
      status: 400,
      code: 'DOCUMENT_INTELLIGENCE_BAD_REQUEST',
      error: 'Azure Document Intelligence rejected the image request.',
      details: toErrorString(payload),
    };
  }

  if (status === 504) {
    return {
      status: 504,
      code: 'REQUEST_TIMEOUT',
      error: 'Azure Document Intelligence timed out.',
    };
  }

  return {
    status: 502,
    code: 'DOCUMENT_INTELLIGENCE_REQUEST_FAILED',
    error: 'Azure Document Intelligence request failed.',
    details: toErrorString(payload),
  };
};

const validateImageRequest = (req, maxImageBytes) => {
  const contentType = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  const allowedContentType = contentType.startsWith('image/') || contentType === 'application/octet-stream';

  if (!allowedContentType) {
    return {
      ok: false,
      status: 415,
      payload: {
        error: 'Unsupported content type. Send an image binary body.',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      },
    };
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: 'Request body must contain image binary data.',
        code: 'INVALID_IMAGE_BODY',
      },
    };
  }

  if (req.body.length > maxImageBytes) {
    return {
      ok: false,
      status: 413,
      payload: {
        error: `Image is too large. Max bytes: ${maxImageBytes}.`,
        code: 'IMAGE_TOO_LARGE',
      },
    };
  }

  return {
    ok: true,
    contentType,
  };
};

const app = express();
const startupConfig = getConfig();
const rawImageBodyParser = express.raw({
  type: ['image/*', 'application/octet-stream'],
  limit: `${startupConfig.maxImageBytes}b`,
});

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const { allowedOrigins } = getConfig();

  if (allowedOrigins.length === 0) {
    next();
    return;
  }

  const requestOrigin = String(req.headers.origin || '').trim();
  const allowAnyOrigin = allowedOrigins.includes('*');
  const originAllowed =
    requestOrigin.length > 0 &&
    (allowAnyOrigin ||
      allowedOrigins.some(origin => normalizeOrigin(origin) === normalizeOrigin(requestOrigin)));

  if (originAllowed) {
    if (allowAnyOrigin) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.append('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') {
    if (!requestOrigin || originAllowed) {
      res.status(204).end();
      return;
    }

    res.status(403).json({
      error: 'Origin not allowed.',
      code: 'ORIGIN_NOT_ALLOWED',
    });
    return;
  }

  next();
});

app.get('/api/ocr/health', (_req, res) => {
  const config = getConfig();
  const visionConfigured = Boolean(config.endpoint && config.key);
  const documentIntelligenceConfigured = Boolean(
    config.documentIntelligenceEndpoint && config.documentIntelligenceKey
  );

  res.json({
    ok: true,
    azureConfigured: visionConfigured || documentIntelligenceConfigured,
    visionConfigured,
    visionEndpointValid: !config.endpoint || isValidHttpUrl(config.endpoint),
    documentIntelligenceConfigured,
    documentIntelligenceEndpointValid:
      !config.documentIntelligenceEndpoint || isValidHttpUrl(config.documentIntelligenceEndpoint),
    language: config.language,
    maxImageBytes: config.maxImageBytes,
  });
});

app.get('/api/history/google', async (req, res) => {
  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      res.status(401).json({
        error: 'Missing Google access token.',
        code: 'GOOGLE_AUTH_REQUIRED',
      });
      return;
    }

    const user = await resolveGoogleUserFromAccessToken(accessToken);
    const store = readHistoryStore();
    const entries = sanitizeHistoryEntries(store[user.id]);

    res.json({
      ok: true,
      user,
      entries,
    });
  } catch (error) {
    console.error('[api] history load failed:', error);
    res.status(401).json({
      error: 'Failed to verify Google account.',
      code: 'GOOGLE_AUTH_INVALID',
    });
  }
});

app.put('/api/history/google', async (req, res) => {
  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      res.status(401).json({
        error: 'Missing Google access token.',
        code: 'GOOGLE_AUTH_REQUIRED',
      });
      return;
    }

    const user = await resolveGoogleUserFromAccessToken(accessToken);
    const entries = sanitizeHistoryEntries(req.body?.entries);
    const store = readHistoryStore();
    store[user.id] = entries;
    writeHistoryStore(store);

    res.json({
      ok: true,
      count: entries.length,
    });
  } catch (error) {
    console.error('[api] history save failed:', error);
    res.status(401).json({
      error: 'Failed to verify Google account.',
      code: 'GOOGLE_AUTH_INVALID',
    });
  }
});

app.post(
  ['/api/ocr/azure', '/api/ocr/azure-vision'],
  rawImageBodyParser,
  async (req, res) => {
    const config = getConfig();
    const azureConfigured = Boolean(config.endpoint && config.key);

    if (!azureConfigured) {
      res.status(503).json({
        error: 'Azure OCR backend is not configured.',
        code: 'AZURE_NOT_CONFIGURED',
      });
      return;
    }

    if (!isValidHttpUrl(config.endpoint)) {
      res.status(503).json({
        error: 'Azure endpoint is invalid. Use full https://<resource>.cognitiveservices.azure.com URL.',
        code: 'AZURE_ENDPOINT_INVALID',
      });
      return;
    }

    const imageValidation = validateImageRequest(req, config.maxImageBytes);
    if (!imageValidation.ok) {
      res.status(imageValidation.status).json(imageValidation.payload);
      return;
    }

    const { contentType } = imageValidation;

    try {
      const imageAnalysisResult = await callImageAnalysisRead({
        endpoint: config.endpoint,
        key: config.key,
        language: config.language,
        imageBuffer: req.body,
        contentType,
        timeoutMs: config.timeoutMs,
      });

      if (imageAnalysisResult.ok) {
        res.json({
          text: extractImageAnalysisText(imageAnalysisResult.payload) || 'No text was found in the image.',
          source: 'azure-image-analysis-4.0',
          modelVersion:
            typeof imageAnalysisResult.payload?.modelVersion === 'string'
              ? imageAnalysisResult.payload.modelVersion
              : null,
        });
        return;
      }

      if (imageAnalysisResult.status === 429) {
        const mappedRateLimit = mapAzureError(imageAnalysisResult.status, imageAnalysisResult.payload);
        res.status(mappedRateLimit.status).json(mappedRateLimit);
        return;
      }

      // Keep compatibility with older Computer Vision resources when the 4.0 path is unavailable.
      const legacyResult = await callLegacyRead({
        endpoint: config.endpoint,
        key: config.key,
        language: config.language,
        imageBuffer: req.body,
        contentType,
        timeoutMs: config.timeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        maxPollAttempts: config.maxPollAttempts,
      });

      if (legacyResult.ok) {
        res.json({
          text: extractLegacyReadText(legacyResult.payload) || 'No text was found in the image.',
          source: 'azure-read-v3.2',
          modelVersion: null,
        });
        return;
      }

      const mappedLegacyError = mapAzureError(legacyResult.status, legacyResult.payload);
      res.status(mappedLegacyError.status).json(mappedLegacyError);
    } catch (error) {
      if (error instanceof Error && error.message === 'REQUEST_TIMEOUT') {
        const mappedTimeoutError = mapAzureError(504, { error: error.message });
        res.status(mappedTimeoutError.status).json(mappedTimeoutError);
        return;
      }

      const errorDetails =
        error instanceof Error && typeof error.message === 'string' && error.message.trim()
          ? error.message.trim()
          : 'Unknown error';

      console.error('[api] Azure OCR request failed:', errorDetails);

      res.status(502).json({
        error: 'Azure OCR request failed.',
        code: 'AZURE_REQUEST_FAILED',
        details: errorDetails,
      });
    }
  }
);

app.post('/api/ocr/document-intelligence', rawImageBodyParser, async (req, res) => {
  const config = getConfig();
  const documentIntelligenceConfigured = Boolean(
    config.documentIntelligenceEndpoint && config.documentIntelligenceKey
  );

  if (!documentIntelligenceConfigured) {
    res.status(503).json({
      error: 'Azure Document Intelligence backend is not configured.',
      code: 'DOCUMENT_INTELLIGENCE_NOT_CONFIGURED',
    });
    return;
  }

  if (!isValidHttpUrl(config.documentIntelligenceEndpoint)) {
    res.status(503).json({
      error:
        'Azure Document Intelligence endpoint is invalid. Use full https://<resource>.cognitiveservices.azure.com URL.',
      code: 'DOCUMENT_INTELLIGENCE_ENDPOINT_INVALID',
    });
    return;
  }

  const imageValidation = validateImageRequest(req, config.maxImageBytes);
  if (!imageValidation.ok) {
    res.status(imageValidation.status).json(imageValidation.payload);
    return;
  }

  const { contentType } = imageValidation;

  try {
    const documentIntelligenceResult = await callDocumentIntelligenceRead({
      endpoint: config.documentIntelligenceEndpoint,
      key: config.documentIntelligenceKey,
      modelId: config.documentIntelligenceModel,
      imageBuffer: req.body,
      contentType,
      timeoutMs: config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      maxPollAttempts: config.maxPollAttempts,
    });

    if (documentIntelligenceResult.ok) {
      res.json({
        text:
          extractDocumentIntelligenceText(documentIntelligenceResult.payload) ||
          'No text was found in the image.',
        source: 'azure-document-intelligence',
        modelVersion:
          typeof documentIntelligenceResult.payload?.modelId === 'string'
            ? documentIntelligenceResult.payload.modelId
            : config.documentIntelligenceModel,
      });
      return;
    }

    const mappedError = mapDocumentIntelligenceError(
      documentIntelligenceResult.status,
      documentIntelligenceResult.payload
    );
    res.status(mappedError.status).json(mappedError);
  } catch (error) {
    if (error instanceof Error && error.message === 'REQUEST_TIMEOUT') {
      const mappedTimeoutError = mapDocumentIntelligenceError(504, { error: error.message });
      res.status(mappedTimeoutError.status).json(mappedTimeoutError);
      return;
    }

    const errorDetails =
      error instanceof Error && typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'Unknown error';

    console.error('[api] Azure Document Intelligence request failed:', errorDetails);

    res.status(502).json({
      error: 'Azure Document Intelligence request failed.',
      code: 'DOCUMENT_INTELLIGENCE_REQUEST_FAILED',
      details: errorDetails,
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    const { maxImageBytes } = getConfig();
    res.status(413).json({
      error: `Image is too large. Max bytes: ${maxImageBytes}.`,
      code: 'IMAGE_TOO_LARGE',
    });
    return;
  }

  res.status(500).json({
    error: 'Unexpected backend error.',
    code: 'INTERNAL_SERVER_ERROR',
  });
});

const { port } = getConfig();
app.listen(port, () => {
  // Avoid logging secrets; only show service state.
  console.log(`[api] OCR backend listening on http://localhost:${port}`);
});
