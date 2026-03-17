import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Upload,
  FileText,
  Check,
  Copy,
  Loader2,
  X,
  ImagePlus,
  SwitchCamera,
  CameraOff,
  LogIn,
  LogOut,
  FileUp,
  ExternalLink,
  ChevronDown,
} from 'lucide-react';
import Tesseract from 'tesseract.js';

type AppState = 'idle' | 'ready' | 'extracting' | 'done';

type OcrEngine = 'azure-vision' | 'azure-document-intelligence' | 'tesseract';

type OcrModelPreference = 'auto' | OcrEngine;

type AzureBackendOcrResponse = {
  text?: string;
  source?: string;
  modelVersion?: string | null;
  error?: string;
  code?: string;
  details?: string;
};

type AzureBackendHealthResponse = {
  azureConfigured?: boolean;
  visionConfigured?: boolean;
  documentIntelligenceConfigured?: boolean;
  visionEndpointValid?: boolean;
  documentIntelligenceEndpointValid?: boolean;
};

type AzureBackendStatus = 'checking' | 'configured' | 'not-configured' | 'unreachable';

type GoogleAuthStatus = 'disabled' | 'loading' | 'ready' | 'error';

type GoogleExportStatus =
  | 'idle'
  | 'authorizing'
  | 'creating-doc'
  | 'writing-doc'
  | 'done'
  | 'error';

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: '' | 'consent' }) => void;
};

type GoogleOauth2 = {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string }) => void;
  }) => GoogleTokenClient;
  revoke: (token: string, done?: () => void) => void;
};

type GoogleApiWindow = Window & {
  google?: {
    accounts?: {
      oauth2?: GoogleOauth2;
    };
  };
};

type GoogleDriveFileCreateResponse = {
  id?: string;
  webViewLink?: string;
};

type GoogleApiErrorResponse = {
  error?: {
    message?: string;
  } | string;
};

type AppEnv = {
  VITE_API_BASE_URL?: string;
  VITE_GOOGLE_CLIENT_ID?: string;
  VITE_GOOGLE_DRIVE_FOLDER_ID?: string;
};

const MIN_CAMERA_ZOOM = 1;
const MAX_CAMERA_ZOOM = 3;
const appEnv = (import.meta as { env?: AppEnv }).env || {};
const API_BASE_URL = (appEnv.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
const GOOGLE_CLIENT_ID = (appEnv.VITE_GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_DRIVE_FOLDER_ID = (appEnv.VITE_GOOGLE_DRIVE_FOLDER_ID || '').trim();
const GOOGLE_CLIENT_ID_SETUP_HINT =
  'Set VITE_GOOGLE_CLIENT_ID in your build environment. For GitHub Pages, add it in Settings > Secrets and variables > Actions, then redeploy.';
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
].join(' ');
const GOOGLE_IDENTITY_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const OCR_MODEL_OPTIONS: Array<{
  id: OcrModelPreference;
  label: string;
  description: string;
}> = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Try AI Vision, then Document Intelligence, then on-device OCR.',
  },
  {
    id: 'azure-vision',
    label: 'AI Vision',
    description: 'Fast Azure OCR for photos, screenshots, and mixed scenes.',
  },
  {
    id: 'azure-document-intelligence',
    label: 'Document Intelligence',
    description: 'Azure document-focused OCR for dense notes and structured pages.',
  },
  {
    id: 'tesseract',
    label: 'Tesseract',
    description: 'On-device OCR with no backend dependency.',
  },
];

const clampZoom = (zoomValue: number) => Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, zoomValue));
const getApiUrl = (path: string) => `${API_BASE_URL}${path}`;

const getOcrModelLabel = (model: OcrModelPreference | OcrEngine) => {
  switch (model) {
    case 'auto':
      return 'Auto';
    case 'azure-vision':
      return 'Azure AI Vision';
    case 'azure-document-intelligence':
      return 'Azure Document Intelligence';
    case 'tesseract':
      return 'Tesseract';
    default:
      return 'OCR';
  }
};

const getTouchDistance = (touches: React.TouchList) => {
  const [firstTouch, secondTouch] = [touches[0], touches[1]];
  const deltaX = firstTouch.clientX - secondTouch.clientX;
  const deltaY = firstTouch.clientY - secondTouch.clientY;
  return Math.hypot(deltaX, deltaY);
};

const toRemoteOcrFailureReason = (
  model: 'azure-vision' | 'azure-document-intelligence',
  errorMessage: string
) => {
  const serviceLabel = getOcrModelLabel(model);
  const missingConfigMessage =
    model === 'azure-document-intelligence'
      ? 'Backend is missing DOCUMENT_INTELLIGENCE_ENDPOINT or DOCUMENT_INTELLIGENCE_KEY.'
      : 'Backend is missing VISION_ENDPOINT or VISION_KEY.';
  const invalidEndpointMessage =
    model === 'azure-document-intelligence'
      ? 'Backend DOCUMENT_INTELLIGENCE_ENDPOINT is invalid.'
      : 'Backend VISION_ENDPOINT is invalid.';

  if (!errorMessage) {
    return `${serviceLabel} request failed.`;
  }

  const normalizedMessage = errorMessage.toLowerCase();

  if (errorMessage === 'RATE_LIMIT') {
    return `${serviceLabel} rate limit reached.`;
  }

  if (errorMessage === 'AZURE_NOT_CONFIGURED' || errorMessage === 'DOCUMENT_INTELLIGENCE_NOT_CONFIGURED') {
    return missingConfigMessage;
  }

  if (errorMessage === 'AZURE_AUTH_FAILED' || errorMessage === 'DOCUMENT_INTELLIGENCE_AUTH_FAILED') {
    return `${serviceLabel} credentials are invalid.`;
  }

  if (
    errorMessage === 'AZURE_ENDPOINT_UNAVAILABLE' ||
    errorMessage === 'DOCUMENT_INTELLIGENCE_ENDPOINT_UNAVAILABLE'
  ) {
    return `${serviceLabel} endpoint path is not available for this resource.`;
  }

  if (errorMessage === 'AZURE_ENDPOINT_INVALID' || errorMessage === 'DOCUMENT_INTELLIGENCE_ENDPOINT_INVALID') {
    return invalidEndpointMessage;
  }

  if (errorMessage === 'AZURE_BAD_REQUEST' || errorMessage === 'DOCUMENT_INTELLIGENCE_BAD_REQUEST') {
    return `${serviceLabel} rejected this image request.`;
  }

  if (
    errorMessage === 'AZURE_REQUEST_FAILED' ||
    errorMessage === 'DOCUMENT_INTELLIGENCE_REQUEST_FAILED'
  ) {
    return `${serviceLabel} request failed on the backend.`;
  }

  if (errorMessage === 'REQUEST_TIMEOUT') {
    return `${serviceLabel} timed out.`;
  }

  if (errorMessage === 'IMAGE_TOO_LARGE') {
    return 'Image is too large for backend upload limits.';
  }

  if (errorMessage === 'UNSUPPORTED_MEDIA_TYPE' || errorMessage === 'INVALID_IMAGE_BODY') {
    return 'Unsupported image format.';
  }

  if (normalizedMessage.includes('failed to fetch')) {
    return 'OCR backend is unreachable.';
  }

  if (normalizedMessage.includes('timeout')) {
    return `${serviceLabel} timed out.`;
  }

  return `${serviceLabel} request failed.`;
};

