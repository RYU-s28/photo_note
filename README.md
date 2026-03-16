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
CORS_ALLOW_ORIGINS=https://your-user.github.io
```

If you update `.env` while `npm run dev` is already running, restart the dev command so the API server reloads values.

For backward compatibility, the backend also accepts these legacy names:

```env
VITE_AZURE_CV_ENDPOINT=...
VITE_AZURE_CV_KEY=...
VITE_AZURE_VISION_LANGUAGE=en
```

Then run:

```bash
npm install
npm run dev
```

`npm run dev` starts both services:

- Frontend: Vite on port 5173
- Backend API: Express on port 8787

If Azure settings are missing, backend is unavailable, or the device is offline, the app automatically uses local OCR with Tesseract.

## GitHub Pages deployment

GitHub Pages can host the frontend, but it cannot run the Node/Express API from `server/index.mjs`. To use Azure OCR on GitHub Pages:

1. Deploy the API server to a backend host such as Azure App Service, Render, Railway, Fly.io, or another Node runtime.
2. Set backend env vars there: `VISION_ENDPOINT`, `VISION_KEY`, and optionally `VISION_LANGUAGE`.
3. Set `CORS_ALLOW_ORIGINS` on the backend to your Pages origin. For a site served from `https://your-user.github.io/photo_note/`, the correct origin is `https://your-user.github.io`.
4. In your GitHub repository settings, add an Actions variable named `VITE_API_BASE_URL` with your deployed API base URL, for example `https://photo-note-api.onrender.com`.
5. Push to `main` or rerun the Pages workflow. The frontend build will use that backend URL instead of local `/api` routes.

Without a separate backend host, GitHub Pages can only use the local Tesseract fallback because Azure keys must remain server-side.