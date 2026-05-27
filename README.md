<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/9d0cd470-34ad-404d-85ab-de1f64992445

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the required environment variables in [.env.local](.env.local):
   `MONGODB_URI`, `GEMINI_API_KEY`, and optionally `MONGODB_DB_NAME=rantuChat`
3. Run the app:
   `npm run dev`

The application now persists all user, chat, log, and WhatsApp session data exclusively in MongoDB.