const describeRemoteOcrSource = (payload: AzureBackendOcrResponse) => {
  if (payload.source === 'azure-read-v3.2') {
    return 'Using legacy Azure Read v3.2 fallback.';
  }

  if (payload.modelVersion) {
    return `Model: ${payload.modelVersion}`;
  }

  return '';
};

const normalizeExtractedText = (text: string) => {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const buildGoogleDocTitle = () => {
  const now = new Date();
  const date = now.toLocaleDateString();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Photo Note ${date} ${time}`;
};

const loadGoogleIdentityScript = async () => {
  const googleWindow = window as GoogleApiWindow;
  if (googleWindow.google?.accounts?.oauth2) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: number | null = null;

    const settle = (next: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      next();
    };

    const onReady = () => {
      const oauth2 = (window as GoogleApiWindow).google?.accounts?.oauth2;
      if (!oauth2) {
        settle(() => reject(new Error('Google Identity Services is unavailable.')));
        return;
      }

      settle(resolve);
    };

    const onError = () => {
      settle(() => reject(new Error('Failed to load Google Identity Services script.')));
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT_SRC}"]`
    );

    if (existingScript) {
      if ((window as GoogleApiWindow).google?.accounts?.oauth2) {
        resolve();
        return;
      }

      existingScript.addEventListener('load', onReady, { once: true });
      existingScript.addEventListener('error', onError, { once: true });
      timeoutId = window.setTimeout(onReady, 3000);
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', onReady, { once: true });
    script.addEventListener('error', onError, { once: true });
    document.head.appendChild(script);
  });
};

const toGoogleApiErrorMessage = async (response: Response, fallbackMessage: string) => {
  try {
    const payload = (await response.json()) as GoogleApiErrorResponse;

    if (typeof payload.error === 'string' && payload.error.trim()) {
      return `${payload.error.trim()} (HTTP ${response.status})`;
    }

    if (
      payload.error &&
      typeof payload.error === 'object' &&
      typeof payload.error.message === 'string' &&
      payload.error.message.trim()
    ) {
      return `${payload.error.message.trim()} (HTTP ${response.status})`;
    }
  } catch {
    // Ignore JSON parse failures and return fallback message.
  }

  return `${fallbackMessage} (HTTP ${response.status})`;
};

