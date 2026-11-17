# Market Agent Command Center

## Setup

Install dependencies with `pnpm install`, then start the development server with `pnpm dev`.

## Build and deployment

Run `pnpm run build` to create the Vite frontend in `dist/public` and bundle the server entry. Vercel serves the frontend from `dist/public` and routes `/api/*` requests to the Express function in `api/[...path].ts`.

## Audit report

See [`AUDIT_REPORT.md`](./AUDIT_REPORT.md) for the supplied audit notes.
