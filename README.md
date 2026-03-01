# JanJan Discord AI Bot

AI Discord bot using Groq (`openai/gpt-oss-120b`) that replies in friendly Tagalog beki-style when mentioned or when you reply to it.

## 1. Requirements

- Node.js 18+ (recommended)
- A Discord bot application and token
- A Groq API key

## 2. Setup

1. Open a terminal in this folder:

   ```bash
   cd "c:/Users/Aloof/Desktop/Andrei/JanJan"
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Environment variables:

   - The `.env` file is already created locally (and is gitignored).
   - If you ever need to recreate it, copy from `.env.example` and fill in:

   ```bash
   DISCORD_TOKEN=your_discord_bot_token_here
   GROQ_API_KEY=your_groq_api_key_here
   ```

## 3. Running the bot (local)

In the same folder:

```bash
npm start
```

If everything is correct, you should see something like:

```text
Logged in as YourBotName#1234
```

## 4. Running from cloud (Render Web Service, free)

Sa Render free (walang card), gamitin mo siya as **Web Service**:

1. Sa Render, click **New → Web Service** at piliin ang `JanJanBot` repo mo.
2. Branch: `main`
3. **Build Command**:

   ```bash
   npm install
   ```

4. **Start Command**:

   ```bash
   npm start
   ```

5. Sa Environment variables sa Render dashboard, idagdag:
   - `DISCORD_TOKEN`
   - `GROQ_API_KEY`

6. Hayaan mong Render mag-assign ng `PORT`. May maliit na HTTP server si JanJan sa `index.js` na nakikinig sa `process.env.PORT`, kaya magiging healthy yung Web Service habang tumatakbo rin ang Discord bot.

7. Pag “Live” na yung service, dapat online na rin ang bot sa Discord 24/7 (hangga’t hindi naka-sleep yung free instance).

## 5. How to use

- Invite the bot to your server with proper message content intent enabled.
- In the **Bot** settings in Discord Developer Portal, it is recommended to enable:
  - MESSAGE CONTENT INTENT
  - SERVER MEMBERS INTENT
  - PRESENCE INTENT
- The bot will answer when:
  - You **mention** it in a message (e.g. `@JanJan kamusta ka na teh?`)
  - You **reply** to one of its messages.
- Replies are:
  - Tagalog
  - Beki-style (pang-bading)
  - Friendly and wholesome (no NSFW/offensive content)

### Commands

- `j!status <note>` – admins only: set ng custom "bubble status" text mo sa server na 'to, lalabas sa `j!view`.
- `j!join` – papasok si JanJan sa voice channel mo kung saan ka naka-VC ngayon, para sama-sama sa call (kailangan may Connect/Speak perms si bot).
- `j!view @User` – embed/profile view ng member: malaking avatar picture + status + baklang chika.
- `j!help` – listahan ng commands at paano ka makipag-chikahan kay JanJan.

Enjoy the chikahan with your AI beki bot! 💅

