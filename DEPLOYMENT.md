# Deployment

## Required Environment Variables

Set these variables in Render and Vercel:

- `DATABASE_URL`: PostgreSQL connection string.
- `APP_STATE_KEY`: `sportshopfitness`.
- `SESSION_SECRET`: long random string for sessions.
- `NODE_ENV`: `production`.

Do not commit `.env`.

## Render

Use the included `render.yaml` as a Blueprint or create a Web Service manually:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/healthz`

Add `DATABASE_URL` in the Render dashboard because `render.yaml` intentionally marks it as a secret.

## Vercel

The included `vercel.json` routes requests to `api/index.js`, which initializes the Express app as a Vercel Function.

Add the same environment variables in Project Settings -> Environment Variables.

## Notes

Uploaded files are stored on the local filesystem. That is fine for demos, but Render and Vercel filesystems are ephemeral. For production uploads, use Supabase Storage or S3-compatible storage.
