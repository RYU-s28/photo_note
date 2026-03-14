# photo_note

Photo Note extracts text from images.

## OCR behavior

- Primary OCR: Azure AI Vision (online)
- Fallback OCR: Tesseract.js (offline or when Azure is unavailable)

## Azure setup

1. Create an Azure AI Vision resource.
2. Copy `.env.example` to `.env`.
3. Fill in your values:

```env
VITE_AZURE_CV_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com
VITE_AZURE_CV_KEY=your-azure-vision-key
VITE_AZURE_VISION_LANGUAGE=en
```

If you update `.env` while `npm run dev` is already running, restart the dev server so Vite reloads env values.

Then run:

```bash
npm install
npm run dev
```

If Azure settings are missing or the device is offline, the app automatically uses local OCR with Tesseract.