export default function App() {
  const [status, setStatus] = useState<AppState>('idle');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string>('');
  const [ocrEngine, setOcrEngine] = useState<OcrEngine | null>(null);
  const [ocrModelPreference, setOcrModelPreference] = useState<OcrModelPreference>('auto');
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(true);
  const [ocrFallbackReason, setOcrFallbackReason] = useState('');
  const [ocrSourceInfo, setOcrSourceInfo] = useState('');
  const [copied, setCopied] = useState(false);
  const [azureBackendStatus, setAzureBackendStatus] = useState<AzureBackendStatus>('checking');
  const [visionBackendConfigured, setVisionBackendConfigured] = useState(false);
  const [documentIntelligenceBackendConfigured, setDocumentIntelligenceBackendConfigured] = useState(false);
  
  // OCR State
  const [ocrStatusMsg, setOcrStatusMsg] = useState<string>('Initializing OCR...');
  const [ocrProgress, setOcrProgress] = useState<number>(0);
  
  // Camera & Drag State
  const [isCameraActive, setCameraActive] = useState(false);
  const [isCameraPreviewReady, setCameraPreviewReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraZoom, setCameraZoom] = useState<number>(1);
  const [isDragging, setIsDragging] = useState(false);
  const [googleAuthStatus, setGoogleAuthStatus] = useState<GoogleAuthStatus>(
    GOOGLE_CLIENT_ID ? 'loading' : 'disabled'
  );
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [googleAccessTokenExpiresAt, setGoogleAccessTokenExpiresAt] = useState(0);
  const [googleExportStatus, setGoogleExportStatus] = useState<GoogleExportStatus>('idle');
  const [googleExportError, setGoogleExportError] = useState('');
  const [googleDocUrl, setGoogleDocUrl] = useState('');
  const [googleDocTitle, setGoogleDocTitle] = useState('');
  const [googleDocs, setGoogleDocs] = useState<Array<{ id: string; name: string; webViewLink?: string }>>([]);
  const [googleDocsLoading, setGoogleDocsLoading] = useState(false);
  const [selectedGoogleDocId, setSelectedGoogleDocId] = useState<string | null>(null);
  const [googleExportMode, setGoogleExportMode] = useState<'create' | 'append'>('create');
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);

  const resetGoogleExportFeedback = () => {
    setGoogleExportStatus('idle');
    setGoogleExportError('');
    setGoogleDocUrl('');
    setGoogleDocTitle('');
  };

  const startCamera = async (mode: 'environment' | 'user') => {
    stopCamera();
    setCameraZoom(1);
    setCameraPreviewReady(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {
          // Browser autoplay policies can block immediate play; loaded data handler can recover.
        });
      }
      streamRef.current = stream;
      setCameraActive(true);
      setCameraError('');
    } catch (err) {
      console.error("Camera error:", err);
      setCameraError('Camera access denied or unavailable.');
      setCameraActive(false);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
    setCameraPreviewReady(false);
  };

  useEffect(() => {
    if (status === 'idle') {
      startCamera(facingMode);
    } else {
      stopCamera();
    }
    return () => stopCamera();
  }, [status]);

  const toggleCamera = () => {
    const newMode = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(newMode);
    startCamera(newMode);
  };

  const handleVideoReady = () => {
    setCameraPreviewReady(true);
    setCameraError('');
  };

  const handleCameraTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 2) {
      return;
    }

    pinchStartDistanceRef.current = getTouchDistance(e.touches);
    pinchStartZoomRef.current = cameraZoom;
  };

  const handleCameraTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 2 || pinchStartDistanceRef.current === null) {
      return;
    }

    e.preventDefault();
    const currentDistance = getTouchDistance(e.touches);
    const zoomMultiplier = currentDistance / pinchStartDistanceRef.current;
    const nextZoom = clampZoom(pinchStartZoomRef.current * zoomMultiplier);
    setCameraZoom(nextZoom);
  };

  const handleCameraTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchStartDistanceRef.current = null;
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const sourceWidth = video.videoWidth / cameraZoom;
        const sourceHeight = video.videoHeight / cameraZoom;
        const sourceX = (video.videoWidth - sourceWidth) / 2;
        const sourceY = (video.videoHeight - sourceHeight) / 2;

        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // If user mode, flip the image horizontally.
        if (facingMode === 'user') {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }

        ctx.drawImage(
          video,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );
        ctx.restore();

        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
        setImageSrc(dataUrl);
        setStatus('ready');
        resetGoogleExportFeedback();
      }
    }
  };

  const setSelectedImage = (file: File) => {
    if (!file.type.startsWith('image/')) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result !== 'string') {
        return;
      }

      setImageSrc(result);
      setStatus('ready');
      setExtractedText('');
      setOcrEngine(null);
      setOcrFallbackReason('');
      setOcrSourceInfo('');
      setOcrProgress(0);
      setCopied(false);
      resetGoogleExportFeedback();
    };
    reader.readAsDataURL(file);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Handle manual file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedImage(file);
    }
  };

  // Drag and Drop Handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setSelectedImage(file);
    }
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (status === 'extracting') {
        return;
      }

      const clipboardItems = event.clipboardData?.items;
      if (!clipboardItems) {
        return;
      }

      for (let index = 0; index < clipboardItems.length; index += 1) {
        const item = clipboardItems[index];
        if (item.kind !== 'file' || !item.type.startsWith('image/')) {
          continue;
        }

        const pastedImage = item.getAsFile();
        if (!pastedImage) {
          continue;
        }

        event.preventDefault();
        setSelectedImage(pastedImage);
        break;
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [status]);

  useEffect(() => {
    if (status !== 'idle' || !isCameraActive || isCameraPreviewReady) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCameraError('Camera preview not available. Please upload an image instead.');
      setCameraActive(false);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [status, isCameraActive, isCameraPreviewReady]);

  useEffect(() => {
    let isCancelled = false;

    const refreshBackendHealth = async () => {
      try {
        const response = await fetch(getApiUrl('/api/ocr/health'));

        if (!response.ok) {
          throw new Error(`HTTP_${response.status}`);
        }

        const payload = (await response.json()) as AzureBackendHealthResponse;
        if (!isCancelled) {
          const hasVision = Boolean(payload.visionConfigured);
          const hasDocumentIntelligence = Boolean(payload.documentIntelligenceConfigured);

          setVisionBackendConfigured(hasVision);
          setDocumentIntelligenceBackendConfigured(hasDocumentIntelligence);
          setAzureBackendStatus(hasVision || hasDocumentIntelligence ? 'configured' : 'not-configured');
        }
      } catch {
        if (!isCancelled) {
          setAzureBackendStatus('unreachable');
          setVisionBackendConfigured(false);
          setDocumentIntelligenceBackendConfigured(false);
        }
      }
    };

    refreshBackendHealth();
    window.addEventListener('online', refreshBackendHealth);

    return () => {
      isCancelled = true;
      window.removeEventListener('online', refreshBackendHealth);
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;

    if (!GOOGLE_CLIENT_ID) {
      setGoogleAuthStatus('disabled');
      return;
    }

    const initializeGoogleIdentity = async () => {
      setGoogleAuthStatus('loading');

      try {
        await loadGoogleIdentityScript();

        if (!isCancelled) {
          setGoogleAuthStatus('ready');
        }
      } catch (error) {
        console.error('Google Identity init error:', error);

        if (!isCancelled) {
          setGoogleAuthStatus('error');
          setGoogleExportError('Google Sign-In is unavailable. Check your OAuth client setup.');
        }
      }
    };

    initializeGoogleIdentity();

    return () => {
      isCancelled = true;
    };
  }, []);

  const getGoogleOauth2 = () => {
    const oauth2 = (window as GoogleApiWindow).google?.accounts?.oauth2;
    if (!oauth2) {
      throw new Error('Google Sign-In is not ready yet.');
    }

    return oauth2;
  };

  const requestGoogleAccessToken = async (prompt: '' | 'consent') => {
    if (!GOOGLE_CLIENT_ID) {
      throw new Error('Google Docs export is not configured.');
    }

    const oauth2 = getGoogleOauth2();

    const tokenResponse = await new Promise<GoogleTokenResponse>((resolve, reject) => {
      const tokenClient = oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_OAUTH_SCOPES,
        callback: response => resolve(response),
        error_callback: () => reject(new Error('Google sign-in was canceled or blocked.')),
      });

      tokenClient.requestAccessToken({ prompt });
    });

    if (!tokenResponse.access_token) {
      throw new Error(
        tokenResponse.error_description ||
          tokenResponse.error ||
          'Failed to receive a Google access token.'
      );
    }

    const expiresInSeconds = Number(tokenResponse.expires_in) || 3600;
    setGoogleAccessToken(tokenResponse.access_token);
    setGoogleAccessTokenExpiresAt(Date.now() + expiresInSeconds * 1000);
    setGoogleAuthStatus('ready');

    return tokenResponse.access_token;
  };

  const ensureGoogleAccessToken = async () => {
    const hasValidToken =
      Boolean(googleAccessToken) && googleAccessTokenExpiresAt > Date.now() + 15000;

    if (hasValidToken && googleAccessToken) {
      return googleAccessToken;
    }

    return requestGoogleAccessToken(googleAccessToken ? '' : 'consent');
  };

  const createGoogleDoc = async (accessToken: string, title: string) => {
    const requestBody: {
      name: string;
      mimeType: string;
      parents?: string[];
    } = {
      name: title,
      mimeType: 'application/vnd.google-apps.document',
    };

    if (GOOGLE_DRIVE_FOLDER_ID) {
      requestBody.parents = [GOOGLE_DRIVE_FOLDER_ID];
    }

    const response = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(await toGoogleApiErrorMessage(response, 'Failed to create a Google Doc'));
    }

    const createdDoc = (await response.json()) as GoogleDriveFileCreateResponse;

    if (!createdDoc.id) {
      throw new Error('Google Drive API did not return a document ID.');
    }

    return createdDoc;
  };

  const insertTextIntoGoogleDoc = async (accessToken: string, documentId: string, rawText: string) => {
    const heading = 'Photo Note OCR';
    const subtitle = `Created ${new Date().toLocaleString()}`;
    const body = normalizeExtractedText(rawText) || 'No text was extracted.';
    const composedText = `${heading}\n${subtitle}\n\n${body}\n`;

    const headingStart = 1;
    const headingEnd = headingStart + heading.length;
    const subtitleStart = headingEnd + 1;
    const subtitleEnd = subtitleStart + subtitle.length;

    const response = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index: 1 },
              text: composedText,
            },
          },
          {
            updateParagraphStyle: {
              range: {
                startIndex: headingStart,
                endIndex: headingEnd,
              },
              paragraphStyle: {
                namedStyleType: 'HEADING_1',
              },
              fields: 'namedStyleType',
            },
          },
          {
            updateParagraphStyle: {
              range: {
                startIndex: subtitleStart,
                endIndex: subtitleEnd,
              },
              paragraphStyle: {
                namedStyleType: 'SUBTITLE',
              },
              fields: 'namedStyleType',
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        await toGoogleApiErrorMessage(response, 'Failed to insert OCR text into the Google Doc')
      );
    }
  };

  const listGoogleDocs = async (accessToken: string) => {
    try {
      const response = await fetch(
        'https://www.googleapis.com/drive/v3/files?q=mimeType%3D%22application%2Fvnd.google-apps.document%22&fields=files(id,name,webViewLink)&pageSize=50&orderBy=modifiedTime%20desc',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          await toGoogleApiErrorMessage(response, 'Failed to list Google Docs')
        );
      }

      const data = (await response.json()) as { files?: Array<{ id: string; name: string; webViewLink?: string }> };
      return data.files || [];
    } catch (error) {
      console.error('Error listing Google Docs:', error);
      throw error;
    }
  };

  const appendTextToGoogleDoc = async (accessToken: string, documentId: string, rawText: string) => {
    const timestamp = new Date().toLocaleString();
    const entryText = `\n\n--- Note Entry (${timestamp}) ---\n${normalizeExtractedText(rawText) || 'No text was extracted.'}\n`;

    const response = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              // Let Docs append at the end of the body segment to avoid index-edge errors.
              endOfSegmentLocation: {},
              text: entryText,
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        await toGoogleApiErrorMessage(response, 'Failed to append text to the Google Doc')
      );
    }
  };

  const handleGoogleSignIn = async () => {
    if (!GOOGLE_CLIENT_ID) {
      setGoogleExportStatus('error');
      setGoogleExportError(GOOGLE_CLIENT_ID_SETUP_HINT);
      return;
    }

    setGoogleExportError('');
    setGoogleExportStatus('authorizing');

    try {
      await requestGoogleAccessToken('consent');
      
      // Load docs after successful sign-in
      const token = googleAccessToken || (await ensureGoogleAccessToken());
      setGoogleDocsLoading(true);
      const docs = await listGoogleDocs(token);
      setGoogleDocs(docs);
      if (docs.length > 0) {
        setSelectedGoogleDocId(docs[0].id);
        setGoogleExportMode('append');
      }
      setGoogleDocsLoading(false);
      
      setGoogleExportStatus('idle');
    } catch (error) {
      console.error('Google sign-in error:', error);
      setGoogleExportStatus('error');
      setGoogleExportError(
        error instanceof Error ? error.message : 'Google sign-in failed. Please try again.'
      );
      setGoogleDocsLoading(false);
    }
  };

  const handleGoogleDisconnect = () => {
    try {
      if (googleAccessToken) {
        getGoogleOauth2().revoke(googleAccessToken);
      }
    } catch (error) {
      console.warn('Google disconnect warning:', error);
    }

    setGoogleAccessToken(null);
    setGoogleAccessTokenExpiresAt(0);
    resetGoogleExportFeedback();
  };

  const handleExportToGoogleDocs = async () => {
    const normalizedText = normalizeExtractedText(extractedText);

    if (!normalizedText) {
      setGoogleExportStatus('error');
      setGoogleExportError('Nothing to export yet. Extract text first.');
      return;
    }

    if (!GOOGLE_CLIENT_ID) {
      setGoogleExportStatus('error');
      setGoogleExportError(GOOGLE_CLIENT_ID_SETUP_HINT);
      return;
    }

    resetGoogleExportFeedback();
    setGoogleExportStatus('authorizing');

    try {
      let accessToken = await ensureGoogleAccessToken();

      const executeExport = async (token: string) => {
        if (googleExportMode === 'append' && selectedGoogleDocId) {
          // Append to existing doc
          setGoogleExportStatus('writing-doc');
          const selectedDoc = googleDocs.find((d) => d.id === selectedGoogleDocId);
          await appendTextToGoogleDoc(token, selectedGoogleDocId, normalizedText);
          const docUrl = selectedDoc?.webViewLink || `https://docs.google.com/document/d/${selectedGoogleDocId}/edit`;
          setGoogleDocTitle(selectedDoc?.name || 'Note Document');
          setGoogleDocUrl(docUrl);
        } else {
          // Create new doc
          setGoogleExportStatus('creating-doc');
          const title = buildGoogleDocTitle();
          const createdDoc = await createGoogleDoc(token, title);

          setGoogleExportStatus('writing-doc');
          await insertTextIntoGoogleDoc(token, createdDoc.id!, normalizedText);

          const docUrl = createdDoc.webViewLink || `https://docs.google.com/document/d/${createdDoc.id}/edit`;
          setGoogleDocTitle(title);
          setGoogleDocUrl(docUrl);
          
          // Refresh docs list and select new doc
          const docs = await listGoogleDocs(token);
          setGoogleDocs(docs);
          if (createdDoc.id) {
            setSelectedGoogleDocId(createdDoc.id);
          }
        }
      };

      try {
        await executeExport(accessToken);
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        const unauthorized = message.includes('http 401');

        if (!unauthorized) {
          throw error;
        }

        accessToken = await requestGoogleAccessToken('consent');
        await executeExport(accessToken);
      }

      setGoogleExportStatus('done');
    } catch (error) {
      console.error('Google Docs export error:', error);
      setGoogleExportStatus('error');
      setGoogleExportError(
        error instanceof Error
          ? error.message
          : 'Could not export notes to Google Docs. Please try again.'
      );
    }
  };

  const runTesseractOCR = async (sourceImage: string) => {
    const result = await Tesseract.recognize(
      sourceImage,
      'eng',
      {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') {
            setOcrStatusMsg('Reading text locally...');
            setOcrProgress(Math.round(m.progress * 100));
          } else {
            setOcrStatusMsg(m.status.charAt(0).toUpperCase() + m.status.slice(1));
            setOcrProgress(Math.round(m.progress * 100));
          }
        }
      }
    );

    return result.data.text || 'No text was found in the image.';
  };

  const runRemoteOcr = async (
    sourceImage: string,
    path: string,
    uploadMessage: string,
    processingMessage: string
  ) => {
    setOcrStatusMsg(uploadMessage);
    setOcrProgress(10);

    const imageBlob = await fetch(sourceImage).then(res => res.blob());
    const response = await fetch(getApiUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': imageBlob.type || 'application/octet-stream',
      },
      body: imageBlob,
    });

    if (!response.ok) {
      let payload: AzureBackendOcrResponse | null = null;

      try {
        payload = (await response.json()) as AzureBackendOcrResponse;
      } catch {
        payload = null;
      }

      const errorCode = payload?.code || payload?.error || `HTTP_${response.status}`;
      const errorDetails =
        typeof payload?.details === 'string' ? payload.details.trim() : '';

      if (errorCode === 'RATE_LIMIT' || response.status === 429) {
        throw new Error('RATE_LIMIT');
      }

      if (errorDetails) {
        throw new Error(`${errorCode}::${errorDetails}`);
      }

      throw new Error(errorCode);
    }

    setOcrStatusMsg(processingMessage);
    setOcrProgress(85);

    const payload = (await response.json()) as AzureBackendOcrResponse;
    setOcrProgress(100);
    return payload;
  };

  const runAzureVisionOCR = async (sourceImage: string) => {
    return runRemoteOcr(
      sourceImage,
      '/api/ocr/azure',
      'Uploading image to Azure AI Vision...',
      'Azure AI Vision is reading text...'
    );
  };

  const runAzureDocumentIntelligenceOCR = async (sourceImage: string) => {
    return runRemoteOcr(
      sourceImage,
      '/api/ocr/document-intelligence',
      'Uploading image to Azure Document Intelligence...',
      'Azure Document Intelligence is analyzing text...'
    );
  };

  const handleExtract = async () => {
    if (!imageSrc) return;
    const sourceImage = imageSrc;
    
    setStatus('extracting');
    setOcrEngine(null);
    setOcrFallbackReason('');
    setOcrSourceInfo('');
    setOcrStatusMsg('Preparing image...');
    setOcrProgress(0);
    resetGoogleExportFeedback();
    
    try {
      const completeRemoteExtract = (
        model: 'azure-vision' | 'azure-document-intelligence',
        payload: AzureBackendOcrResponse
      ) => {
        setExtractedText(payload.text || 'No text was found in the image.');
        setOcrEngine(model);
        setOcrSourceInfo(describeRemoteOcrSource(payload));
        setOcrFallbackReason('');
        setAzureBackendStatus('configured');
        setStatus('done');
      };

      const runSelectedRemoteModel = async (model: 'azure-vision' | 'azure-document-intelligence') => {
        const payload =
          model === 'azure-document-intelligence'
            ? await runAzureDocumentIntelligenceOCR(sourceImage)
            : await runAzureVisionOCR(sourceImage);

        completeRemoteExtract(model, payload);
      };

      const syncRemoteStatusFromFailure = (
        model: 'azure-vision' | 'azure-document-intelligence',
        errorCode: string,
        rawMessage: string
      ) => {
        const normalizedCode = errorCode.toLowerCase();

        if (model === 'azure-vision' && errorCode === 'AZURE_NOT_CONFIGURED') {
          setVisionBackendConfigured(false);
          if (!documentIntelligenceBackendConfigured) {
            setAzureBackendStatus('not-configured');
          }
        }

        if (
          model === 'azure-document-intelligence' &&
          errorCode === 'DOCUMENT_INTELLIGENCE_NOT_CONFIGURED'
        ) {
          setDocumentIntelligenceBackendConfigured(false);
          if (!visionBackendConfigured) {
            setAzureBackendStatus('not-configured');
          }
        }

        if (normalizedCode.includes('failed to fetch') || rawMessage.toLowerCase().includes('failed to fetch')) {
          setAzureBackendStatus('unreachable');
        }
      };

      const extractFailureReason = (
        model: 'azure-vision' | 'azure-document-intelligence',
        rawMessage: string
      ) => {
        const [errorCode, errorDetails] = rawMessage.split('::', 2);
        const baseReason = toRemoteOcrFailureReason(model, errorCode || rawMessage);
        return errorDetails ? `${baseReason} Details: ${errorDetails}` : baseReason;
      };

      if (ocrModelPreference === 'tesseract') {
        setOcrStatusMsg('Running on-device OCR...');
        const localText = await runTesseractOCR(sourceImage);
        setExtractedText(localText);
        setOcrEngine('tesseract');
        setStatus('done');
        return;
      }

      if (!navigator.onLine) {
        if (ocrModelPreference === 'auto') {
          setOcrFallbackReason('Device is offline.');
          setOcrStatusMsg('Offline mode: running on-device OCR...');
          const localText = await runTesseractOCR(sourceImage);
          setExtractedText(localText);
          setOcrEngine('tesseract');
          setStatus('done');
          return;
        }

        throw new Error(`${getOcrModelLabel(ocrModelPreference)} requires an internet connection.`);
      }

      if (
        ocrModelPreference === 'azure-vision' ||
        ocrModelPreference === 'azure-document-intelligence'
      ) {
        try {
          await runSelectedRemoteModel(ocrModelPreference);
          return;
        } catch (remoteError: unknown) {
          const rawMessage = remoteError instanceof Error ? remoteError.message : 'Unknown OCR error.';
          const [errorCode] = rawMessage.split('::', 2);
          syncRemoteStatusFromFailure(ocrModelPreference, errorCode || rawMessage, rawMessage);

          setExtractedText(
            'Could not extract text with the selected OCR model. Choose another model and try again.'
          );
          setOcrEngine(null);
          setOcrFallbackReason(extractFailureReason(ocrModelPreference, rawMessage));
          setStatus('done');
          return;
        }
      }

      const autoCloudModels: Array<'azure-vision' | 'azure-document-intelligence'> = [
        'azure-vision',
        'azure-document-intelligence',
      ];
      let fallbackReason = 'Cloud OCR models are unavailable.';

      for (const model of autoCloudModels) {
        try {
          await runSelectedRemoteModel(model);
          return;
        } catch (remoteError: unknown) {
          const rawMessage = remoteError instanceof Error ? remoteError.message : 'Unknown OCR error.';
          const [errorCode] = rawMessage.split('::', 2);

          syncRemoteStatusFromFailure(model, errorCode || rawMessage, rawMessage);
          fallbackReason = extractFailureReason(model, rawMessage);
          console.warn(`${getOcrModelLabel(model)} fallback:`, rawMessage);
          setOcrProgress(0);
        }
      }

      setOcrFallbackReason(fallbackReason);
      setOcrStatusMsg('Cloud OCR unavailable, switching to on-device OCR...');

      const localText = await runTesseractOCR(sourceImage);
      setExtractedText(localText);
      setOcrEngine('tesseract');
      setStatus('done');
    } catch (error) {
      console.error("OCR Error:", error);
      setExtractedText("Error extracting text. Please try again.");
      setOcrEngine(null);
      setOcrFallbackReason(error instanceof Error ? error.message : 'OCR failed.');
      setStatus('done');
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(extractedText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    setStatus('idle');
    setImageSrc(null);
    setExtractedText('');
    setOcrEngine(null);
    setOcrFallbackReason('');
    setOcrSourceInfo('');
    setOcrProgress(0);
    setCameraZoom(1);
    resetGoogleExportFeedback();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const ocrSourceLabel =
    ocrEngine === 'azure-vision'
      ? 'Source: Azure AI Vision'
      : ocrEngine === 'azure-document-intelligence'
      ? 'Source: Azure Document Intelligence'
      : ocrEngine === 'tesseract'
      ? 'Source: Tesseract (on-device)'
      : 'Source: unavailable';

  const selectedOcrModelLabel = getOcrModelLabel(ocrModelPreference);
  const availableCloudModels = [
    visionBackendConfigured ? 'Azure AI Vision' : null,
    documentIntelligenceBackendConfigured ? 'Azure Document Intelligence' : null,
  ].filter(Boolean) as string[];

  const azureBackendStatusLabel =
    azureBackendStatus === 'configured'
      ? 'Cloud OCR backend: ready'
      : azureBackendStatus === 'not-configured'
      ? 'Cloud OCR backend: setup needed'
      : azureBackendStatus === 'unreachable'
      ? 'Cloud OCR backend: unavailable'
      : 'Cloud OCR backend: checking...';

  const azureBackendStatusDetail =
    azureBackendStatus === 'configured'
      ? API_BASE_URL
        ? `Using secure OCR backend at ${API_BASE_URL}. Ready: ${availableCloudModels.join(', ')}.`
        : `Using server-side OCR. Ready: ${availableCloudModels.join(', ')}.`
      : azureBackendStatus === 'not-configured'
      ? API_BASE_URL
        ? 'Set VISION_* and/or DOCUMENT_INTELLIGENCE_* on the deployed API server and restart it.'
        : 'Set VISION_* and/or DOCUMENT_INTELLIGENCE_* in .env and restart the API server.'
      : azureBackendStatus === 'unreachable'
      ? API_BASE_URL
        ? `Configured backend ${API_BASE_URL} is unreachable.`
        : 'Start the local API server to enable Azure OCR.'
      : `Checking ${getApiUrl('/api/ocr/health')}...`;

  const azureStatusDotClass =
    azureBackendStatus === 'configured'
      ? 'bg-emerald-400'
      : azureBackendStatus === 'checking'
      ? 'bg-amber-300'
      : 'bg-rose-400';

  const ocrSourceDetail =
    ocrEngine === 'tesseract' && ocrFallbackReason
      ? `Reason: ${ocrFallbackReason}`
      : !ocrEngine && ocrFallbackReason
      ? ocrFallbackReason
      : ocrSourceInfo || null;

  const getOcrModelAvailabilityText = (model: OcrModelPreference) => {
    if (model === 'auto') {
      return 'Adaptive fallback';
    }

    if (model === 'tesseract') {
      return 'Always ready';
    }

    if (model === 'azure-vision') {
      return visionBackendConfigured ? 'Remote ready' : 'Needs backend setup';
    }

    return documentIntelligenceBackendConfigured ? 'Remote ready' : 'Needs backend setup';
  };

  const googleIsBusy =
    googleExportStatus === 'authorizing' ||
    googleExportStatus === 'creating-doc' ||
    googleExportStatus === 'writing-doc';

  const googleConnected =
    Boolean(googleAccessToken) && googleAccessTokenExpiresAt > Date.now() + 10000;

  const hasExportableText = normalizeExtractedText(extractedText).length > 0;

  const googleStatusLabel =
    googleAuthStatus === 'disabled'
      ? 'Google Docs export is disabled'
      : googleAuthStatus === 'loading'
      ? 'Loading Google Sign-In...'
      : googleAuthStatus === 'error'
      ? 'Google Sign-In unavailable'
      : googleConnected
      ? 'Google account connected'
      : 'Google account not connected';

  const googleStatusDetail =
    googleAuthStatus === 'disabled'
      ? GOOGLE_CLIENT_ID_SETUP_HINT
      : googleExportStatus === 'authorizing'
      ? 'Waiting for Google OAuth permission...'
      : googleExportStatus === 'creating-doc'
      ? 'Creating a new Google Doc in Drive...'
      : googleExportStatus === 'writing-doc'
      ? 'Inserting OCR text and formatting...'
      : googleExportStatus === 'done'
      ? 'Document created successfully.'
      : GOOGLE_DRIVE_FOLDER_ID
      ? `Docs will be created in folder ${GOOGLE_DRIVE_FOLDER_ID}.`
      : 'Docs will be created at the root of your Google Drive.';

  const googleConnectionPillClass = googleConnected
    ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10'
    : 'border-white/15 text-[#9aa0aa] bg-white/[0.03]';

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-[#f5f5f7] flex items-center justify-center p-4 sm:p-8 font-sans antialiased selection:bg-[#4da3ff]/30">
      
      {/* Background Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#4da3ff]/[0.02] blur-[120px] rounded-full pointer-events-none" />

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[540px] bg-[#15161b] rounded-[2.5rem] p-6 sm:p-10 shadow-[0_24px_48px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.05)] border border-white/[0.03] relative z-10"
      >
        {/* Header */}
        <div className="text-center mb-8">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="w-12 h-12 bg-gradient-to-br from-[#1c1d23] to-[#15161b] rounded-2xl mx-auto mb-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] border border-white/5 flex items-center justify-center"
          >
            <FileText className="w-5 h-5 text-[#f5f5f7]" />
          </motion.div>
          <h1 className="text-2xl font-medium tracking-tight text-[#f5f5f7] mb-2">Photo Note</h1>
          <p className="text-[#9aa0aa] text-sm tracking-wide font-medium">Transform images into editable notes.</p>
        </div>

        <div className="mb-6 rounded-2xl border border-white/5 bg-[#1c1d23] px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[#f5f5f7] text-xs font-medium truncate">
              {azureBackendStatusLabel}
            </p>
            <p className="text-[#9aa0aa] text-[11px] truncate">
              {azureBackendStatusDetail}
            </p>
          </div>
          <div className="flex-shrink-0">
            <span className={`block w-2.5 h-2.5 rounded-full ${azureStatusDotClass}`} />
          </div>
        </div>

        <div className="mb-6 rounded-2xl border border-white/5 bg-[#1c1d23] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0">
              <p className="text-[#f5f5f7] text-sm font-medium truncate">OCR Model</p>
              <p className="text-[#9aa0aa] text-xs leading-relaxed">
                Pick how each scan should be processed. Auto keeps the old fallback behavior.
              </p>
            </div>
            <span className="inline-flex items-center rounded-full border border-[#4da3ff]/25 bg-[#4da3ff]/10 px-2.5 py-1 text-[11px] font-medium text-[#8fc2ff]">
              {selectedOcrModelLabel}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
            className="flex items-center gap-2 text-[#8a919c] hover:text-[#ccc] transition-colors mb-3"
          >
            <ChevronDown
              size={16}
              className={`transition-transform duration-200 ${isModelSelectorOpen ? 'rotate-0' : '-rotate-90'}`}
            />
            <span className="text-xs font-medium">Models</span>
          </button>

          <AnimatePresence>
            {isModelSelectorOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {OCR_MODEL_OPTIONS.map((option) => {
                    const isActive = ocrModelPreference === option.id;
                    const availabilityText = getOcrModelAvailabilityText(option.id);

                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setOcrModelPreference(option.id)}
                        disabled={status === 'extracting'}
                        className={`rounded-2xl border px-3.5 py-3 text-left transition-all ${
                          isActive
                            ? 'border-[#4da3ff]/50 bg-[#4da3ff]/12 shadow-[0_0_0_1px_rgba(77,163,255,0.08)_inset]'
                            : 'border-white/8 bg-[#15161b] hover:bg-white/[0.03]'
                        } ${status === 'extracting' ? 'opacity-60 cursor-not-allowed' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <span className={`text-sm font-medium ${isActive ? 'text-[#f5f5f7]' : 'text-[#d8dbe1]'}`}>
                            {option.label}
                          </span>
                          <span
                            className={`inline-flex h-2.5 w-2.5 rounded-full ${
                              option.id === 'tesseract' ||
                              option.id === 'auto' ||
                              (option.id === 'azure-vision' && visionBackendConfigured) ||
                              (option.id === 'azure-document-intelligence' && documentIntelligenceBackendConfigured)
                                ? 'bg-emerald-300'
                                : 'bg-amber-300'
                            }`}
                          />
                        </div>
                        <p className="text-[11px] leading-relaxed text-[#8a919c] mb-2">{option.description}</p>
                        <p className={`text-[11px] font-medium ${isActive ? 'text-[#8fc2ff]' : 'text-[#6f7782]'}`}>
                          {availabilityText}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Dynamic Content Area */}
        <div className="space-y-6">
          <AnimatePresence mode="wait">
            
            {/* IDLE STATE - Camera & Upload Dropzone */}
            {status === 'idle' && (
              <motion.div
                key="idle"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98, height: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="bg-[#1c1d23] rounded-3xl border border-white/5 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-all overflow-hidden relative"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {/* Hidden Canvas for Capture */}
                <canvas ref={canvasRef} className="hidden" />
                
                {/* Hidden File Input */}
                <input 
                  type="file" 
                  className="hidden" 
                  accept="image/*" 
                  ref={fileInputRef}
                  onChange={handleFileChange} 
                />

                {isDragging && (
                  <div className="absolute inset-2 bg-[#4da3ff]/10 backdrop-blur-md rounded-2xl z-50 flex items-center justify-center border-2 border-[#4da3ff]/50 border-dashed">
                    <div className="bg-[#15161b] p-6 rounded-2xl flex flex-col items-center shadow-2xl border border-white/10">
                      <Upload className="w-8 h-8 text-[#4da3ff] mb-3 animate-bounce" />
                      <span className="text-[#f5f5f7] font-medium text-base">Drop photo to scan</span>
                    </div>
                  </div>
                )}

                {cameraError ? (
                  // Fallback: Dropzone UI when Camera fails or is denied
                  <div className="flex flex-col items-center justify-center py-16 px-6 border border-dashed border-white/10 rounded-2xl bg-[#0b0b0f]/50">
                    <div className="bg-[#15161b] p-4 rounded-2xl mb-4 text-[#9aa0aa] shadow-sm border border-white/[0.02]">
                      <CameraOff className="w-6 h-6" />
                    </div>
                    <span className="text-[#f5f5f7] font-medium mb-1.5 text-sm">Camera unavailable</span>
                    <span className="text-[#9aa0aa] text-xs text-center mb-6 max-w-[200px]">
                      {cameraError}
                    </span>
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="px-6 py-2.5 bg-[#4da3ff] text-[#0b0b0f] font-medium text-sm rounded-xl hover:bg-[#4da3ff]/90 transition-all"
                    >
                      Browse Files
                    </button>
                    <p className="text-[#7f8692] text-[11px] mt-4 text-center">Tip: Press Ctrl+V to paste a screenshot</p>
                  </div>
                ) : (
                  // Camera View UI
                  <div
                    className="relative rounded-2xl overflow-hidden bg-black h-[360px] group"
                    onTouchStart={handleCameraTouchStart}
                    onTouchMove={handleCameraTouchMove}
                    onTouchEnd={handleCameraTouchEnd}
                    onTouchCancel={handleCameraTouchEnd}
                    style={{ touchAction: 'none' }}
                  >
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      onLoadedData={handleVideoReady}
                      className="absolute inset-0 w-full h-full object-cover transition-transform duration-150"
                      style={{ transform: `${facingMode === 'user' ? 'scaleX(-1) ' : ''}scale(${cameraZoom})` }}
                    />

                    <div className="absolute top-3 left-3 z-10 px-2.5 py-1 rounded-full bg-black/45 text-white text-xs font-medium backdrop-blur-sm border border-white/20">
                      {cameraZoom.toFixed(1)}x
                    </div>

                    <div className="absolute top-3 right-3 z-10 px-2.5 py-1 rounded-full bg-black/35 text-white/85 text-[11px] font-medium backdrop-blur-sm border border-white/15">
                      Pinch to zoom
                    </div>

                    <div className="absolute top-11 right-3 z-10 px-2.5 py-1 rounded-full bg-black/35 text-white/85 text-[11px] font-medium backdrop-blur-sm border border-white/15">
                      Ctrl+V to paste screenshot
                    </div>

                    {!isCameraPreviewReady && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-[1px]">
                        <div className="text-center px-4">
                          <Loader2 className="w-6 h-6 text-white animate-spin mx-auto mb-3" />
                          <p className="text-white text-sm font-medium">Starting camera...</p>
                        </div>
                      </div>
                    )}
                    
                    {/* Viewfinder Overlays */}
                    <div className="absolute inset-0 pointer-events-none p-6 flex flex-col justify-between opacity-40 mix-blend-overlay">
                      <div className="flex justify-between">
                        <div className="w-8 h-8 border-t-[3px] border-l-[3px] border-white rounded-tl-xl" />
                        <div className="w-8 h-8 border-t-[3px] border-r-[3px] border-white rounded-tr-xl" />
                      </div>
                      <div className="flex justify-between">
                        <div className="w-8 h-8 border-b-[3px] border-l-[3px] border-white rounded-bl-xl" />
                        <div className="w-8 h-8 border-b-[3px] border-r-[3px] border-white rounded-br-xl" />
                      </div>
                    </div>

                    {/* Camera Controls */}
                    <div className="absolute bottom-0 left-0 right-0 p-5 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex items-center justify-between">
                      {/* Upload Alternative */}
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="w-11 h-11 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/20 transition-all border border-white/20"
                        title="Upload from device"
                      >
                        <ImagePlus className="w-5 h-5" />
                      </button>

                      {/* iOS-Style Capture Button */}
                      <button 
                        onClick={capturePhoto}
                        className="w-[72px] h-[72px] rounded-full border-[4px] border-white flex items-center justify-center group-active:scale-95 transition-transform"
                      >
                        <div className="w-[58px] h-[58px] bg-white rounded-full active:bg-white/80 transition-colors shadow-sm" />
                      </button>

                      {/* Flip Camera */}
                      <button 
                        onClick={toggleCamera}
                        className="w-11 h-11 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white hover:bg-white/20 transition-all border border-white/20"
                        title="Flip camera"
                      >
                        <SwitchCamera className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* READY STATE - Image Preview */}
            {status === 'ready' && (
              <motion.div
                key="ready"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98, height: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="bg-[#1c1d23] rounded-3xl border border-white/5 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-all overflow-hidden"
              >
                <div className="relative rounded-2xl overflow-hidden bg-[#0b0b0f] h-[360px] flex items-center justify-center">
                  <img 
                    src={imageSrc!} 
                    className="object-contain w-full h-full opacity-90" 
                    alt="Preview" 
                  />
                  <div className="absolute top-0 left-0 w-full p-4 bg-gradient-to-b from-black/60 to-transparent flex justify-end">
                    <button 
                      onClick={handleReset}
                      className="p-2.5 bg-white/10 backdrop-blur-md rounded-full text-white hover:bg-white/20 transition-all border border-white/20 shadow-lg"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* EXTRACTING STATE */}
            {status === 'extracting' && (
              <motion.div
                key="extracting"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.4 }}
                className="bg-[#1c1d23] rounded-3xl border border-white/5 py-16 flex flex-col items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]"
              >
                <div className="relative mb-6">
                  <div className="absolute inset-0 bg-[#4da3ff]/20 rounded-full blur-xl animate-pulse" />
                  <div className="bg-[#15161b] p-4 rounded-2xl border border-white/5 relative z-10">
                    <Loader2 className="w-6 h-6 text-[#4da3ff] animate-spin" />
                  </div>
                </div>
                <h3 className="text-[#f5f5f7] font-medium mb-2">{ocrStatusMsg}</h3>
                <div className="w-full max-w-[200px] bg-[#15161b] rounded-full h-1.5 mt-2 overflow-hidden border border-white/5">
                  <motion.div 
                    className="bg-[#4da3ff] h-full rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${ocrProgress}%` }}
                    transition={{ duration: 0.2 }}
                  />
                </div>
                <p className="text-[#9aa0aa] text-xs mt-3 text-center">{ocrProgress}%</p>
              </motion.div>
            )}

            {/* DONE STATE - Result Editor */}
            {status === 'done' && (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="space-y-4"
              >
                {/* Small preview of original image */}
                <div className="flex items-center gap-3 bg-[#1c1d23] p-2 pr-4 rounded-2xl border border-white/5 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                  <button 
                    onClick={handleReset}
                    className="w-12 h-12 rounded-xl overflow-hidden bg-[#0b0b0f] flex-shrink-0 hover:opacity-75 transition-opacity cursor-pointer group relative"
                    title="Click to retake photo"
                  >
                    <img src={imageSrc!} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" alt="Thumbnail" />
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 backdrop-blur-sm">
                      <span className="text-white text-[10px] font-medium">Retake</span>
                    </div>
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-[#f5f5f7] text-sm font-medium truncate">Extracted Note</p>
                    <p className="text-[#9aa0aa] text-xs truncate">{ocrSourceLabel}</p>
                    {ocrSourceDetail ? (
                      <p className="text-[#7f8692] text-[11px] mt-0.5 truncate">{ocrSourceDetail}</p>
                    ) : null}
                  </div>
                  <button 
                    onClick={handleReset}
                    className="text-xs font-medium text-[#4da3ff] hover:text-[#4da3ff]/80 transition-colors px-2 py-1"
                  >
                    Start over
                  </button>
                </div>

                {/* Editor Area */}
                <div className="relative group">
                  <div className="absolute -inset-0.5 bg-gradient-to-b from-[#4da3ff]/10 to-transparent rounded-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-sm pointer-events-none" />
                  <div className="relative bg-[#1c1d23] border border-white/5 rounded-3xl p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
                    <textarea 
                      value={extractedText}
                      onChange={(e) => setExtractedText(e.target.value)}
                      placeholder="Start typing your note..."
                      className="w-full h-64 bg-transparent p-5 text-[#f5f5f7] text-[15px] leading-relaxed focus:outline-none resize-none placeholder:text-[#9aa0aa]/50 custom-scrollbar"
                    />
                    <div className="absolute bottom-4 right-4 flex gap-2">
                      <button 
                        onClick={handleCopy}
                        className="flex items-center gap-2 px-4 py-2 bg-[#15161b] rounded-xl text-[#f5f5f7] hover:bg-white/[0.04] transition-all border border-white/5 shadow-sm font-medium text-xs"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-[#9aa0aa]" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Google Docs Export */}
                <div className="bg-[#1c1d23] border border-white/5 rounded-3xl p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[#f5f5f7] text-sm font-medium truncate">Google Docs Export</p>
                      <p className="text-[#9aa0aa] text-xs truncate">{googleStatusLabel}</p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full border ${googleConnectionPillClass}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${googleConnected ? 'bg-emerald-300' : 'bg-[#7f8692]'}`} />
                      {googleConnected ? 'Connected' : 'Not connected'}
                    </span>
                  </div>

                  <p className="text-[#7f8692] text-[11px]">{googleStatusDetail}</p>

                  {googleExportError ? (
                    <p className="text-rose-200 text-xs bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2">
                      {googleExportError}
                    </p>
                  ) : null}

                  {googleDocUrl ? (
                    <a
                      href={googleDocUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 px-3 py-2 bg-[#15161b] text-[#4da3ff] border border-[#4da3ff]/25 rounded-xl text-xs font-medium hover:bg-[#4da3ff]/10 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      {googleDocTitle ? `Open ${googleDocTitle}` : 'Open Google Doc'}
                    </a>
                  ) : null}

                  {googleConnected && googleDocs.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <label className="text-[#9aa0aa] text-xs font-medium block">Export mode</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setGoogleExportMode('create')}
                          className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                            googleExportMode === 'create'
                              ? 'bg-[#4da3ff]/20 border-[#4da3ff]/50 text-[#4da3ff]'
                              : 'bg-white/[0.02] border-white/10 text-[#9aa0aa] hover:bg-white/[0.04]'
                          }`}
                        >
                          Create new
                        </button>
                        <button
                          onClick={() => setGoogleExportMode('append')}
                          className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border ${
                            googleExportMode === 'append'
                              ? 'bg-[#4da3ff]/20 border-[#4da3ff]/50 text-[#4da3ff]'
                              : 'bg-white/[0.02] border-white/10 text-[#9aa0aa] hover:bg-white/[0.04]'
                          }`}
                        >
                          Add to existing
                        </button>
                      </div>
                    </div>
                  )}

                  {googleConnected && googleExportMode === 'append' && (
                    <div className="space-y-2">
                      <label className="text-[#9aa0aa] text-xs font-medium block">Select document</label>
                      {googleDocsLoading ? (
                        <div className="flex items-center justify-center py-3 text-[#9aa0aa] text-xs">
                          <Loader2 className="w-3 h-3 animate-spin mr-2" />
                          Loading docs...
                        </div>
                      ) : (
                        <select
                          value={selectedGoogleDocId || ''}
                          onChange={(e) => setSelectedGoogleDocId(e.target.value)}
                          className="w-full px-3 py-2 bg-[#15161b] border border-white/10 rounded-lg text-[#f5f5f7] text-xs font-medium focus:outline-none focus:border-[#4da3ff]/50 transition-colors cursor-pointer"
                        >
                          {googleDocs.map((doc) => (
                            <option key={doc.id} value={doc.id}>
                              {doc.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleGoogleSignIn}
                      disabled={googleAuthStatus !== 'ready' || googleIsBusy}
                      className="inline-flex items-center gap-2 px-3.5 py-2 bg-white/[0.04] text-[#f5f5f7] border border-white/10 rounded-xl text-xs font-medium hover:bg-white/[0.08] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {googleIsBusy && googleExportStatus === 'authorizing' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <LogIn className="w-3.5 h-3.5" />
                      )}
                      {googleConnected ? 'Re-auth Google' : 'Sign in with Google'}
                    </button>

                    <button
                      onClick={handleExportToGoogleDocs}
                      disabled={googleAuthStatus !== 'ready' || googleIsBusy || !hasExportableText || (googleExportMode === 'append' && !selectedGoogleDocId)}
                      className="inline-flex items-center gap-2 px-3.5 py-2 bg-[#4da3ff] text-[#0b0b0f] border border-[#4da3ff]/80 rounded-xl text-xs font-medium hover:bg-[#4da3ff]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {googleExportStatus === 'creating-doc' || googleExportStatus === 'writing-doc' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <FileUp className="w-3.5 h-3.5" />
                      )}
                      {googleExportStatus === 'creating-doc'
                        ? 'Creating Doc...'
                        : googleExportStatus === 'writing-doc'
                        ? googleExportMode === 'append' ? 'Adding Entry...' : 'Writing Notes...'
                        : googleExportMode === 'create' ? 'Create Google Doc' : 'Add to Doc'}
                    </button>

                    {googleConnected ? (
                      <button
                        onClick={handleGoogleDisconnect}
                        disabled={googleIsBusy}
                        className="inline-flex items-center gap-2 px-3.5 py-2 bg-white/[0.02] text-[#9aa0aa] border border-white/10 rounded-xl text-xs font-medium hover:bg-white/[0.06] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    ) : null}
                  </div>
                </div>
              </motion.div>
            )}

          </AnimatePresence>

          {/* Action Button */}
          {status === 'ready' && (
            <motion.button 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={handleExtract}
              className="w-full bg-[#4da3ff] text-[#0b0b0f] py-4 rounded-2xl font-medium text-[15px] hover:bg-[#4da3ff]/90 active:scale-[0.98] transition-all shadow-[0_4px_14px_rgba(77,163,255,0.25)] flex items-center justify-center gap-2"
            >
              {ocrModelPreference === 'auto' ? 'Extract Text' : `Extract with ${selectedOcrModelLabel}`}
            </motion.button>
          )}

        </div>
      </motion.div>

      {/* Global styles for custom scrollbar to match the design */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          border: 2px solid #1c1d23;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
