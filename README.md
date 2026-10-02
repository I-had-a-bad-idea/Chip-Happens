# Chip-Happens
A simple poker chip counting system for when you have cards but no chips.

Find the prod deployment here:
https://chip-happens.vercel.app/

## Locally

Get the environemnt keys for the Supabase DB and put them in `.env.local`.

Installing Dependencies
```bash
npm install .
```

Running:

```bash
npm run dev
```

## How to deploy to prod
1. Create a Supabase account + project
2. Get the Supabase URL and Publishable key (Settings -- API Keys)
3. In the Supabase SQL Editor, run [`supabase/setup.sql`](supabase/setup.sql). This recreates the empty game tables and installs the RPC functions used for all database reads and writes.

5. Create a Vercel project
6. Add your Supabase env variables to the project (`NEXT_PUBLIC_SUPABASE_URL` & `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`)