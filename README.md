# photo_note

Photo Note extracts text from images.

## OCR behavior

- Primary OCR: Azure Computer Vision through a secure backend endpoint
- Fallback OCR: Tesseract.js (offline or when Azure is unavailable)

## Secure backend architecture

- Browser uploads image bytes to `POST /api/ocr/azure`.
- Backend reads `VISION_ENDPOINT` and `VISION_KEY` from server env.
- Backend calls Azure Image Analysis 4.0 (`features=read`) and falls back to legacy read path if needed.
- Azure keys are never exposed to frontend code.

## Azure setup

1. Create an Azure AI Vision resource.
2. Copy `.env.example` to `.env`.
3. Fill in your values:

```env
VISION_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com
VISION_KEY=your-azure-vision-key
VISION_LANGUAGE=en

# Optional
API_PORT=8787
MAX_IMAGE_BYTES=10485760
```

If you update `.env` while `npm run dev` is already running, restart the dev command so the API server reloads values.

Then run:

```bash
npm install
npm run dev
```

`npm run dev` starts both services:

- Frontend: Vite on port 5173
- Backend API: Express on port 8787

If Azure settings are missing, backend is unavailable, or the device is offline, the app automatically uses local OCR with Tesseract.