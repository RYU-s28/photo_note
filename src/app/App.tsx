import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, FileText, Check, Copy, Loader2, X, ImagePlus, SwitchCamera, CameraOff } from 'lucide-react';
import Tesseract from 'tesseract.js';

type AppState = 'idle' | 'ready' | 'extracting' | 'done';

type OcrEngine = 'azure' | 'tesseract';

type AzureBackendOcrResponse = {
  text?: string;
  source?: string;
  modelVersion?: string | null;
  error?: string;
  code?: string;
};

type AzureBackendHealthResponse = {
  azureConfigured?: boolean;
};

type AzureBackendStatus = 'checking' | 'configured' | 'not-configured' | 'unreachable';

const MIN_CAMERA_ZOOM = 1;
const MAX_CAMERA_ZOOM = 3;
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

const clampZoom = (zoomValue: number) => Math.min(MAX_CAMERA_ZOOM, Math.max(MIN_CAMERA_ZOOM, zoomValue));
const getApiUrl = (path: string) => `${API_BASE_URL}${path}`;

const getTouchDistance = (touches: React.TouchList) => {
  const [firstTouch, secondTouch] = [touches[0], touches[1]];
  const deltaX = firstTouch.clientX - secondTouch.clientX;
  const deltaY = firstTouch.clientY - secondTouch.clientY;
  return Math.hypot(deltaX, deltaY);
};

const toAzureFallbackReason = (errorMessage: string) => {
  if (!errorMessage) {
    return 'Azure OCR request failed.';
  }

  const normalizedMessage = errorMessage.toLowerCase();

  if (errorMessage === 'RATE_LIMIT') {
    return 'Azure rate limit reached.';
  }

  if (errorMessage === 'AZURE_NOT_CONFIGURED') {
    return 'Backend is missing VISION_ENDPOINT or VISION_KEY.';
  }

  if (errorMessage === 'AZURE_AUTH_FAILED') {
    return 'Backend Azure key is invalid.';
  }

  if (errorMessage === 'AZURE_ENDPOINT_UNAVAILABLE') {
    return 'Azure endpoint path is not available for this resource.';
  }

  if (errorMessage === 'AZURE_BAD_REQUEST') {
    return 'Azure rejected this image request.';
  }

  if (errorMessage === 'AZURE_REQUEST_FAILED') {
    return 'Azure OCR request failed on the backend.';
  }

  if (errorMessage === 'REQUEST_TIMEOUT') {
    return 'Azure OCR timed out.';
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
    return 'Azure OCR timed out.';
  }

  return 'Azure OCR request failed.';
};

