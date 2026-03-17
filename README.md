# photo_note

Photo Note extracts text from images.

## OCR behavior

- Selectable OCR models in the UI: Auto, Azure AI Vision, Azure Document Intelligence, and Tesseract.js
- Auto mode tries Azure AI Vision first, then Azure Document Intelligence, then falls back to Tesseract.js

## Google Docs export flow

After OCR is complete in the app:

1. User signs in with Google (OAuth 2.0 popup)
2. App creates a new Google Doc via Drive API
3. App inserts cleaned OCR text via Docs API

Required OAuth scopes:

- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/documents`

### Google OAuth setup

1. In Google Cloud Console, create an OAuth 2.0 Client ID of type **Web application**.
2. Add authorized JavaScript origins for your app, for example:
	- `http://localhost:5173`
	- `http://127.0.0.1:5173`
3. Copy `.env.example` to `.env` if you have not already.
4. Set:

```env
VITE_GOOGLE_CLIENT_ID=your-google-oauth-client-id.apps.googleusercontent.com

# Optional: create new docs in a specific Drive folder
VITE_GOOGLE_DRIVE_FOLDER_ID=
```

`VITE_GOOGLE_CLIENT_ID` is a frontend value and is expected to be public in the browser bundle.

## Secure backend architecture

- Browser uploads image bytes to `POST /api/ocr/azure` for Azure AI Vision or `POST /api/ocr/document-intelligence` for Azure Document Intelligence.
- Backend reads `VISION_*` and optional `DOCUMENT_INTELLIGENCE_*` env vars.
- Backend calls Azure Image Analysis 4.0 (`features=read`) and falls back to legacy read path if needed.
- Backend can also call Azure Document Intelligence `prebuilt-read` or another configured document model.
- Azure keys are never exposed to frontend code.

## Azure setup

1. Create an Azure AI Vision resource.
2. Optional: create an Azure Document Intelligence resource if you want the second cloud OCR model.
3. Copy `.env.example` to `.env`.
4. Fill in your values:

```env
VISION_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com
VISION_KEY=your-azure-vision-key
VISION_LANGUAGE=en

# Optional: Azure Document Intelligence
DOCUMENT_INTELLIGENCE_ENDPOINT=https://your-doc-intelligence-resource.cognitiveservices.azure.com
DOCUMENT_INTELLIGENCE_KEY=your-document-intelligence-key
DOCUMENT_INTELLIGENCE_MODEL=prebuilt-read

# Optional
API_PORT=8787
MAX_IMAGE_BYTES=10485760
CORS_ALLOW_ORIGINS=https://your-user.github.io
```

If you update `.env` while `npm run dev` is already running, restart the dev command so the API server reloads values.

If only one Azure service is configured, the model picker still works and the missing model will show as needing backend setup.

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
3. If you want Azure Document Intelligence in production too, also set `DOCUMENT_INTELLIGENCE_ENDPOINT`, `DOCUMENT_INTELLIGENCE_KEY`, and optionally `DOCUMENT_INTELLIGENCE_MODEL`.
4. Set `CORS_ALLOW_ORIGINS` on the backend to your Pages origin. For a site served from `https://your-user.github.io/photo_note/`, the correct origin is `https://your-user.github.io`.
5. In your GitHub repository settings, add these **Actions variables**:
	- `VITE_API_BASE_URL` with your deployed API base URL, for example `https://photo-note-api.onrender.com`
	- `VITE_GOOGLE_CLIENT_ID` with your Google OAuth Web Client ID
	- `VITE_GOOGLE_DRIVE_FOLDER_ID` (optional) if you want docs created in a specific Drive folder
6. In Google Cloud Console, add your Pages origin to authorized JavaScript origins for the same OAuth client:
	- `https://your-user.github.io`
7. Push to `main` or rerun the Pages workflow. The frontend build will include the Google client ID and backend URL.

Without a separate backend host, GitHub Pages can only use the local Tesseract fallback because Azure keys must remain server-side.