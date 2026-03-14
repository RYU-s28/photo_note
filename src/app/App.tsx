import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, FileText, Check, Copy, Loader2, X, ImagePlus, SwitchCamera, CameraOff } from 'lucide-react';
import Tesseract from 'tesseract.js/dist/tesseract.esm.min.js';

type AppState = 'idle' | 'ready' | 'extracting' | 'done';

type AzureReadLine = {
  text?: string;
};

type AzureReadResult = {
  lines?: AzureReadLine[];
};

type AzureReadAnalyzeResult = {
  readResults?: AzureReadResult[];
};

type AzureReadStatusResponse = {
  status?: string;
  analyzeResult?: AzureReadAnalyzeResult;
};

const AZURE_VISION_ENDPOINT = import.meta.env.VITE_AZURE_VISION_ENDPOINT?.trim();
const AZURE_VISION_KEY = import.meta.env.VITE_AZURE_VISION_KEY?.trim();
const AZURE_VISION_LANGUAGE = import.meta.env.VITE_AZURE_VISION_LANGUAGE?.trim() || 'en';

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/+$/, '');

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default function App() {
  const [status, setStatus] = useState<AppState>('idle');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string>('');
  const [copied, setCopied] = useState(false);
  
  // OCR State
  const [ocrStatusMsg, setOcrStatusMsg] = useState<string>('Initializing OCR...');
  const [ocrProgress, setOcrProgress] = useState<number>(0);
  
  // Camera & Drag State
  const [isCameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isDragging, setIsDragging] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = async (mode: 'environment' | 'user') => {
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
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

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // If user mode, flip the image horizontally
        if (facingMode === 'user') {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
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

  const runTesseractOCR = async (sourceImage: string) => {
    const result = await Tesseract.recognize(
      sourceImage,
      'eng',
      {
        logger: m => {
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
    if (!AZURE_VISION_ENDPOINT || !AZURE_VISION_KEY) {
      throw new Error('Azure AI Vision is not configured.');
    }

    setOcrStatusMsg('Uploading image to Azure AI Vision...');
    setOcrProgress(10);

    const imageBlob = await fetch(sourceImage).then(res => res.blob());
    const endpoint = normalizeEndpoint(AZURE_VISION_ENDPOINT);
    const analyzeUrl = `${endpoint}/vision/v3.2/read/analyze?language=${encodeURIComponent(AZURE_VISION_LANGUAGE)}`;

    const analyzeResponse = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': imageBlob.type || 'application/octet-stream',
        'Ocp-Apim-Subscription-Key': AZURE_VISION_KEY,
      },
      body: imageBlob,
    });

    if (!analyzeResponse.ok) {
      const errorText = await analyzeResponse.text();
      throw new Error(`Azure analyze request failed: ${analyzeResponse.status} ${errorText}`);
    }

    const operationLocation = analyzeResponse.headers.get('operation-location');
    if (!operationLocation) {
      throw new Error('Azure response did not include operation-location.');
    }

    setOcrStatusMsg('Azure is reading text...');
    setOcrProgress(30);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1200);

      const resultResponse = await fetch(operationLocation, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': AZURE_VISION_KEY,
        },
      });

      if (!resultResponse.ok) {
        const errorText = await resultResponse.text();
        throw new Error(`Azure status request failed: ${resultResponse.status} ${errorText}`);
      }

      const payload = (await resultResponse.json()) as AzureReadStatusResponse;
      const statusValue = payload.status?.toLowerCase();

      if (statusValue === 'succeeded') {
        setOcrProgress(100);
        const lines = payload.analyzeResult?.readResults?.flatMap(page => page.lines || []) || [];
        const combinedText = lines.map(line => line.text || '').filter(Boolean).join('\n');
        return combinedText || 'No text was found in the image.';
      }

      if (statusValue === 'failed') {
        throw new Error('Azure OCR failed while processing the image.');
      }

      setOcrProgress(Math.min(95, 35 + attempt * 3));
    }

    throw new Error('Azure OCR timed out while waiting for the result.');
  };

  // Extract text using Azure AI Vision first, then fallback to on-device OCR when needed
  const handleExtract = async () => {
    if (!imageSrc) return;
    const sourceImage = imageSrc;
    
    setStatus('extracting');
    setOcrStatusMsg('Preparing image...');
    setOcrProgress(0);
    
    try {
      const azureConfigured = Boolean(AZURE_VISION_ENDPOINT && AZURE_VISION_KEY);
      const shouldUseAzure = navigator.onLine && azureConfigured;

      if (shouldUseAzure) {
        try {
          const azureText = await runAzureVisionOCR(sourceImage);
          setExtractedText(azureText);
          setStatus('done');
          return;
        } catch (azureError) {
          console.error('Azure OCR Error:', azureError);
          setOcrStatusMsg('Azure unavailable, switching to on-device OCR...');
          setOcrProgress(0);
        }
      } else if (!navigator.onLine) {
        setOcrStatusMsg('Offline mode: running on-device OCR...');
      } else {
        setOcrStatusMsg('Azure not configured, running on-device OCR...');
      }

      const localText = await runTesseractOCR(sourceImage);
      setExtractedText(localText);
      setStatus('done');
    } catch (error) {
      console.error("OCR Error:", error);
      setExtractedText("Error extracting text. Please try again.");
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
    setOcrProgress(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

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
                    <span className="text-[#f5f5f7] font-medium mb-1.5 text-sm">Camera access denied</span>
                    <span className="text-[#9aa0aa] text-xs text-center mb-6 max-w-[200px]">
                      Please allow camera access or upload an image manually.
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
                  <div className="relative rounded-2xl overflow-hidden bg-black h-[360px] group">
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`absolute inset-0 w-full h-full object-cover transition-transform duration-500 ${facingMode === 'user' ? 'scale-x-[-1]' : ''}`}
                    />
                    
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
                    <p className="text-[#9aa0aa] text-xs truncate">Ready to edit</p>
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