export default function App() {
  const [status, setStatus] = useState<AppState>('idle');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string>('');
  const [ocrEngine, setOcrEngine] = useState<OcrEngine | null>(null);
  const [ocrFallbackReason, setOcrFallbackReason] = useState('');
  const [copied, setCopied] = useState(false);
  const [azureBackendStatus, setAzureBackendStatus] = useState<AzureBackendStatus>('checking');
  
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
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);

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
      }
    }
  };

  // Handle manual file selection
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImageSrc(event.target?.result as string);
        setStatus('ready');
      };
      reader.readAsDataURL(file);
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
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImageSrc(event.target?.result as string);
        setStatus('ready');
      };
      reader.readAsDataURL(file);
    }
  };

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
          setAzureBackendStatus(payload.azureConfigured ? 'configured' : 'not-configured');
        }
      } catch {
        if (!isCancelled) {
          setAzureBackendStatus('unreachable');
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

  const runAzureVisionOCR = async (sourceImage: string) => {
    setOcrStatusMsg('Uploading image to secure OCR backend...');
    setOcrProgress(10);

    const imageBlob = await fetch(sourceImage).then(res => res.blob());
    const response = await fetch(getApiUrl('/api/ocr/azure'), {
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

      if (errorCode === 'RATE_LIMIT' || response.status === 429) {
        throw new Error('RATE_LIMIT');
      }

      throw new Error(errorCode);
    }

    setOcrStatusMsg('Azure is reading text...');
    setOcrProgress(85);

    const payload = (await response.json()) as AzureBackendOcrResponse;
    setOcrProgress(100);
    return payload.text || 'No text was found in the image.';
  };

  // Extract text using Azure AI Vision first, then fallback to on-device OCR when needed
  const handleExtract = async () => {
    if (!imageSrc) return;
    const sourceImage = imageSrc;
    
    setStatus('extracting');
    setOcrEngine(null);
    setOcrFallbackReason('');
    setOcrStatusMsg('Preparing image...');
    setOcrProgress(0);
    
    try {
      if (navigator.onLine) {
        try {
          const azureText = await runAzureVisionOCR(sourceImage);
          setExtractedText(azureText);
          setOcrEngine('azure');
          setOcrFallbackReason('');
          setAzureBackendStatus('configured');
          setStatus('done');
          return;
        } catch (azureError: unknown) {
          const msg = azureError instanceof Error ? azureError.message : '';
          const normalizedMsg = msg.toLowerCase();
          const fallbackReason = toAzureFallbackReason(msg);

          if (msg === 'AZURE_NOT_CONFIGURED') {
            setAzureBackendStatus('not-configured');
          }

          if (normalizedMsg.includes('failed to fetch')) {
            setAzureBackendStatus('unreachable');
          }

          setOcrFallbackReason(fallbackReason);

          if (msg === 'RATE_LIMIT') {
            setOcrStatusMsg('Rate limit reached, switching to on-device OCR...');
          } else if (msg === 'AZURE_NOT_CONFIGURED') {
            setOcrStatusMsg('Backend not configured, switching to on-device OCR...');
          } else {
            setOcrStatusMsg('Azure unavailable, switching to on-device OCR...');
          }

          console.warn('Azure OCR fallback:', msg);
          setOcrProgress(0);
        }
      } else {
        setOcrFallbackReason('Device is offline.');
        setOcrStatusMsg('Offline mode: running on-device OCR...');
      }

      const localText = await runTesseractOCR(sourceImage);
      setExtractedText(localText);
      setOcrEngine('tesseract');
      setStatus('done');
    } catch (error) {
      console.error("OCR Error:", error);
      setExtractedText("Error extracting text. Please try again.");
      setOcrEngine(null);
      setOcrFallbackReason('OCR failed.');
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
    setOcrProgress(0);
    setCameraZoom(1);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const ocrSourceLabel =
    ocrEngine === 'azure'
      ? 'Source: Azure AI Vision'
      : ocrEngine === 'tesseract'
      ? 'Source: Tesseract (on-device)'
      : 'Source: unavailable';

  const azureBackendStatusLabel =
    azureBackendStatus === 'configured'
      ? 'Azure OCR backend: configured'
      : azureBackendStatus === 'not-configured'
      ? 'Azure OCR backend: missing server env'
      : azureBackendStatus === 'unreachable'
      ? 'Azure OCR backend: unavailable'
      : 'Azure OCR backend: checking...';

  const azureBackendStatusDetail =
    azureBackendStatus === 'configured'
      ? API_BASE_URL
        ? `Using secure OCR backend at ${API_BASE_URL}.`
        : 'Using server-side VISION_ENDPOINT and VISION_KEY.'
      : azureBackendStatus === 'not-configured'
      ? API_BASE_URL
        ? 'Set VISION_ENDPOINT and VISION_KEY on the deployed API server and restart it.'
        : 'Set VISION_ENDPOINT and VISION_KEY in .env and restart API server.'
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

  const ocrSourceDetail = ocrEngine === 'tesseract' && ocrFallbackReason
    ? `Reason: ${ocrFallbackReason}`
    : null;

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
                  <div className="w-12 h-12 rounded-xl overflow-hidden bg-[#0b0b0f] flex-shrink-0">
                    <img src={imageSrc!} className="w-full h-full object-cover opacity-80" alt="Thumbnail" />
                  </div>
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
              Extract Text
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
