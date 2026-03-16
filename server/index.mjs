import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');

const AZURE_API_VERSION = '2024-02-01';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_MAX_POLL_ATTEMPTS = 12;

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

const extractImageAnalysisText = payload => {
  const blocks = payload?.readResult?.blocks;
  if (!Array.isArray(blocks)) {
    return '';
  }

  const lines = blocks.flatMap(block => (Array.isArray(block?.lines) ? block.lines : []));
  return lines
    .map(line => (typeof line?.text === 'string' ? line.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
};

const extractLegacyReadText = payload => {
  const pages = payload?.analyzeResult?.readResults;
  if (!Array.isArray(pages)) {
    return '';
  }

  const lines = pages.flatMap(page => (Array.isArray(page?.lines) ? page.lines : []));
  return lines
    .map(line => (typeof line?.text === 'string' ? line.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
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
  const imageAnalysisUrl = `${normalizeEndpoint(endpoint)}/computervision/imageanalysis:analyze?api-version=${AZURE_API_VERSION}&features=read&language=${encodeURIComponent(language)}`;

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

const app = express();
const startupConfig = getConfig();

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

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
  const configured = Boolean(config.endpoint && config.key);

  res.json({
    ok: true,
    azureConfigured: configured,
    endpointValid: !config.endpoint || isValidHttpUrl(config.endpoint),
    language: config.language,
    maxImageBytes: config.maxImageBytes,
  });
});

app.post(
  '/api/ocr/azure',
  express.raw({
    type: ['image/*', 'application/octet-stream'],
    limit: `${startupConfig.maxImageBytes}b`,
  }),
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

    const contentType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    const allowedContentType = contentType.startsWith('image/') || contentType === 'application/octet-stream';

    if (!allowedContentType) {
      res.status(415).json({
        error: 'Unsupported content type. Send an image binary body.',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({
        error: 'Request body must contain image binary data.',
        code: 'INVALID_IMAGE_BODY',
      });
      return;
    }

    if (req.body.length > config.maxImageBytes) {
      res.status(413).json({
        error: `Image is too large. Max bytes: ${config.maxImageBytes}.`,
        code: 'IMAGE_TOO_LARGE',
      });
      return;
    }

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
