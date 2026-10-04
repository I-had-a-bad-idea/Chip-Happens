# Chip-Happens
A simple poker chip counting system for when you have cards but no chips.

Find the prod deployment here:
https://chip-happens.vercel.app/

## Overview
- [Chip-Happens](#chip-happens)
  - [Overview](#overview)
  - [Idea](#idea)
  - [Screenshots](#screenshots)
  - [Using](#using)
  - [Running](#running)
    - [Requirements](#requirements)
      - [Settign up the DB](#settign-up-the-db)
    - [Locally](#locally)
    - [How to deploy to prod (Vercel)](#how-to-deploy-to-prod-vercel)
  - [Important notes/ limitations](#important-notes-limitations)
    - [Client trust](#client-trust)
    - [DB security](#db-security)
    - [Poker rules](#poker-rules)
  - [Contributing](#contributing)


## Idea

This website has been made, because some friends and I often ran into the problem of not having any chips, but wanting to play Poker with real cards.       
Since most websites either make you play with digital cards or have a pot where anyone can put chips in/ take them out at any time, I decided to make my own.       
This website allows you to join a shared game, that only tracks chips. It allows/forces you to use your own cards. And it doesnt allow anyone to put/take arbitary amounts of money into/from the pot.

## Screenshots

| Home | Join Game | Waiting for Players |
|:---:|:---:|:---:|
| <img src="images/Home%20page.png" width="300"> | <img src="images/Join%20game%20page.png" width="300"> | <img src="images/Game%20page%20waiting.png" width="300"> |

| Playing | Winner Selection |
|:---:|:---:|
| <img src="images/Game%20page%20playing.png" width="300"> | <img src="images/Game%20page%20winner%20selection.png" width="300"> | 


## Using
It should be pretty self-explanatory.       
Host is responsible for winner selection. To do ties, just select multiple people.      

## Running

### Requirements
You will need a Supabase project and Node.js

#### Settign up the DB
1. Create a Supabase account + project
2. Get the Supabase URL and Publishable key (Settings -- API Keys)
3. In the Supabase SQL Editor, run [`supabase/setup.sql`](supabase/setup.sql). This recreates the empty game tables and installs the RPC functions used for all database reads and writes.

### Locally

Get the environemnt keys for the Supabase DB and put them in `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

Installing Dependencies
```bash
npm install .
```

Running:

```bash
npm run dev
```

### How to deploy to prod (Vercel)
1. Setup the Supabase DB (see above)
2. Create a Vercel project (should be NextJS)
3. Add your Supabase env variables to the project (`NEXT_PUBLIC_SUPABASE_URL` & `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`)
4. Deploy

## Important notes/ limitations

Since this website was made to play with friends it is not espicially secure.

### Client trust
It **trusts the clients**, meaning if someone wanted, he could just rewrite his client to cheat. This is not a problem for us, since we are all to lazy to do that, but be aware, that it is possible.

### DB security
Also I didn't put to much focus on securing the DB, so anyone is probably able to change the values (which shouldnt be a problem (see above), but be warned).

### Poker rules
There is no enforcement of a minimum raise size (raises can be as low as just 1 chip).      
Raising also always reopens action (even if it maybe shouldnt according to the official rules).     
For heads-up poker (2 players) the blinds are switched (dealer is big blind), which is because I am too lazy to fix it and we never play with only 2 players.

## Contributing
This project is just a small tool for playing Poker with friends, but improvements are welcome.

Just open an issue/PR if you find a bug, have an idea or want to improve it.